import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { repos } from "../../infra/db.ts";
import { appendIn, listEvents, withSession } from "../../infra/events.ts";
import { publish, publishInterrupt, pushSteer, subscribe } from "../../infra/pubsub.ts";
import { enqueueRun } from "../../infra/queue.ts";
import type { SessionEvent, SessionId, SessionResource, UserEventInput } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";

export function validateUserEvents(events: unknown): UserEventInput[] {
  if (!Array.isArray(events) || events.length === 0) throw invalid("events must be a non-empty array");
  for (const e of events) {
    if (e?.type === "user.interrupt") continue;
    if (e?.type === "user.message" && Array.isArray(e.content) && e.content.every((b: any) => b?.type === "text" && typeof b.text === "string")) continue;
    throw invalid("each event must be {type:'user.message',content:[{type:'text',text}]} or {type:'user.interrupt'}");
  }
  return events as UserEventInput[];
}

/**
 * Append user events and kick the runner / steer the live loop. The steer-vs-enqueue decision is
 * taken under the session row lock, so it cannot interleave with the runner's running/idle flip.
 * Shared with session creation.
 */
export async function sendUserEvents(session: SessionResource, inputs: UserEventInput[]): Promise<SessionEvent[]> {
  const { appended, status } = await withSession(session.id, async (c, s) => ({ appended: await appendIn(c, session.id, inputs), status: s.status }));
  for (const event of appended) await publish({ type: "event", event });
  const messages = appended.filter((e) => e.payload.type === "user.message");
  if (status === "running") {
    // The runner drains these between turns; anything it never pops is caught by finishRun (seq > consumed).
    for (const e of messages) if (e.payload.type === "user.message") await pushSteer(session.id, { seq: e.seq, content: e.payload.content });
  } else if (status === "idle" && messages.length > 0) {
    await enqueueRun({ session_id: session.id, trigger_seq: messages[messages.length - 1]!.seq });
  }
  if (appended.some((e) => e.type === "user.interrupt")) await publishInterrupt(session.id);
  return appended;
}

async function getSession(id: SessionId): Promise<SessionResource> {
  const s = await repos.sessions.get(id);
  if (!s) throw notFound("session", id);
  return s;
}

const REPLAY_PAGE = 1000;

export const events = new Hono()
  .post("/", async (c) => {
    const session = await getSession(c.req.param("id")!);
    const body = await readJson<{ events?: unknown }>(c);
    return c.json({ events: await sendUserEvents(session, validateUserEvents(body.events)) });
  })
  .get("/", async (c) => {
    const session = await getSession(c.req.param("id")!);
    const since = Number(c.req.query("since") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
    const data = await listEvents(session.id, { since, limit: limit + 1 });
    return c.json({ data: data.slice(0, limit), has_more: data.length > limit });
  })
  .get("/stream", async (c) => {
    const session = await getSession(c.req.param("id")!);
    let last = Number(c.req.query("since") ?? 0);
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      let done = false;
      let unsub = () => {};
      const finish = () => {
        done = true;
        unsub();
        void stream.close();
      };
      stream.onAbort(finish);

      // Every event goes through one serialized chain: replay first, then live deltas in arrival
      // order. `last` is the only cursor; a gap (seq > last+1) is filled from the store, so an
      // event published out of order (API and runner publish independently) is neither lost nor
      // delivered twice.
      const sendEvent = async (ev: SessionEvent) => {
        if (done || ev.seq <= last) return;
        last = ev.seq;
        await send(ev.type, ev);
        if (ev.type === "session.status_terminated") finish();
      };
      /** Send stored events with last < seq < upTo, paged. */
      const replay = async (upTo = Infinity) => {
        for (;;) {
          if (done || last >= upTo - 1) return;
          const page = await listEvents(session.id, { since: last, limit: Math.min(REPLAY_PAGE, upTo - 1 - last) });
          for (const ev of page) await sendEvent(ev);
          if (page.length < REPLAY_PAGE) return;
        }
      };
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (fn: () => Promise<void>) => {
        chain = chain.then(fn).catch((e) => console.error("[sse] send failed", e));
      };

      unsub = await subscribe(session.id, (delta) => {
        if (done) return;
        if (delta.type === "agent.message_delta") {
          void send("agent.message_delta", delta);
          return;
        }
        enqueue(async () => {
          const ev = delta.event;
          if (ev.seq > last + 1) await replay(ev.seq); // fill the gap from the store
          await sendEvent(ev);
        });
      });
      enqueue(() => replay());
      await chain;
      while (!done) {
        await stream.sleep(15000);
        if (!done) await stream.write(": heartbeat\n\n");
      }
    });
  });
