/**
 * Demo harness. Each scenario drives the *real* SandboxManager and *real* providers
 * (local/docker/e2b) — the only thing faked is the lease store, which lives in memory
 * here so a demo needs no Postgres. The point of each demo is to show something a
 * session-bound-sandbox product (Claude Managed Agent, Qoder Cloud Agent) cannot do.
 */
import { mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxRow, SandboxProviderName } from "../src/shared/types.ts";
import type { LeaseStore } from "../src/sandbox/manager.ts";

const sh = promisify(execFile);

/** A drop-in, in-memory implementation of the lease store the manager talks to. */
export function memStore(): LeaseStore & { rows: Map<string, SandboxRow> } {
  const rows = new Map<string, SandboxRow>();
  const live = (r: SandboxRow) => r.status !== "destroyed";
  return {
    rows,
    insert: async (r) => { rows.set(r.id, { ...r, last_used_at: new Date().toISOString(), created_at: new Date().toISOString() } as SandboxRow); },
    setStatus: async (id, status) => { rows.get(id)!.status = status; rows.get(id)!.last_used_at = new Date().toISOString(); },
    setExternalRef: async (id, ref) => { rows.get(id)!.external_ref = ref; },
    setMount: async (id, cref, wd) => { const r = rows.get(id)!; r.container_ref = cref; r.workdir = wd; },
    findContainer: async (p, key) => [...rows.values()].find((r) => r.provider === p && r.container_key === key && r.container_ref && ["ready", "busy", "paused"].includes(r.status)) ?? null,
    mountsOf: async (cref) => [...rows.values()].filter((r) => r.container_ref === cref && live(r)),
    touch: async () => {},
    get: async (id) => rows.get(id) ?? null,
    list: async () => [...rows.values()].filter(live),
    findReadyByAffinity: async (p, affinity) => {
      const r = [...rows.values()].find((r) => r.provider === p && r.affinity === affinity && (r.status === "ready" || r.status === "paused"));
      if (!r) return null;
      const prev = r.status; r.status = "busy";
      return { ...r, status: prev };
    },
    findBusyByAffinity: async (p, affinity) => [...rows.values()].find((r) => r.provider === p && r.affinity === affinity && r.status === "busy") ?? null,
    listIdle: async (p) => [...rows.values()].filter((r) => r.provider === p && r.status === "ready"),
    listToDestroy: async (p, ttl) => [...rows.values()].filter((r) => r.provider === p && ((r.status === "paused" && ttl === 0) || r.status === "destroying")),
  } as LeaseStore & { rows: Map<string, SandboxRow> };
}

export async function dockerAvailable(): Promise<boolean> {
  try { await sh("docker", ["version", "--format", "{{.Server.Version}}"]); return true; } catch { return false; }
}

export async function killDemoContainers(): Promise<void> {
  try {
    const { stdout } = await sh("docker", ["ps", "-aq", "--filter", "label=pi.sandbox=1"]);
    const ids = stdout.trim().split("\n").filter(Boolean);
    if (ids.length) await sh("docker", ["rm", "-f", ...ids]).catch(() => {});
  } catch {}
}

export async function scratchRoots(): Promise<void> {
  process.env.SANDBOX_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), "demo-sbx-"));
  process.env.WORKSPACE_ROOT = await mkdtemp(path.join(tmpdir(), "demo-ws-"));
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://unused";
}

/** Drain an exec stream to { out, code }. */
export async function run(it: AsyncIterable<{ type: string; data?: string; code?: number }>): Promise<{ out: string; code: number }> {
  let out = "", code = -1;
  for await (const c of it) { if (c.type === "stdout") out += c.data; if (c.type === "exit") code = c.code!; }
  return { out: out.replace(/\n$/, ""), code };
}

// ---- narration ----
const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", r: "\x1b[31m", x: "\x1b[0m" };
let n = 0;
export function title(s: string) { console.log(`\n${C.b}${C.c}━━ ${s} ${"━".repeat(Math.max(0, 60 - s.length))}${C.x}`); n = 0; }
export function step(s: string) { console.log(`${C.b}${++n}.${C.x} ${s}`); }
export function note(s: string) { console.log(`   ${C.dim}${s}${C.x}`); }
export function ok(s: string) { console.log(`   ${C.g}✓ ${s}${C.x}`); }
export function bad(s: string) { console.log(`   ${C.r}✗ ${s}${C.x}`); }
export function contrast(s: string) { console.log(`   ${C.y}▲ heavy products: ${s}${C.x}`); }

/** Pretty one-line-per-row dump of sandbox rows, the demo's ground-truth evidence. */
export function dumpRows(rows: Map<string, SandboxRow>, only?: SandboxProviderName) {
  console.log(`   ${C.dim}sandboxes:${C.x}`);
  for (const r of rows.values()) {
    if (only && r.provider !== only) continue;
    const cref = r.container_ref ? r.container_ref.slice(0, 14) : "-";
    console.log(`   ${C.dim}  ${r.id}  ${r.provider}/${r.status}  key=${r.container_key ?? "-"}  container=${cref}  ws=${r.workspace_id}${C.x}`);
  }
}

let failed = false;
export function expect(cond: boolean, pass: string, fail: string) { if (cond) ok(pass); else { bad(fail); failed = true; } }
export function done() {
  if (failed) { console.log(`\n${C.r}${C.b}DEMO FAILED${C.x}\n`); process.exit(1); }
  console.log(`\n${C.g}${C.b}DEMO OK${C.x}\n`);
}
