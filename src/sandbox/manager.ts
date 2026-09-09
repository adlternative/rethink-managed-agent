import { newId } from "../shared/ids.ts";
import type {
  Sandbox, SandboxHandle, SandboxId, SandboxLease, SandboxProvider, SandboxProviderName, SandboxRequest, SandboxRow, SandboxService, WorkspaceRef,
} from "../shared/types.ts";
import * as store from "./lease-store.ts";

/**
 * Policy layer over the providers: owns the sandboxes table (leases), affinity reuse, the
 * "one live lease per workspace" rule (DESIGN §5), and reaping. Providers only know how to
 * start / re-attach / destroy / move files. This is the boundary a future sandboxd service would sit on.
 */
export class SandboxManager {
  /** Handles acquired by this process; capture() needs the live handle, not just the row. */
  private held = new Map<SandboxId, { provider: SandboxProvider; handle: SandboxHandle }>();

  constructor(private providers: Record<SandboxProviderName, SandboxProvider>) {}

  provider(name: SandboxProviderName): SandboxProvider {
    const p = this.providers[name];
    if (!p) throw new Error(`unknown sandbox provider: ${name}`);
    return p;
  }

  /** The narrow view the harness gets: acquire + capture for one provider. */
  bind(name: SandboxProviderName): SandboxService {
    return {
      acquire: (req) => this.acquire(name, req),
      capture: (sb, prev) => this.capture(sb, prev),
    };
  }

  async acquire(name: SandboxProviderName, req: SandboxRequest): Promise<SandboxLease> {
    const provider = this.provider(name);
    let id: SandboxId;
    let handle: SandboxHandle | null = null;

    // 1. Reuse: a ready sandbox with the same affinity (row atomically flipped to busy).
    const reused = req.affinity ? await store.findReadyByAffinity(name, req.affinity) : null;
    if (reused?.external_ref) handle = await provider.connect(reused.id, reused.external_ref).catch(() => null);
    if (reused && handle) {
      id = reused.id;
    } else {
      // Stale row (dir wiped, container gone, remote sandbox expired): retire it.
      if (reused) {
        await provider.destroy(reused.id, reused.external_ref).catch(() => {});
        await store.setStatus(reused.id, "destroyed");
      }
      // 2. Conflict: another session holds a live lease on this workspace.
      if (req.affinity && (await store.findBusyByAffinity(name, req.affinity))) {
        throw new Error(`workspace ${req.affinity} is in use by another running session; retry when it is idle`);
      }
      // 3. Create. Row first (busy, no ref) so a crash mid-create still leaves a record the reaper retires.
      id = newId("sbx");
      await store.insert({ id, provider: name, status: "busy", workspace_id: req.workspaceId, affinity: req.affinity ?? null, external_ref: null });
      try {
        handle = await provider.create(id, req);
        await store.setExternalRef(id, handle.externalRef);
      } catch (e) {
        await provider.destroy(id, handle?.externalRef ?? null).catch(() => {});
        await store.setStatus(id, "destroyed");
        throw e;
      }
    }
    this.held.set(id, { provider, handle });
    return {
      sandbox: handle.sandbox,
      release: async () => {
        this.held.delete(id);
        await store.setStatus(id, "ready");
      },
    };
  }

  async capture(sb: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef> {
    const h = this.held.get(sb.id);
    if (!h) throw new Error(`sandbox ${sb.id} is not held by this process`);
    return h.provider.capture(h.handle, prev);
  }

  list(): Promise<SandboxRow[]> {
    return store.list();
  }

  get(id: SandboxId): Promise<SandboxRow | null> {
    return store.get(id);
  }

  /** Destroy one sandbox now (runner-side; the API uses store.markForDestroy instead). */
  async destroy(id: SandboxId): Promise<boolean> {
    const row = await store.get(id);
    if (!row || row.status === "destroyed") return false;
    await this.provider(row.provider).destroy(row.id, row.external_ref).catch(() => {});
    this.held.delete(id);
    await store.setStatus(id, "destroyed");
    return true;
  }

  /** Destroy sandboxes idle past the ttl (plus busy ones abandoned by a dead runner), across all providers. */
  async reap(idleTtlMs: number): Promise<Record<SandboxProviderName, SandboxId[]>> {
    const out = {} as Record<SandboxProviderName, SandboxId[]>;
    for (const p of Object.values(this.providers)) {
      out[p.name] = [];
      for (const r of await store.listIdle(p.name, idleTtlMs)) {
        await p.destroy(r.id, r.external_ref).catch((e) => console.error(`[reaper] ${p.name} destroy ${r.id} failed`, e));
        this.held.delete(r.id);
        await store.setStatus(r.id, "destroyed");
        out[p.name].push(r.id);
      }
    }
    return out;
  }
}
