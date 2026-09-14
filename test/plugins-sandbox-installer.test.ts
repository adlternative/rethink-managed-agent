import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// npm/git never run for real: record the argv and pretend success.
const runs: { file: string; args: string[]; cwd?: string }[] = [];
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const execFile = (file: string, args: string[], opts: unknown, cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
    const done = typeof opts === "function" ? (opts as typeof cb) : cb;
    runs.push({ file, args, cwd: (opts as { cwd?: string })?.cwd });
    done?.(null, { stdout: "", stderr: "" });
  };
  return { ...real, execFile, default: { ...real, execFile } };
});

let tmp: string;
let mod: typeof import("../src/plugins/installer.ts");
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "pma-inst-"));
  process.env.PI_AGENT_ROOT = path.join(tmp, "agents");
  process.env.PLUGIN_ALLOW = "*";
  process.env.PLUGIN_ALLOW_SANDBOX = "*";
  vi.spyOn(console, "log").mockImplementation(() => {});
  mod = await import("../src/plugins/installer.ts");
});

async function pkgDir(name: string, files: Record<string, string>) {
  const dir = path.join(tmp, "pkgs", name);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}
let n = 0;
const agent = () => `agent_inst_${++n}`;

describe("ensurePackages / readManifest", () => {
  it("uses pma.plugins when given, and falls back to index.ts / index.js and skills / prompts dirs", async () => {
    const a = await pkgDir("explicit", { "package.json": JSON.stringify({ name: "explicit", pma: { plugins: ["./main.ts"], skills: ["./sk"], prompts: ["./pr"] } }) });
    const b = await pkgDir("conv-js", { "package.json": JSON.stringify({ name: "conv-js", pi: {} }), "index.js": "", "skills/x/SKILL.md": "", "prompts/p.md": "" });
    const c = await pkgDir("conv-none", { "package.json": JSON.stringify({ name: "conv-none", pma: {} }) });
    const [ma, mb, mc] = await mod.ensurePackages(agent(), [a, b, c]);
    expect(ma).toEqual({ dir: a, source: a, name: "explicit", kind: "pma", plugins: ["./main.ts"], skills: ["./sk"], prompts: ["./pr"] });
    expect(mb).toEqual({ dir: b, source: b, name: "conv-js", kind: "pi", plugins: ["index.js"], skills: ["skills"], prompts: ["prompts"] });
    expect(mc).toMatchObject({ kind: "pma", plugins: [], skills: [], prompts: [] });
  });

  it("pi.extensions maps to plugins; a missing package.json reads as an empty manifest", async () => {
    const a = await pkgDir("pi-ext", { "package.json": JSON.stringify({ name: "pi-ext", pi: { extensions: ["./e.ts"] } }) });
    const b = await pkgDir("no-json", { "index.ts": "" });
    const [ma, mb] = await mod.ensurePackages(agent(), [a, b]);
    expect(ma).toMatchObject({ kind: "pi", plugins: ["./e.ts"] });
    expect(mb).toMatchObject({ name: undefined, plugins: ["index.ts"] });
  });

  // Regression: a package with neither "pma" nor "pi" is treated as a pi extension.
  it("a conventional index.ts package with neither 'pma' nor 'pi' is loaded as a pma plugin", async () => {
    const d = await pkgDir("plain", { "package.json": JSON.stringify({ name: "plain" }), "index.ts": "" });
    const [m] = await mod.ensurePackages(agent(), [d]);
    expect(m!.plugins).toEqual(["index.ts"]);
    expect(m!.kind).toBe("pma");
  });

  it("rejects a relative source", async () => {
    await expect(mod.ensurePackages(agent(), ["relative/pkg"])).rejects.toThrow(/npm:, git:, or an absolute path/);
  });

  it("a source allowed in no placement throws before anything is installed", async () => {
    const saved = [process.env.PLUGIN_ALLOW, process.env.PLUGIN_ALLOW_SANDBOX];
    process.env.PLUGIN_ALLOW = "/nowhere/"; process.env.PLUGIN_ALLOW_SANDBOX = "";
    vi.resetModules();
    try {
      const fresh = await import("../src/plugins/installer.ts");
      const id = agent();
      runs.length = 0;
      await expect(fresh.ensurePackages(id, ["npm:evil"])).rejects.toThrow(/allowed in no placement: npm:evil/);
      expect(runs).toEqual([]);
      await expect(stat(fresh.agentDirFor(id))).rejects.toThrow();
    } finally { [process.env.PLUGIN_ALLOW, process.env.PLUGIN_ALLOW_SANDBOX] = saved; vi.resetModules(); }
  });

  it("a cache hit returns the cached manifests without re-reading package.json", async () => {
    const d = await pkgDir("cached", { "package.json": JSON.stringify({ name: "v1", pma: {} }) });
    const id = agent();
    expect((await mod.ensurePackages(id, [d]))[0]!.name).toBe("v1");
    await writeFile(path.join(d, "package.json"), JSON.stringify({ name: "v2", pma: {} }));
    expect((await mod.ensurePackages(id, [d]))[0]!.name).toBe("v1");
    // a different source list is a cache miss
    const other = await pkgDir("other", { "package.json": JSON.stringify({ name: "o", pma: {} }) });
    expect((await mod.ensurePackages(id, [d, other])).map((m) => m.name)).toEqual(["v2", "o"]);
  });

  // Regression: installer.ts only catches the readFile error, not JSON.parse of a truncated cache file.
  it("a truncated packages.json cache triggers a reinstall instead of a SyntaxError", async () => {
    const d = await pkgDir("trunc", { "package.json": JSON.stringify({ name: "trunc", pma: {} }) });
    const id = agent();
    await mkdir(mod.agentDirFor(id), { recursive: true });
    await writeFile(path.join(mod.agentDirFor(id), "packages.json"), '{"key":');
    const [m] = await mod.ensurePackages(id, [d]);
    expect(m!.name).toBe("trunc");
    expect(JSON.parse(await readFile(path.join(mod.agentDirFor(id), "packages.json"), "utf8")).manifests[0].name).toBe("trunc");
  });

  it("agentDirFor sanitizes the agent id", () => {
    expect(mod.agentDirFor("../evil/id")).toBe(path.join(process.env.PI_AGENT_ROOT!, ".._evil_id"));
  });

  it("derives the npm install dir name from the spec (scoped, versioned, ranged)", async () => {
    const cases: [string, string][] = [["@scope/pkg@1.2.3", "@scope/pkg"], ["left-pad@^1", "left-pad"], ["left-pad", "left-pad"], ["@scope/pkg", "@scope/pkg"]];
    for (const [spec, name] of cases) {
      runs.length = 0;
      const [m] = await mod.ensurePackages(agent(), [`npm:${spec}`]);
      expect(m!.dir.endsWith(path.join("node_modules", name))).toBe(true);
      expect(runs[0]!.args).toEqual(["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts", spec]);
    }
  });

  it("clones git sources with the ref as --branch and a -- separator", async () => {
    runs.length = 0;
    const [m] = await mod.ensurePackages(agent(), ["git:https://example.com/r.git@v1.2"]);
    expect(runs[0]).toMatchObject({ file: "git", args: ["clone", "--quiet", "--depth", "1", "--branch", "v1.2", "--", "https://example.com/r.git", m!.dir] });
  });
});

describe("loadContent", () => {
  const man = (dir: string, skills: string[], prompts: string[] = []) => ({ dir, source: dir, name: "p", kind: "pma" as const, plugins: [], skills, prompts });

  it("honours the depth limit and walks the parent dir when a skills entry is a file", async () => {
    const d = await pkgDir("deep", {
      "skills/a/b/c/SKILL.md": "---\nname: at-depth-3\n---\nok",
      "skills/a/b/c/d/SKILL.md": "---\nname: too-deep\n---\nno",
      "one/SKILL.md": "---\nname: from-file\ndescription: \"quoted\"\n---\nbody",
      "prompts/p1.md": "---\ndescription: a prompt\n---\nhello",
      "prompts/notes.txt": "ignored",
    });
    const { skills, prompts } = await mod.loadContent([man(d, ["skills", "one/SKILL.md"], ["prompts"])]);
    expect(skills.map((s) => s.name).sort()).toEqual(["at-depth-3", "from-file"]);
    expect(skills.find((s) => s.name === "from-file")).toMatchObject({ description: "quoted", body: "body" });
    expect(prompts).toEqual([{ name: "p1", description: "a prompt", body: "hello", source: d }]);
  });

  it("falls back to the directory name without frontmatter", async () => {
    const d = await pkgDir("nofm", { "skills/my-skill/SKILL.md": "just text" });
    const { skills } = await mod.loadContent([man(d, ["skills"])]);
    expect(skills).toEqual([{ name: "my-skill", description: "", body: "just text", source: d }]);
  });

  // Regression: frontmatter() only matches "\n" line endings.
  it("parses CRLF frontmatter", async () => {
    const d = await pkgDir("crlf", { "skills/x/SKILL.md": "---\r\nname: crlf-skill\r\ndescription: win\r\n---\r\nbody" });
    const { skills } = await mod.loadContent([man(d, ["skills"])]);
    expect(skills[0]).toMatchObject({ name: "crlf-skill", description: "win", body: "body" });
  });

  // Regression: loadContent follows symlinks and absolute / '..' paths out of the package dir.
  it("does not read a symlinked SKILL.md that points outside the package", async () => {
    const secret = path.join(tmp, "outside-secret.txt");
    await writeFile(secret, "TOP-SECRET-RUNNER-FILE");
    const d = await pkgDir("symlinked", {});
    await mkdir(path.join(d, "skills/x"), { recursive: true });
    await symlink(secret, path.join(d, "skills/x/SKILL.md"));
    const { skills } = await mod.loadContent([man(d, ["skills"])]);
    expect(JSON.stringify(skills)).not.toContain("TOP-SECRET");
  });

  it("does not read prompts from an absolute dir outside the package", async () => {
    const outside = await pkgDir("outside-abs", { "leak.md": "ABS-LEAK" });
    const d = await pkgDir("abs-prompts", {});
    const { prompts } = await mod.loadContent([man(d, [], [outside])]);
    expect(JSON.stringify(prompts)).not.toContain("ABS-LEAK");
  });

  it("does not read prompts from a '..' path outside the package", async () => {
    await pkgDir("outside-rel", { "leak.md": "REL-LEAK" });
    const d = await pkgDir("rel-prompts", {});
    const { prompts } = await mod.loadContent([man(d, [], ["../outside-rel"])]);
    expect(JSON.stringify(prompts)).not.toContain("REL-LEAK");
  });
});
