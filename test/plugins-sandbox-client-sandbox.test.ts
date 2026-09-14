import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { PluginHost } from "../src/plugins/client.ts";
import { buildHostBundle, SANDBOX_HOST_DIR, type HostBundle } from "../src/plugins/bundle.ts";
import { spawnProcess } from "../src/sandbox/exec.ts";
import type { ExecChunk, Sandbox, SandboxProcess } from "../src/shared/types.ts";
import type { PackageManifest } from "../src/plugins/api.ts";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = (dir: string): PackageManifest => ({ dir, source: dir, name: path.basename(dir), kind: "pma", plugins: ["index.ts"], skills: [], prompts: [] });
const fakeBundle: HostBundle = { tgz: new Uint8Array([1, 2, 3]), manifests: [], key: "k" };

let priv: string;
beforeAll(async () => { priv = await mkdtemp(path.join(tmpdir(), "pma-sbxroot-")); });
afterAll(async () => { if (priv) await rm(priv, { recursive: true, force: true }); });

/**
 * A stand-in sandbox over a temp dir with its own private "/tmp": every command and every line sent
 * to a spawned process has SANDBOX_HOST_DIR rewritten under `priv`, so this never touches the real
 * /tmp/pma-host that other test files use, while two hosts in this sandbox still share one dir.
 */
function standIn(root: string): Sandbox {
  mkdirSync(path.join(root, "tmp"), { recursive: true });
  const map = (s: string) => s.replaceAll(SANDBOX_HOST_DIR, path.join(root, SANDBOX_HOST_DIR));
  return {
    id: "sbx_standin", provider: "local", workdir: root,
    async *exec(cmd: string): AsyncIterable<ExecChunk> {
      try { const { stdout } = await run("bash", ["-lc", map(cmd)], { cwd: root }); yield { type: "stdout", data: stdout }; yield { type: "exit", code: 0 }; } catch (e: any) { yield { type: "stderr", data: String(e.stderr ?? e.message) }; yield { type: "exit", code: typeof e.code === "number" ? e.code : 1 }; }
    },
    async readFile(p: string) { return new Uint8Array(await readFile(path.resolve(root, p))); },
    async writeFile(p: string, data: Uint8Array) { const abs = path.resolve(root, p); await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, data); },
    async spawn(cmd: string, opts: { env?: Record<string, string> } = {}): Promise<SandboxProcess> {
      const proc = spawnProcess("bash", ["-lc", map(cmd)], { cwd: root, env: { ...process.env, ...opts.env } });
      return { ...proc, write: (d: string) => proc.write(map(d)) };
    },
  };
}

describe("PluginHost.startInSandbox failure paths", () => {
  it("a sandbox without spawn cannot host plugins", async () => {
    const { spawn: _s, ...noSpawn } = standIn(priv);
    await expect(PluginHost.startInSandbox({ ...noSpawn, provider: "e2b" }, fakeBundle, { agentId: "a" })).rejects.toThrow(/sandbox provider e2b cannot host plugins/);
  });

  it("a non-zero upload exit rejects with 'bundle upload failed' and its stderr", async () => {
    const sb = standIn(priv);
    const written: string[] = [];
    sb.spawn = async () => {
      let exit: (c: number) => void = () => {}; let err: (c: string) => void = () => {};
      return {
        write: (d) => { written.push(d); }, end: () => { err("disk full\n"); exit(3); },
        onStdout: () => {}, onStderr: (cb) => { err = cb; }, onExit: (cb) => { exit = cb as (c: number) => void; }, kill: () => {},
      };
    };
    await expect(PluginHost.startInSandbox(sb, fakeBundle, { agentId: "a" })).rejects.toThrow("bundle upload failed (3): disk full");
    expect(Buffer.from(written.join("").replace(/\n/g, ""), "base64")).toEqual(Buffer.from([1, 2, 3]));
  });

  it("a sandbox without node rejects with the setup error", async () => {
    const sb = standIn(priv);
    sb.spawn = async () => {
      let exit: (c: number) => void = () => {};
      return { write: () => {}, end: () => exit(0), onStdout: () => {}, onStderr: () => {}, onExit: (cb) => { exit = cb as (c: number) => void; }, kill: () => {} };
    };
    sb.exec = async function* () { yield { type: "stderr", data: "node is not installed in the sandbox image\n" }; yield { type: "exit", code: 127 }; };
    await expect(PluginHost.startInSandbox(sb, fakeBundle, { agentId: "a" })).rejects.toThrow(/plugin host bundle setup failed in sandbox: node is not installed/);
  });
});

describe("two plugin hosts in one shared sandbox", () => {
  // Regression: every sandbox host installs to the fixed SANDBOX_HOST_DIR with rm -rf, so hosts clobber each other.
  // Started one after the other (not concurrently) so the failure is deterministic and no upload pipe breaks.
  it("a second host with a different bundle does not delete the first host's packages", async () => {
    const root = await mkdtemp(path.join(priv, "shared-"));
    const sb = standIn(root);
    const [ba, bb] = await Promise.all([
      buildHostBundle([pkg(path.join(ROOT, "test/fixtures/plugins-sandbox-escape"))], ROOT),
      buildHostBundle([pkg(path.join(ROOT, "test/fixtures/pma-runtime"))], ROOT),
    ]);
    const hosts: PromiseSettledResult<PluginHost>[] = [];
    for (const [b, agentId] of [[ba, "parent"], [bb, "child"]] as const) hosts.push(await PluginHost.startInSandbox(sb, b, { agentId }).then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason })));
    try {
      expect(hosts.map((h) => h.status)).toEqual(["fulfilled", "fulfilled"]);
      const [ha, hb] = hosts.map((h) => (h as PromiseFulfilledResult<PluginHost>).value);
      expect(ha!.tools.map((t) => t.name)).toEqual(["escape2"]);
      expect(hb!.tools.map((t) => t.name)).toEqual(["escalate"]);
      // both bundles must still be on disk (a restart or lazy import needs them)
      for (const b of [ba, bb]) expect((await stat(path.join(root, b.manifests[0]!.dir)).catch(() => null))?.isDirectory()).toBe(true);
    } finally { for (const h of hosts) if (h.status === "fulfilled") h.value.stop(); }
  }, 90_000);
});
