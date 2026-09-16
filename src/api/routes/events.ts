import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { repos } from "../../infra/db.ts";
import { appendIn, listEvents, withSession } from "../../infra/events.ts";
import { publish, publishInterrupt, publishToolResult, pushSteer, subscribe } from "../../infra/pubsub.ts";
import { enqueueRun } from "../../infra/queue.ts";
import type { SessionEvent, SessionId, SessionResource, UserEventInput } from "../../shared/types.ts";
import { confirmationCallId } from "../../shared/types.ts";
import { invalid, notFound, queryInt, readJson } from "../errors.ts";
import { scope } from "../auth.ts";
import type { Context } from "hono";

export function validateUserEvents(events: unknown): UserEventInput[] {
  if (!Array.isArray(events) || events.length === 0) throw invalid("events must be a non-empty array");
  for (const e of events) {
    if (e?.type === "user.interrupt") continue;
    if (e?.type === "user.tool_confirmation") {
      if (typeof e.tool_use_id !== "string" || !e.tool_use_id) throw invalid("user.tool_confirmation requires a tool_use_id (the held call id)");
      if (e.result !== "allow" && e.result !== "deny") throw invalid("user.tool_confirmation.result must be 'allow' or 'deny'");
      if (e.deny_message !== undefined && (typeof e.deny_message !== "string" || e.result !== "deny")) throw invalid("deny_message is a string, and only goes with result 'deny'");
      continue;
    }
    if (e?.type === "tool_result") {
      if (typeof e.tool_use_id !== "string" || !e.tool_use_id) throw invalid("tool_result requires a tool_use_id (the call id)");
      if (!Array.isArray(e.content) || e.content.length === 0) throw invalid("tool_result requires a non-empty content array");
      e.is_error = !!e.is_error;
      continue;
    }
    if (e?.type === "user.message" && Array.isArray(e.content) && e.content.length > 0) {
      e.content = e.content.map((b: any) => {
        if (b?.type === "text" && typeof b.text === "string") return b;
        if (b?.type === "image" || b?.type === "document") {
          const id = b.source?.type === "file" ? b.source.file_id : b.file_id; // MA form, or the short form
          if (typeof id === "string" && /^file_[A-Za-z0-9_-]+$/.test(id)) return { type: b.type, source: { type: "file", file_id: id } };
        }
        throw invalid("content blocks must be {type:'text',text} or {type:'image'|'document', source:{type:'file', file_id}}");
      });
      continue;
    }
    throw invalid("each event must be {type:'user.message', content:[...]}, {type:'user.interrupt'}, {type:'tool_result', ...} or {type:'user.tool_confirmation', ...}");
  }
  return events as UserEventInput[];
}

/**
 * Append user events and kick the runner / steer the live loop. The steer-vs-enqueue decision is
 * taken under the session row lock, so it cannot interleave with the runner's running/idle flip.
 * Shared with session creation.
 */
export async function sendUserEvents(session: SessionResource, inputs: UserEventInput[]): Promise<SessionEvent[]> {
  // tool_result is a control signal for an in-flight client tool, not a persisted user event: deliver
  // it on the per-call channel; the running loop records the real agent.tool_result when the tool returns.
  const toolResults = inputs.filter((i): i is Extract<UserEventInput, { type: "tool_result" }> => i.type === "tool_result");
  // a confirmation is both a control signal (it releases the held call) and a fact worth keeping in the log
  const confirmations = inputs.filter((i): i is Extract<UserEventInput, { type: "user.tool_confirmation" }> => i.type === "user.tool_confirmation");
  const rest = inputs.filter((i) => i.type !== "tool_result");
  const { appended, status } = await withSession(session.id, async (c, s) => {
    // a terminated session never runs again: appending would silently drop the message
    if (s.status === "terminated") throw invalid(`session ${session.id} is terminated`);
    return { appended: rest.length ? await appendIn(c, session.id, rest) : [], status: s.status };
  });
  for (const event of appended) await publish({ type: "event", event });
  for (const tr of toolResults) await publishToolResult(session.id, tr.tool_use_id, { content: tr.content, isError: !!tr.is_error });
  for (const cf of confirmations) {
    await publishToolResult(session.id, confirmationCallId(cf.tool_use_id), { content: [{ type: "text", text: JSON.stringify({ result: cf.result, deny_message: cf.deny_message }) }], isError: false });
  }
  const messages = appended.filter((e) => e.payload.type === "user.message");
  if (status === "running") {
    // The runner drains these between turns; anything it never pops is caught by finishRun (seq > consumed).
    for (const e of messages) if (e.payload.type === "user.message") await pushSteer(session.id, { seq: e.seq, content: e.payload.content });
  } else if (status === "idle" && messages.length > 0) {
    await enqueueRun({ session_id: session.id, trigger_seq: messages[messages.length - 1]!.seq, owner_id: session.owner_id });
  }
  if (appended.some((e) => e.type === "user.interrupt")) await publishInterrupt(session.id);
  return appended;
}

async function getSession(c: Context): Promise<SessionResource> {
  const id = c.req.param("id")! as SessionId;
  const s = await repos.sessions.get(id, scope(c));
  if (!s) throw notFound("session", id);
  return s;
}

const REPLAY_PAGE = 1000;

export const events = new Hono()
  .post("/", async (c) => {
    const session = await getSession(c);
    const body = await readJson<{ events?: unknown }>(c);
    return c.json({ events: await sendUserEvents(session, validateUserEvents(body.events)) });
  })
  .get("/", async (c) => {
    const session = await getSession(c);
    const since = queryInt(c, "since", 0, 0);
    const limit = Math.min(queryInt(c, "limit", 100, 1), 1000);
    const data = await listEvents(session.id, { since, limit: limit + 1 });
    return c.json({ data: data.slice(0, limit), has_more: data.length > limit });
  })
  .get("/stream", async (c) => {
    const session = await getSession(c);
    let last = queryInt(c, "since", 0, 0);
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      let done = false;
      let unsub = () => {};
      const finish = () => {
        if (done) return;
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

      const off = await subscribe(session.id, (delta) => {
        if (done) return;
        if (delta.type !== "event") {
          void send(delta.type, delta);
          return;
        }
        enqueue(async () => {
          const ev = delta.event;
          if (ev.seq > last + 1) await replay(ev.seq); // fill the gap from the store
          await sendEvent(ev);
        });
      });
      if (done) return off(); // the client left while subscribe() was pending
      unsub = off;
      enqueue(() => replay());
      await chain;
      // since >= the terminated event's seq: replay shows nothing and no live event will ever come
      if (!done && (await repos.sessions.get(session.id, scope(c)))?.status === "terminated") finish();
      while (!done) {
        await stream.sleep(15000);
        if (!done) await stream.write(": heartbeat\n\n");
      }
    });
  });
