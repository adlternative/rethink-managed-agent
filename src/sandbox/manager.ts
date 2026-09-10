import { newId } from "../shared/ids.ts";
import type {
  Sandbox, SandboxHandle, SandboxId, SandboxLease, SandboxProvider, SandboxProviderName, SandboxRequest, SandboxRow, SandboxService, WorkspaceRef,
} from "../shared/types.ts";
import * as store from "./lease-store.ts";

/**
 * Policy over the providers. A *mount* row (one workspace's workdir) is 1:1 with a workspace and
 * exclusive (affinity = workspace id: one live run per workspace). Mounts sharing a `container_key`
 * live in one *container*, so a parent and its children share a runtime (processes, installed deps,
 * ports) while keeping separate directories. Owns leases, container reuse, reaping. The boundary a
 * future sandboxd service would sit on.
 */
export class SandboxManager {
  /** Mounts held by this process; capture()/release() need the live handle, not just the row. */
  private held = new Map<SandboxId, { provider: SandboxProvider; handle: SandboxHandle }>();

  constructor(private providers: Record<SandboxProviderName, SandboxProvider>) {}

  provider(name: SandboxProviderName): SandboxProvider {
    const p = this.providers[name];
    if (!p) throw new Error(`unknown sandbox provider: ${name}`);
    return p;
  }

  bind(name: SandboxProviderName): SandboxService {
    return { acquire: (req) => this.acquire(name, req), capture: (sb, prev) => this.capture(sb, prev) };
  }

  async acquire(name: SandboxProviderName, req: SandboxRequest): Promise<SandboxLease> {
    const provider = this.provider(name);
    const containerKey = req.containerKey ?? req.workspaceId; // no sharing -> a container of its own

    // 1. Reuse this workspace's own mount if it is idle and still there.
    const mine = req.affinity ? await store.findReadyByAffinity(name, req.affinity) : null;
    if (mine?.container_ref && mine.workdir) {
      if (mine.status === "paused") await provider.resume?.(mine.container_ref).catch((e) => console.warn(`[sandbox] resume ${mine.container_ref} failed: ${e?.message ?? e}`));
      if (await provider.connectContainer(mine.container_ref).catch(() => false)) {
        const sandbox = await provider.connectMount(mine.container_ref, mine.id, mine.workdir).catch(() => null);
        if (sandbox) return this.lease(provider, mine.id, { sandbox, containerRef: mine.container_ref, workdir: mine.workdir }, mine.status === "paused" ? "resumed" : "reused");
      }
      // stale mount: retire the row and fall through to make a fresh one
      await store.setStatus(mine.id, "destroyed");
    } else if (mine) {
      // conflict: another run holds this workspace's mount
      if (await store.findBusyByAffinity(name, req.affinity!)) throw new Error(`workspace ${req.affinity} is in use by another running session; retry when it is idle`);
      await store.setStatus(mine.id, "destroyed");
    } else if (req.affinity && (await store.findBusyByAffinity(name, req.affinity))) {
      throw new Error(`workspace ${req.affinity} is in use by another running session; retry when it is idle`);
    }

    // 2. Find (or open) the container for this key, then add a mount for this workspace.
    let containerRef: string | null = null;
    let origin: SandboxLease["origin"] = "created";
    const sibling = await store.findContainer(name, containerKey);
    if (sibling?.container_ref) {
      if (sibling.status === "paused") await provider.resume?.(sibling.container_ref).catch(() => {});
      if (await provider.connectContainer(sibling.container_ref).catch(() => false)) { containerRef = sibling.container_ref; origin = "shared"; }
    }
    const id = newId("sbx");
    await store.insert({ id, provider: name, status: "busy", workspace_id: req.workspaceId, affinity: req.affinity ?? null, external_ref: null, container_key: containerKey, container_ref: containerRef, workdir: null });
    try {
      if (!containerRef) containerRef = await provider.openContainer(id, req);
      const handle = await provider.addMount(containerRef, id, req.workspaceRef);
      await store.setMount(id, containerRef, handle.workdir);
      return this.lease(provider, id, handle, origin);
    } catch (e) {
      // if we opened a fresh container just for this mount, tear it down; a shared one stays for its other mounts
      if (containerRef && origin === "created") await provider.destroyContainer(containerRef).catch(() => {});
      await store.setStatus(id, "destroyed");
      throw e;
    }
  }

  private lease(provider: SandboxProvider, id: SandboxId, handle: SandboxHandle, origin: SandboxLease["origin"]): SandboxLease {
    this.held.set(id, { provider, handle });
    return { sandbox: handle.sandbox, origin, release: async () => { this.held.delete(id); await store.setStatus(id, "ready"); } };
  }

  async capture(sb: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef> {
    const h = this.held.get(sb.id);
    if (!h) throw new Error(`sandbox ${sb.id} is not held by this process`);
    return h.provider.captureMount(h.handle.containerRef, sb.id, h.handle.workdir, prev);
  }

  list(): Promise<SandboxRow[]> { return store.list(); }
  get(id: SandboxId): Promise<SandboxRow | null> { return store.get(id); }

  /** Destroy one mount now; the container goes too once it holds no other live mount. */
  async destroy(id: SandboxId): Promise<boolean> {
    const row = await store.get(id);
    if (!row || row.status === "destroyed") return false;
    await this.dropMount(row);
    return true;
  }

  /** Remove a mount's workdir; if it was the container's last live mount, destroy the container. */
  private async dropMount(row: SandboxRow): Promise<void> {
    const provider = this.provider(row.provider);
    if (row.container_ref && row.workdir) await provider.removeMount(row.container_ref, row.id, row.workdir).catch(() => {});
    this.held.delete(row.id);
    await store.setStatus(row.id, "destroyed");
    if (row.container_ref) {
      const remaining = await store.mountsOf(row.container_ref);
      if (remaining.length === 0) await provider.destroyContainer(row.container_ref).catch((e) => console.error(`[reaper] destroy container ${row.container_ref} failed`, e));
    }
  }

  /**
   * Idle tiers at container granularity. A container whose every mount is idle past idleTtl is
   * paused (or, without pause support, destroyed). A container all of whose mounts are paused past
   * pausedTtl (or marked destroying, or abandoned by a dead runner) is destroyed.
   */
  async reap(idleTtlMs: number, pausedTtlMs: number): Promise<Record<SandboxProviderName, { paused: SandboxId[]; destroyed: SandboxId[] }>> {
    const out = {} as Record<SandboxProviderName, { paused: SandboxId[]; destroyed: SandboxId[] }>;
    for (const p of Object.values(this.providers)) {
      out[p.name] = { paused: [], destroyed: [] };
      // Group this provider's live rows by container.
      const rows = (await store.list()).filter((r) => r.provider === p.name && r.status !== "destroyed" && r.container_ref);
      const byContainer = new Map<string, SandboxRow[]>();
      for (const r of rows) (byContainer.get(r.container_ref!) ?? byContainer.set(r.container_ref!, []).get(r.container_ref!)!).push(r);
      const idleRows = new Set((await store.listIdle(p.name, idleTtlMs)).map((r) => r.id));
      const destroyRows = new Set((await store.listToDestroy(p.name, pausedTtlMs)).map((r) => r.id));
      for (const [containerRef, mounts] of byContainer) {
        const anyToDestroy = mounts.some((m) => destroyRows.has(m.id));
        const allPaused = mounts.every((m) => m.status === "paused");
        if (anyToDestroy && (allPaused || mounts.every((m) => destroyRows.has(m.id)))) {
          await p.destroyContainer(containerRef).catch((e) => console.error(`[reaper] ${p.name} destroy ${containerRef} failed`, e));
          for (const m of mounts) { this.held.delete(m.id); await store.setStatus(m.id, "destroyed"); out[p.name].destroyed.push(m.id); }
          continue;
        }
        // every mount ready and idle past ttl -> pause (or destroy without pause support)
        if (mounts.every((m) => m.status === "ready" && idleRows.has(m.id))) {
          if (p.pause) {
            try { await p.pause(containerRef); for (const m of mounts) { await store.setStatus(m.id, "paused"); out[p.name].paused.push(m.id); } continue; }
            catch (e) { console.error(`[reaper] ${p.name} pause ${containerRef} failed; destroying`, e); }
          }
          await p.destroyContainer(containerRef).catch(() => {});
          for (const m of mounts) { this.held.delete(m.id); await store.setStatus(m.id, "destroyed"); out[p.name].destroyed.push(m.id); }
        }
      }
    }
    return out;
  }
}
