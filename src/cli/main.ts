#!/usr/bin/env node
// Tiny fetch-based CLI. Usage: pi-cli <command> [args] [--flag value]
const BASE = process.env.PI_API ?? "http://localhost:8080";

function parse(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

function need(flags: Record<string, string | true>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string") throw new Error(`--${name} is required`);
  return v;
}
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

/** Stream SSE; calls onEvent(type, data) for each; resolves when stream ends or onEvent returns true. */
async function stream(sessionId: string, since: number, onEvent: (type: string, data: any) => boolean | void): Promise<void> {
  const res = await fetch(`${BASE}/v1/sessions/${sessionId}/events/stream?since=${since}`);
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let type = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      if (onEvent(type, JSON.parse(data))) {
        await reader.cancel();
        return;
      }
    }
  }
}

function printEvent(type: string, data: any): void {
  if (type === "agent.message_delta") return process.stdout.write(data.text), undefined;
  const p = data.payload ?? data;
  switch (type) {
    case "agent.message":
      return console.log(`\n[agent] ${p.content.map((b: any) => b.text).join("")}`);
    case "agent.tool_use":
      return console.log(`\n[tool_use ${p.name}] ${JSON.stringify(p.input)}`);
    case "agent.tool_result":
      return console.log(`[tool_result${p.is_error ? " ERROR" : ""}] ${p.content.map((b: any) => b.text).join("").slice(0, 2000)}`);
    default:
      return console.log(`\n[${type}] ${JSON.stringify(p)}`);
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parse(process.argv.slice(2));
  const [cmd, sub, ...rest] = positional;
  if (cmd === "events") {
    if (!sub) throw new Error("usage: events <session>");
    return print(await api("GET", `/v1/sessions/${sub}/events?limit=1000`));
  }
  if (cmd === "stream") {
    if (!sub) throw new Error("usage: stream <session>");
    return stream(sub, 0, printEvent);
  }
  switch (`${cmd} ${sub ?? ""}`.trim()) {
    case "agent create":
      return print(await api("POST", "/v1/agents", {
        name: need(flags, "name"),
        model: { provider: need(flags, "provider"), id: need(flags, "model") },
        system: typeof flags.system === "string" ? flags.system : undefined,
      }));
    case "env create":
      return print(await api("POST", "/v1/environments", {
        name: need(flags, "name"),
        provider: need(flags, "provider"),
        image: typeof flags.image === "string" ? flags.image : undefined,
        workspace: typeof flags.git === "string" ? { kind: "git", remote: flags.git } : { kind: "empty" },
      }));
    case "session create":
      return print(await api("POST", "/v1/sessions", {
        agent: need(flags, "agent"),
        environment_id: need(flags, "env"),
        workspace_id: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      }));
  }
  if (cmd === "send") {
    const text = rest.join(" ");
    if (!sub || !text) throw new Error("usage: send <session> <text> [--wait]");
    const { events } = await api("POST", `/v1/sessions/${sub}/events`, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
    if (!flags.wait) return print(events);
    const since = events[events.length - 1].seq;
    return stream(sub, since, (type, data) => {
      printEvent(type, data);
      return type === "session.status_idle" || type === "session.status_terminated";
    });
  }
  console.error(`usage:
  agent create --name N --provider P --model M [--system S]
  env create --name N --provider local|docker [--image I] [--git URL]
  session create --agent A --env E [--workspace-id W]
  send <session> <text> [--wait]
  stream <session>
  events <session>
  (API base: PI_API, default http://localhost:8080)`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
