import { apiGet, interrupt, sendMessage, streamEvents, textOf, type SessionEvent } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `session subcommand:
  events <id> [--since <seq>] [--json]
  send <id> <text...> [--wait]        append a user message; --wait streams until the turn ends
  stream <id> [--since <seq>]         follow the event stream
  interrupt <id>
  export <id> [--json] > file`;

function printEvent(e: SessionEvent): void {
  const p = e.payload;
  switch (e.type) {
    case "user.message": return console.log(`\n> ${textOf(p.content)}`);
    case "agent.message": return console.log(`\n${textOf(p.content)}`);
    case "agent.tool_use": return console.log(`\n▪ ${p.name}(${JSON.stringify(p.input).slice(0, 200)})`);
    case "agent.tool_result": return console.log(`  ${p.is_error ? "✗" : "└"} ${textOf(p.content).slice(0, 2000).replace(/\n/g, "\n    ")}`);
    case "agent.message_delta": return;
    default: return console.log(`\n[${e.type}] ${JSON.stringify(p)}`);
  }
}

export async function cmdSession(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub, id, ...rest] = positional;
  if (!id) die(USAGE);
  const since = Number(str(flags, "since") ?? 0);
  switch (sub) {
    case "events": {
      const { data } = (await apiGet(`/sessions/${id}/events?since=${since}&limit=1000`)) as { data: SessionEvent[] };
      if (flags.json) return printJson(data);
      table([["SEQ", "TYPE", "SUMMARY"], ...data.map((e) => [String(e.seq), e.type, summarize(e)])]);
      return;
    }
    case "stream":
      await streamEvents(id, since, (item) => { if (item.type === "agent.message_delta") process.stdout.write(item.text); else printEvent(item.event); });
      return;
    case "send": {
      const text = rest.join(" ");
      if (!text) die("usage: pma session send <id> <text...> [--wait]");
      const { events } = await sendMessage(id, text);
      if (!flags.wait) return printJson(events);
      let streamingText = false;
      await streamEvents(id, events[events.length - 1]!.seq, (item) => {
        if (item.type === "agent.message_delta") { process.stdout.write(item.text); streamingText = true; return; }
        if (item.event.type === "agent.message") { if (streamingText) { console.log(); streamingText = false; } return; }
        printEvent(item.event);
        return item.event.type === "session.status_idle" || item.event.type === "session.status_terminated";
      });
      return;
    }
    case "interrupt":
      await interrupt(id);
      return console.log("✓ interrupt sent");
    case "export": {
      const { data } = (await apiGet(`/sessions/${id}/events?limit=100000`)) as { data: SessionEvent[] };
      if (flags.json) return printJson(data);
      for (const e of data) {
        if (e.type === "user.message") console.log(`## user\n${textOf(e.payload.content)}\n`);
        else if (e.type === "agent.message") console.log(`## agent\n${textOf(e.payload.content)}\n`);
        else if (e.type === "agent.tool_use") console.log(`▪ ${e.payload.name}(${JSON.stringify(e.payload.input)})`);
        else if (e.type === "agent.tool_result") console.log("```\n" + textOf(e.payload.content) + "\n```\n");
      }
      return;
    }
    default:
      die(USAGE);
  }
}

function summarize(e: SessionEvent): string {
  const p = e.payload;
  const s = e.type === "user.message" || e.type === "agent.message" || e.type === "agent.tool_result" ? textOf(p.content)
    : e.type === "agent.tool_use" ? `${p.name} ${JSON.stringify(p.input)}`
    : e.type === "session.status_idle" ? p.stop_reason
    : e.type === "sandbox.acquired" ? `${p.provider} ${p.sandbox_id}${p.env ? ` [${p.env}]` : ""}`
    : e.type === "workspace.captured" ? `${p.workspace_id ?? ""}${p.env ? ` [${p.env}]` : ""}`
    : e.type === "session.thread_created" ? `${p.child_session_id} [${p.env}] ${p.task}`
    : e.type === "agent.thread_message_received" ? `${p.child_session_id} (${p.stop_reason}) ${textOf(p.content)}`
    : e.type === "session.error" ? `${p.error.type}: ${p.error.message}` : "";
  return s.replace(/\s+/g, " ").slice(0, 80);
}
