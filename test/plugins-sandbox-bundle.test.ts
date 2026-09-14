import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHostBundle, SANDBOX_HOST_DIR } from "../src/plugins/bundle.ts";
import type { PackageManifest } from "../src/plugins/api.ts";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
let tmp: string;
beforeAll(async () => { tmp = await mkdtemp(path.join(tmpdir(), "pma-bundle-")); });
afterAll(async () => { if (tmp) await rm(tmp, { recursive: true, force: true }); });

const man = (dir: string): PackageManifest => ({ dir, source: dir, name: path.basename(dir), kind: "pma", plugins: ["index.js"], skills: [], prompts: [] });
async function files(dir: string, map: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  for (const [rel, c] of Object.entries(map)) { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), c); }
  return dir;
}
async function extract(tgz: Uint8Array) {
  const out = await mkdtemp(path.join(tmp, "x-"));
  await writeFile(path.join(out, "b.tgz"), tgz);
  await run("tar", ["xzf", path.join(out, "b.tgz"), "-C", out]);
  return out;
}
const list = async (tgz: Uint8Array) => {
  const f = path.join(await mkdtemp(path.join(tmp, "l-")), "b.tgz");
  await writeFile(f, tgz);
  return (await run("tar", ["tzf", f], { maxBuffer: 64 * 1024 * 1024 })).stdout.split("\n").map((l) => l.replace(/^\.\//, ""));
};

describe("buildHostBundle", () => {
  it("memoizes by manifest dirs and evicts a failed build so a retry rebuilds", async () => {
    const d = await files(path.join(tmp, "memo"), { "index.js": "export default () => {}" });
    const p1 = buildHostBundle([man(d)], ROOT);
    expect(buildHostBundle([man(d)], ROOT)).toBe(p1);
    const b = await p1;
    expect(b.key).toMatch(/^[0-9a-f]{16}$/);

    const missing = path.join(tmp, "does-not-exist");
    const f1 = buildHostBundle([man(missing)], ROOT);
    await expect(f1).rejects.toThrow();
    const f2 = buildHostBundle([man(missing)], ROOT);
    expect(f2).not.toBe(f1);
    await expect(f2).rejects.toThrow();
  }, 60_000);

  it("remaps manifests under SANDBOX_HOST_DIR/packages/<i>-<safe basename> and ships the host sources", async () => {
    const a = await files(path.join(tmp, "my pkg@1"), { "index.js": "" });
    const b = await files(path.join(tmp, "second"), { "index.js": "" });
    const bundle = await buildHostBundle([man(a), man(b)], ROOT);
    expect(bundle.manifests.map((m) => m.dir)).toEqual([`${SANDBOX_HOST_DIR}/${bundle.key}/packages/0-my_pkg_1`, `${SANDBOX_HOST_DIR}/${bundle.key}/packages/1-second`]);
    expect(bundle.manifests[0]).toMatchObject({ source: a, name: "my pkg@1", plugins: ["index.js"] });
    const names = await list(bundle.tgz);
    expect(names).toContain("src/plugins/host.ts");
    expect(names.some((n) => n.startsWith("node_modules/typebox/"))).toBe(true);
    expect(names).toContain("packages/0-my_pkg_1/index.js");
  }, 60_000);

  it("excludes .git but keeps .github", async () => {
    const d = await files(path.join(tmp, "gitpkg"), { "index.js": "", ".git/config": "[core]", ".github/workflows/ci.yml": "on: push", "sub/.git/HEAD": "x" });
    const names = await list((await buildHostBundle([man(d)], ROOT)).tgz);
    expect(names.some((n) => n.includes("/.git/") || n.endsWith("/.git"))).toBe(false);
    expect(names).toContain("packages/0-gitpkg/.github/workflows/ci.yml");
  }, 60_000);

  // Regression: cp(..., { dereference: true }) copies the target of a symlink that points outside the package.
  it("does not dereference a symlink that points outside the package into the tarball", async () => {
    const secret = path.join(tmp, "runner.env");
    await writeFile(secret, "DATABASE_URL=postgres://secret");
    const d = await files(path.join(tmp, "leaky"), { "index.js": "" });
    await symlink(secret, path.join(d, "leak"));
    const out = await extract((await buildHostBundle([man(d)], ROOT)).tgz);
    const leak = path.join(out, "packages/0-leaky/leak");
    const st = await lstat(leak).catch(() => null);
    if (st && !st.isSymbolicLink()) expect(await readFile(leak, "utf8")).not.toContain("postgres://secret");
  }, 60_000);

  // Regression: only m.dir is copied; an npm package's hoisted dependencies (sibling node_modules) are left out.
  it("an npm-installed package can import its hoisted dependency from the bundle", async () => {
    const nm = path.join(tmp, "npmroot/node_modules");
    await files(path.join(nm, "dep"), { "package.json": JSON.stringify({ name: "dep", type: "module", main: "index.js" }), "index.js": "export const v = 'DEP-OK';" });
    const plug = await files(path.join(nm, "plug"), { "package.json": JSON.stringify({ name: "plug", type: "module" }), "index.js": "export { v } from 'dep';" });
    const out = await extract((await buildHostBundle([man(plug)], ROOT)).tgz);
    const entry = path.join(out, "packages/0-plug/index.js");
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(entry)}); console.log(m.v);`]);
    expect(stdout.trim()).toBe("DEP-OK");
  }, 60_000);
});
