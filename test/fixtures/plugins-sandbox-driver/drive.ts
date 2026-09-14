// Out-of-process driver for PluginHost failure scenarios. A runner-side crash (an uncaught exception
// or an unhandled EPIPE) would take down the vitest worker, so these run in a plain node child and
// report what happened as one JSON line prefixed with RESULT:.
import path from "node:path";
import { PluginHost, type Capabilities } from "../../../src/plugins/client.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const scenario = process.argv[2];
const uncaught: string[] = [];
process.on("uncaughtException", (e) => { uncaught.push(String((e as Error)?.message ?? e)); });
process.on("unhandledRejection", (e) => { uncaught.push(`rejection:${String((e as Error)?.message ?? e)}`); });

const session = { sessionId: "sess_d", agentId: "agent_d", workspaceId: "ws_d" };
const store = new Map<string, unknown>();
const caps = new Proxy({} as Capabilities, {
  get: (_t, k) => {
    if (k === "storeGet") return async (key: string) => store.get(key) ?? null;
    if (k === "storeSet") return async (key: string, _s: string, v: unknown) => { store.set(key, v); };
    if (k === "log") return () => {};
    return async () => null;
  },
});
const race = <T>(p: Promise<T>, ms: number) => Promise.race([p.then((v) => ({ ok: v }), (e) => ({ err: String(e?.message ?? e) })), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pkg = { dir: path.join(ROOT, "test/fixtures/plugins-sandbox-merge-a"), source: "a", name: "a", kind: "pma" as const, plugins: ["index.ts"], skills: [], prompts: [] };
const host = await PluginHost.start([pkg], { agentId: "agent_d", repoRoot: ROOT });
host.attach(session, caps);
const tool = (name: string) => host.agentTools(session).find((t) => t.name === name)!;
const out: Record<string, unknown> = {};

if (scenario === "console") {
  out.first = await race(tool("t_console").execute("1", {}), 3000);
  out.after = await race(tool("t_dup").execute("2", {}), 3000);
} else if (scenario === "exit") {
  out.inflight = await race(tool("t_exit").execute("1", {}), 3000);
  await sleep(100);
  out.emit = await race(host.emit(session, { type: "turn_end", turn: 1 }), 2000);
  out.tool = await race(tool("t_dup").execute("2", {}), 2000);
} else if (scenario === "crash-async") {
  out.first = await race(tool("t_crash_async").execute("1", {}), 3000);
  await sleep(500);
  out.emit = await race(host.emit(session, { type: "turn_end", turn: 1 }), 2000);
}
await sleep(300);
out.uncaught = uncaught;
process.stdout.write(`RESULT:${JSON.stringify(out)}\n`);
host.stop();
setTimeout(() => process.exit(0), 50);
