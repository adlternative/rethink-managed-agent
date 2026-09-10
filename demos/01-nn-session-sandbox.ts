/**
 * CLAIM: sessions and sandboxes are N:N, not 1:1.
 * One session spans several sandboxes at once; and a workspace's state outlives any single
 * sandbox, so a later session picks it up. Heavy products pin exactly one sandbox to one session
 * for that session's whole life — you cannot fan a session across environments, and when the
 * session ends its sandbox (and everything in it) is gone.
 */
import { LocalProvider } from "../src/sandbox/local.ts";
import { SandboxManager } from "../src/sandbox/manager.ts";
import { memStore, scratchRoots, run, title, step, note, contrast, expect, dumpRows, done } from "./lib.ts";

await scratchRoots();
const store = memStore();
const mgr = new SandboxManager({ local: new LocalProvider() } as never, store);

title("N:N — one session, many sandboxes; one workspace, many sessions");

step("Session S1 attaches TWO environments (code + a scratch build env).");
const code = await mgr.acquire("local", { workspaceId: "S1-code", containerKey: "S1/code", workspaceRef: { kind: "empty" }, affinity: "S1-code" });
const build = await mgr.acquire("local", { workspaceId: "S1-build", containerKey: "S1/build", workspaceRef: { kind: "empty" }, affinity: "S1-build" });
await code.sandbox.writeFile("app.py", new TextEncoder().encode("print('hi')"));
await build.sandbox.writeFile("Dockerfile", new TextEncoder().encode("FROM scratch"));
note(`code  sandbox=${code.sandbox.id} workdir=${code.sandbox.workdir}`);
note(`build sandbox=${build.sandbox.id} workdir=${build.sandbox.workdir}`);
expect(code.sandbox.id !== build.sandbox.id, "one session is driving two live sandboxes at once", "expected two distinct sandboxes");
contrast("one session is welded to one sandbox; a second environment is impossible.");

step("S1 finishes. Capture the code workspace, then release + destroy the sandboxes.");
const ref = await mgr.capture(code.sandbox, { kind: "empty" });
await code.release(); await build.release();
await mgr.destroy(code.sandbox.id); await mgr.destroy(build.sandbox.id);
note(`captured workspace ref: ${JSON.stringify(ref)}`);
expect((await mgr.list()).length === 0, "both sandboxes are gone; the workspace lives on as a ref", "sandboxes should be destroyed");

step("A DIFFERENT session S2 opens a fresh sandbox from S1's captured workspace.");
const s2 = await mgr.acquire("local", { workspaceId: "S2", containerKey: "S2/code", workspaceRef: ref, affinity: "S2" });
const back = await run(s2.sandbox.exec("cat app.py"));
note(`S2 sandbox=${s2.sandbox.id} reads app.py -> ${JSON.stringify(back.out)}`);
expect(back.out === "print('hi')", "S2 continues S1's work in a brand-new sandbox", "S2 did not see S1's file");
expect(s2.sandbox.id !== code.sandbox.id, "it is a genuinely different sandbox, same workspace lineage", "expected a new sandbox id");
contrast("S1's sandbox died with S1; its work is unreachable from any other session.");
await s2.release();

dumpRows(store.rows);
done();
