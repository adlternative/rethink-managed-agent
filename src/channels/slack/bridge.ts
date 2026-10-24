import { listEvents } from "../../infra/events.ts";
import { subscribe } from "../../infra/pubsub.ts";
import { repos } from "../../infra/db.ts";
import { log } from "../../infra/log.ts";
import type { SessionEvent, SessionResource } from "../../shared/types.ts";
import { requiredActions, clientToolNames } from "../../api/routes/compat/required-actions.ts";
import { textOfBlocks, type SlackClient } from "./client.ts";

/** One live outbound bridge per session (avoid duplicate posters when Slack retries / multi-message). */
const active = new Map<string, AbortController>();

export interface BridgeTarget {
  channel: string;
  thread_ts: string;
}

/**
 * Watch a session's event stream and mirror agent replies / confirmation asks into a Slack thread.
 * Idempotent per session: a second call joins the same bridge. Stops after the session returns to
 * idle with no pending confirmation or client-tool action (or on abort / error).
 */
export function startSlackBridge(sessionId: string, client: SlackClient, target: BridgeTarget): void {
  if (active.has(sessionId)) return;
  const ac = new AbortController();
  active.set(sessionId, ac);
  void runBridge(sessionId, client, target, ac.signal).finally(() => {
    if (active.get(sessionId) === ac) active.delete(sessionId);
  });
}

async function runBridge(sessionId: string, client: SlackClient, target: BridgeTarget, signal: AbortSignal): Promise<void> {
  let last = 0;
  const postedConfirm = new Set<string>();
  const postedClient = new Set<string>();
  const streamed = new Set<string>(); // stream_ids already previewed as deltas — skip duplicate final message? we post finals only

  const handle = async (ev: SessionEvent, session: SessionResource | null) => {
    if (signal.aborted || ev.seq <= last) return;
    last = ev.seq;
    const p = ev.payload;
    if (p.type === "agent.message") {
      const text = textOfBlocks(p.content);
      if (text) await client.postMessage({ channel: target.channel, thread_ts: target.thread_ts, text });
      return;
    }
    if (p.type === "agent.tool_confirmation_required") {
      if (postedConfirm.has(p.tool_use_id)) return;
      postedConfirm.add(p.tool_use_id);
      const label = p.mcp_server ? `${p.mcp_server}/${p.name}` : p.name;
      await client.postMessage({
        channel: target.channel,
        thread_ts: target.thread_ts,
        text: `Approve tool \`${label}\`?`,
        blocks: confirmationBlocks(p.tool_use_id, label),
      });
      return;
    }
    if (p.type === "agent.tool_use" && session) {
      const names = new Set(clientToolNames(session));
      if (!names.has(p.name) || postedClient.has(p.tool_use_id)) return;
      postedClient.add(p.tool_use_id);
      const args = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {});
      await client.postMessage({
        channel: target.channel,
        thread_ts: target.thread_ts,
        text: `Client tool \`${p.name}\` needs a result. Reply in this thread:\n\`/answer ${p.tool_use_id} <json or text>\``,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Client tool* \`${p.name}\` needs a result.\nArgs: \`${truncate(args, 500)}\`\nReply:\n\`/answer ${p.tool_use_id} <json or text>\``,
            },
          },
        ],
      });
      return;
    }
    if (p.type === "session.error") {
      const msg = p.error.message ?? "session error";
      await client.postMessage({ channel: target.channel, thread_ts: target.thread_ts, text: `Error: ${msg}` });
    }
  };

  try {
    // Replay anything already in the log (e.g. bridge started after a fast model reply).
    const session = await repos.sessions.get(sessionId);
    for (const ev of await listEvents(sessionId, { since: 0, limit: 5000 })) {
      await handle(ev, session);
    }

    const unsub = await subscribe(sessionId, (delta) => {
      if (signal.aborted) return;
      void (async () => {
        if (delta.type === "event") {
          const s = await repos.sessions.get(sessionId);
          await handle(delta.event, s);
          if (delta.event.payload.type === "session.status_idle") {
            const events = await listEvents(sessionId, { since: 0, limit: 5000 });
            const pendingConfirm = events.some((e) => e.payload.type === "agent.tool_confirmation_required" &&
              !events.some((x) => x.payload.type === "user.tool_confirmation" && (x.payload as { tool_use_id?: string }).tool_use_id === (e.payload as { tool_use_id: string }).tool_use_id));
            const pendingClient = s ? requiredActions(events, clientToolNames(s)).length > 0 : false;
            if (!pendingConfirm && !pendingClient) {
              // Allow a brief settle, then stop watching this turn.
              setTimeout(() => { if (!signal.aborted) active.get(sessionId)?.abort(); }, 250);
            }
          }
        }
        // Live deltas are optional noise in Slack; finals via agent.message cover the reply.
        void streamed;
      })();
    });
    signal.addEventListener("abort", () => unsub(), { once: true });

    // Cap bridge lifetime so a stuck session does not hold a subscription forever.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 30 * 60_000);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    unsub();
  } catch (e) {
    log.warn("slack.bridge", { session_id: sessionId, err: (e as Error).message });
  }
}

function confirmationBlocks(toolUseId: string, label: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `Approve tool \`${label}\`?` } },
    {
      type: "actions",
      block_id: `confirm:${toolUseId}`,
      elements: [
        { type: "button", action_id: "tool_confirm_allow", text: { type: "plain_text", text: "Allow" }, style: "primary", value: toolUseId },
        { type: "button", action_id: "tool_confirm_deny", text: { type: "plain_text", text: "Deny" }, style: "danger", value: toolUseId },
      ],
    },
  ];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Test helper: clear active bridges between cases. */
export function resetSlackBridges(): void {
  for (const ac of active.values()) ac.abort();
  active.clear();
}
