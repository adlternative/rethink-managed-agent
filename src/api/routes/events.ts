import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { repos } from "../../infra/db.ts";
import { appendEvents, listEvents } from "../../infra/events.ts";
import { publishInterrupt, pushSteer, subscribe } from "../../infra/pubsub.ts";
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

/** Append user events and kick the runner / steer the live loop. Shared with session creation. */
export async function sendUserEvents(session: SessionResource, inputs: UserEventInput[]): Promise<SessionEvent[]> {
  const appended = await appendEvents(session.id, inputs);
  const messages = appended.filter((e) => e.payload.type === "user.message");
  if (session.status === "running") {
    for (const e of messages) await pushSteer(session.id, { ...(e.payload as UserEventInput), seq: e.seq });
  } else if (session.status === "idle" && messages.length > 0) {
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

      // subscribe first so nothing is lost between replay and live; dedupe by seq
      unsub = await subscribe(session.id, (delta) => {
        if (done) return;
        if (delta.type === "agent.message_delta") {
          void send("agent.message_delta", delta);
          return;
        }
        const ev = delta.event;
        if (ev.seq <= last) return;
        last = ev.seq;
        void send(ev.type, ev);
        if (ev.type === "session.status_terminated") finish();
      });
      const replay = await listEvents(session.id, { since: last, limit: 10000 });
      for (const ev of replay) {
        if (ev.seq <= last) continue;
        last = ev.seq;
        await send(ev.type, ev);
        if (ev.type === "session.status_terminated") return finish();
      }
      while (!done) {
        await stream.sleep(15000);
        if (!done) await stream.write(": heartbeat\n\n");
      }
    });
  });
