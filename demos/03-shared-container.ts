/**
 * CLAIM: a parent agent and its sub-agents share ONE container (one runtime) while keeping
 * separate working directories — no git worktree, isolation by directory. They see one process
 * namespace, one filesystem at /host, shared installed deps and ports. Heavy products give each
 * agent its own sandbox, so sub-agents cannot share a dev server, a warmed cache, or built deps.
 * Requires docker.
 */
import { DockerProvider } from "../src/sandbox/docker.ts";
import { SandboxManager } from "../src/sandbox/manager.ts";
import { memStore, scratchRoots, dockerAvailable, killDemoContainers, run, title, step, note, contrast, expect, dumpRows, done } from "./lib.ts";

await scratchRoots();
if (!(await dockerAvailable())) { console.log("docker not available — skipping shared-container demo"); process.exit(0); }
const store = memStore();
const mgr = new SandboxManager({ docker: new DockerProvider() } as never, store);

title("Shared container — one runtime, many agents, separate dirs");
try {
  const KEY = "team-run/main"; // container_group / environment => the shared containerKey
  step("Parent agent acquires a sandbox (opens the container).");
  const parent = await mgr.acquire("docker", { workspaceId: "ws-parent", containerKey: KEY, workspaceRef: { kind: "empty" }, affinity: "ws-parent" });
  note(`parent mount=${parent.sandbox.id} workdir=${parent.sandbox.workdir} origin=${parent.origin}`);

  step("Two sub-agents acquire sandboxes with the SAME container key (different workspaces).");
  const a = await mgr.acquire("docker", { workspaceId: "ws-a", containerKey: KEY, workspaceRef: { kind: "empty" }, affinity: "ws-a" });
  const b = await mgr.acquire("docker", { workspaceId: "ws-b", containerKey: KEY, workspaceRef: { kind: "empty" }, affinity: "ws-b" });
  const cref = store.rows.get(parent.sandbox.id)!.container_ref;
  expect([a, b].every((m) => store.rows.get(m.sandbox.id)!.container_ref === cref), "all three mounts landed in ONE container", "sub-agents opened separate containers");
  expect(a.origin === "shared" && b.origin === "shared", "sub-agent leases report origin=shared", "expected shared origin");
  expect(new Set([parent, a, b].map((m) => m.sandbox.workdir)).size === 3, "each agent has its own working directory", "workdirs collided");

  step("Shared runtime: parent writes to /host and starts a background process; sub-agent B sees both.");
  await run(parent.sandbox.exec("echo warm-cache > /host/shared.txt"));
  const seen = await run(b.sandbox.exec("cat /host/shared.txt"));
  note(`sub-agent B reads parent's /host/shared.txt => ${JSON.stringify(seen.out)}`);
  expect(seen.out === "warm-cache", "the /host tree (caches, built deps) is shared across agents", "sub-agent could not see the shared file");
  await run(parent.sandbox.exec("sleep 300 & echo started"));
  const ps = await run(b.sandbox.exec("pgrep -f 'sleep 300' >/dev/null && echo yes || echo no"));
  expect(ps.out === "yes", "one PID namespace: a process started by the parent is visible to a sub-agent", "sub-agent could not see the parent's process");
  contrast("each agent gets its own box; there is no shared cache, built node_modules, or process tree.");

  step("But files are isolated: parent's file is not in the sub-agent's directory.");
  await parent.sandbox.writeFile("secret.txt", new TextEncoder().encode("parent-only"));
  const leak = await run(a.sandbox.exec("ls secret.txt 2>/dev/null; true"));
  expect(leak.out === "", "sub-agent A's working directory does not see the parent's file", "directory isolation leaked");

  await parent.release(); await a.release(); await b.release();
  dumpRows(store.rows, "docker");

  step("Reap at container granularity: idle -> the ONE container pauses; past ttl -> destroyed once.");
  const paused = (await mgr.reap(0, 3_600_000)).docker.paused;
  expect(paused.length === 3, "all three mounts paused together (one docker pause)", "pause was not container-wide");
  const destroyed = (await mgr.reap(0, 0)).docker.destroyed;
  expect(destroyed.length === 3, "the container is destroyed once, retiring all three mounts", "destroy was not container-wide");
} finally {
  await killDemoContainers();
}
done();
