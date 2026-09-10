/**
 * CLAIM: idle sandboxes are paused, not wastefully kept hot nor destroyed. An idle container is
 * paused (docker stop / e2b pause); the next turn resumes it in place with its process state and
 * warm caches intact; only after a longer TTL is it destroyed. Heavy products bill you for a box
 * held for the whole session, or cold-start a new one every time. Requires docker.
 */
import { DockerProvider } from "../src/sandbox/docker.ts";
import { SandboxManager } from "../src/sandbox/manager.ts";
import { memStore, scratchRoots, dockerAvailable, killDemoContainers, run, title, step, note, contrast, expect, dumpRows, done } from "./lib.ts";

await scratchRoots();
if (!(await dockerAvailable())) { console.log("docker not available — skipping pause/resume demo"); process.exit(0); }
const store = memStore();
const mgr = new SandboxManager({ docker: new DockerProvider() } as never, store);

title("Idle tiers — pause the idle sandbox, resume it in place");
try {
  step("Acquire a sandbox and warm it (write a file, start a long-lived process).");
  const s1 = await mgr.acquire("docker", { workspaceId: "W", containerKey: "S/main", workspaceRef: { kind: "empty" }, affinity: "W" });
  await run(s1.sandbox.exec("echo warmed > state.txt && (sleep 600 & echo $! > /host/pid)"));
  const pid = (await run(s1.sandbox.exec("cat /host/pid"))).out;
  note(`sandbox=${s1.sandbox.id} background pid=${pid}`);
  await s1.release();

  step("It goes idle. The reaper PAUSES the container (does not destroy it).");
  const reaped = await mgr.reap(0, 3_600_000); // idle ttl 0, paused ttl 1h -> pause, don't destroy
  expect(reaped.docker.paused.includes(s1.sandbox.id), "the idle container was paused", "expected a pause");
  expect((await mgr.get(s1.sandbox.id))!.status === "paused", "row status = paused (billable state, not running)", "status should be paused");
  contrast("hold the box hot for the whole session (you pay), or destroy it and cold-start next turn.");

  step("Next turn: re-acquire the same workspace. The paused container RESUMES in place.");
  const s2 = await mgr.acquire("docker", { workspaceId: "W", containerKey: "S/main", workspaceRef: { kind: "empty" }, affinity: "W" });
  expect(s2.sandbox.id === s1.sandbox.id, "same sandbox came back (not a fresh cold box)", "expected the same sandbox id");
  expect(s2.origin === "resumed", "lease origin = resumed", "expected origin=resumed");
  const state = await run(s2.sandbox.exec("cat state.txt"));
  const alive = await run(s2.sandbox.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`));
  note(`after resume: state.txt=${JSON.stringify(state.out)}  bg-process=${alive.out}`);
  expect(state.out === "warmed", "the filesystem is exactly where we left it", "state was lost across pause/resume");
  expect(alive.out === "alive", "the long-lived process survived the pause — the runtime resumed, not restarted", "process did not survive");
  await s2.release();

  step("It goes idle again -> paused; then once paused past its TTL -> destroyed, freeing the resource.");
  await mgr.reap(0, 3_600_000);                       // idle -> pause
  const gone = await mgr.reap(0, 0);                   // paused past ttl -> destroy
  expect(gone.docker.destroyed.includes(s1.sandbox.id), "paused past its TTL -> destroyed", "expected destroy");
  dumpRows(store.rows, "docker");
} finally {
  await killDemoContainers();
}
done();
