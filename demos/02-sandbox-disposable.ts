/**
 * CLAIM: the sandbox is disposable; the session (events) + workspace (ref) are the truth.
 * We nuke a running sandbox mid-life — as if the cloud reclaimed it — and rebuild the exact
 * working state in a fresh sandbox from the captured ref. Nothing is lost. In a session-bound
 * product, losing the sandbox means losing the session's live state.
 */
import { LocalProvider } from "../src/sandbox/local.ts";
import { SandboxManager } from "../src/sandbox/manager.ts";
import { memStore, scratchRoots, run, title, step, note, contrast, expect, dumpRows, done } from "./lib.ts";

await scratchRoots();
const store = memStore();
const mgr = new SandboxManager({ local: new LocalProvider() } as never, store);

title("Disposable sandbox — session state survives losing it");

step("A session does real work in its sandbox.");
const s1 = await mgr.acquire("local", { workspaceId: "W", containerKey: "S/main", workspaceRef: { kind: "empty" }, affinity: "W" });
await run(s1.sandbox.exec("mkdir -p src && echo 'v1' > src/build.txt && echo done > progress.log"));
note(`sandbox #1 = ${s1.sandbox.id}`);

step("Checkpoint the workspace (this is what the harness does each turn), then the sandbox is LOST.");
const ref = await mgr.capture(s1.sandbox, { kind: "empty" });
await s1.release();
await mgr.destroy(s1.sandbox.id); // simulate the cloud reclaiming the box
expect((await mgr.get(s1.sandbox.id))!.status === "destroyed", "sandbox #1 is destroyed", "sandbox should be gone");
contrast("the session is dead now; its uncommitted work vanished with the box.");

step("Rebuild: a new sandbox is materialized from the checkpoint and the session continues.");
const s2 = await mgr.acquire("local", { workspaceId: "W", containerKey: "S/main", workspaceRef: ref, affinity: "W" });
const r = await run(s2.sandbox.exec("cat src/build.txt && cat progress.log"));
note(`sandbox #2 = ${s2.sandbox.id} reads back -> ${JSON.stringify(r.out)}`);
expect(s2.sandbox.id !== s1.sandbox.id, "it is a new sandbox", "expected a different sandbox id");
expect(r.out === "v1\ndone", "every file is exactly as it was; the session resumes seamlessly", "state was not restored");
await s2.release();

dumpRows(store.rows);
done();
