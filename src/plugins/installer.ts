import { disallowedEverywhere } from "./allow.ts";
/**
 * Installs package sources into a per-agent dir and reads their manifests.
 * Sources: "npm:<spec>", "git:<url>[@ref]", or a local path (used in place).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../shared/env.ts";
import type { PackageManifest, PromptTemplate, Skill } from "./api.ts";

const run = promisify(execFile);

export function agentDirFor(agentId: string): string {
  return path.resolve(env.PI_AGENT_ROOT, agentId.replace(/[^A-Za-z0-9_.-]/g, "_"));
}

const slug = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

async function installOne(source: string, root: string): Promise<string> {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    const dir = path.join(root, "npm", slug(spec));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "pma-pkg-root", private: true, type: "module" }));
    await run("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts", spec], { cwd: dir });
    const name = spec.replace(/@[^/@]+$/, "").replace(/^(@[^/]+\/[^@/]+|[^@/]+).*/, "$1");
    return path.join(dir, "node_modules", name);
  }
  if (source.startsWith("git:") || /^https?:\/\/.+\.git$/.test(source)) {
    const url = source.startsWith("git:") ? source.slice(4) : source;
    const [repo, ref] = url.split(/@(?=[^/@]+$)/);
    const dir = path.join(root, "git", slug(url));
    if (!(await stat(dir).catch(() => null))) {
      await run("git", ["clone", "--quiet", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", repo!, dir]);
      if (await stat(path.join(dir, "package.json")).catch(() => null)) {
        await run("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts"], { cwd: dir }).catch(() => {});
      }
    }
    return dir;
  }
  if (!path.isAbsolute(source)) throw new Error(`package source must be npm:, git:, or an absolute path: ${source}`);
  return source;
}

async function readManifest(dir: string, source: string): Promise<PackageManifest> {
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8").catch(() => "{}")) as { name?: string; pma?: Record<string, string[]>; pi?: Record<string, string[]> };
  const m = pkg.pma ?? pkg.pi;
  const kind: PackageManifest["kind"] = pkg.pma ? "pma" : "pi";
  // conventional dirs when the manifest omits a field (pi does the same)
  const exists = async (p: string) => !!(await stat(path.join(dir, p)).catch(() => null));
  const plugins = m?.plugins ?? m?.extensions ?? ((await exists("index.ts")) ? ["index.ts"] : (await exists("index.js")) ? ["index.js"] : []);
  return {
    dir,
    source,
    name: pkg.name,
    kind,
    plugins,
    skills: m?.skills ?? ((await exists("skills")) ? ["skills"] : []),
    prompts: m?.prompts ?? ((await exists("prompts")) ? ["prompts"] : []),
  };
}

/** Install (cached by source list) and return manifests. */
export async function ensurePackages(agentId: string, sources: string[]): Promise<PackageManifest[]> {
  const blocked = disallowedEverywhere(sources); // fail fast only if a package can run in NO placement
  if (blocked.length) throw new Error(`plugin packages allowed in no placement: ${blocked.join(", ")}`);
  const root = agentDirFor(agentId);
  await mkdir(root, { recursive: true });
  const cache = path.join(root, "packages.json");
  const key = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
  const cached = JSON.parse(await readFile(cache, "utf8").catch(() => "null")) as { key: string; manifests: PackageManifest[] } | null;
  if (cached?.key === key) return cached.manifests;
  const manifests: PackageManifest[] = [];
  for (const source of sources) {
    console.log(`[plugins] installing ${source} for ${agentId}`);
    manifests.push(await readManifest(await installOne(source, root), source));
  }
  await writeFile(cache, JSON.stringify({ key, manifests }, null, 2));
  return manifests;
}

function frontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(m[0].length) };
}

/** SKILL.md files (pi layout: <dir>/<name>/SKILL.md) and prompt templates (<dir>/*.md). */
export async function loadContent(manifests: PackageManifest[]): Promise<{ skills: Skill[]; prompts: PromptTemplate[] }> {
  const skills: Skill[] = [];
  const prompts: PromptTemplate[] = [];
  for (const m of manifests) {
    for (const rel of m.skills) {
      const root = path.resolve(m.dir, rel);
      const walk = async (d: string, depth: number): Promise<void> => {
        if (depth > 3) return;
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p, depth + 1);
          else if (e.name === "SKILL.md") {
            const { meta, body } = frontmatter(await readFile(p, "utf8"));
            skills.push({ name: meta.name ?? path.basename(d), description: meta.description ?? "", body: body.trim(), source: m.source });
          }
        }
      };
      if ((await stat(root).catch(() => null))?.isFile()) await walk(path.dirname(root), 0);
      else await walk(root, 0);
    }
    for (const rel of m.prompts) {
      const root = path.resolve(m.dir, rel);
      for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile() || !e.name.endsWith(".md")) continue;
        const { meta, body } = frontmatter(await readFile(path.join(root, e.name), "utf8"));
        prompts.push({ name: e.name.replace(/\.md$/, ""), description: meta.description ?? "", body: body.trim(), source: m.source });
      }
    }
  }
  return { skills, prompts };
}
