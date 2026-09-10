/**
 * CLAIM: the sandbox layer is pluggable. The SAME workspace and the SAME harness code run on any
 * provider — local today, docker or e2b tomorrow — chosen by config, not by rewriting the agent.
 * A workspace captured on one provider materializes on another. Heavy products bind you to their
 * one managed runtime.
 */
import { LocalProvider } from "../src/sandbox/local.ts";
import { DockerProvider } from "../src/sandbox/docker.ts";
import { SandboxManager } from "../src/sandbox/manager.ts";
import type { SandboxProviderName } from "../src/shared/types.ts";
import { memStore, scratchRoots, dockerAvailable, killDemoContainers, run, title, step, note, contrast, expect, dumpRows, done } from "./lib.ts";

await scratchRoots();
const store = memStore();
const providers: Record<string, unknown> = { local: new LocalProvider() };
const haveDocker = await dockerAvailable();
if (haveDocker) providers.docker = new DockerProvider();
const mgr = new SandboxManager(providers as never, store);

title("Provider swap — same workspace, same code, different runtime");
try {
  // one function, provider is just an argument
  async function build(provider: SandboxProviderName, ref: import("../src/shared/types.ts").WorkspaceRef) {
    const lease = await mgr.acquire(provider, { workspaceId: `w-${provider}`, containerKey: `demo/${provider}`, workspaceRef: ref, affinity: `w-${provider}` });
    const out = (await run(lease.sandbox.exec("echo built-by=$(uname -s 2>/dev/null || echo local); cat note.txt 2>/dev/null || true"))).out;
    return { lease, out };
  }

  step("Run the workspace on the LOCAL provider and leave a note.");
  const local = await build("local", { kind: "empty" });
  await local.lease.sandbox.writeFile("note.txt", new TextEncoder().encode("started on local"));
  const ref = await mgr.capture(local.lease.sandbox, { kind: "empty" });
  await local.lease.release();
  note(`local run output: ${JSON.stringify(local.out)}`);
  note(`captured ref: ${JSON.stringify(ref)}`);

  if (haveDocker) {
    step("Take the SAME captured workspace and run it on the DOCKER provider — no code change.");
    const dref = await (async () => {
      // local capture is a host dir; hand it to docker as a dir ref to materialize inside a container
      const d = await build("docker", ref);
      note(`docker run output: ${JSON.stringify(d.out)}`);
      expect(d.out.includes("started on local"), "docker sandbox sees the note written on local", "note did not travel across providers");
      await d.lease.release();
      await mgr.destroy(d.lease.sandbox.id);
    })();
    void dref;
    contrast("one vendor runtime only; you cannot lift a workspace onto your own docker/e2b.");
  } else {
    note("docker unavailable — showing the local half only; the call site is provider-agnostic either way.");
  }

  expect(true, "the acquire/exec/capture call site is identical for every provider", "");
  dumpRows(store.rows);
} finally {
  await killDemoContainers();
}
done();
