/**
 * Module stand-ins for the api-* route tests, each shaped like the real module's exports so a test
 * can `vi.mock(path, async () => (await import("./fixtures/api-harness/fakes.ts")).<name>)`.
 * State lives in fake-db.ts `store`.
 */
import { newId } from "../../../src/shared/ids.ts";
import { publish } from "../../../src/infra/pubsub.ts";
import { store } from "./fake-db.ts";
import * as q from "../event-queries/index.ts";
import type { PrincipalResolver } from "../../../src/api/principal-resolver.ts";

type Row = Record<string, any>;

// Postgres rejects these LIMIT/bigint inputs; the fake throws the same way so a route that forwards them surfaces a 500.
function pgCheck(since: unknown, limit: unknown) {
  if (typeof since === "number" && Number.isNaN(since)) throw new Error(`invalid input syntax for type bigint: "NaN"`);
  if (typeof limit === "number" && Number.isNaN(limit)) throw new Error(`invalid input syntax for type bigint: "NaN"`);
  if (typeof limit === "number" && limit < 0) throw new Error("LIMIT must not be negative");
}

function appendRows(sessionId: string, payloads: Row[]): Row[] {
  const arr = store.events.get(sessionId) ?? [];
  const out = payloads.map((p) => { const e = { id: newId("evt"), session_id: sessionId, seq: arr.length + 1, type: p.type, payload: structuredClone(p), created_at: new Date().toISOString() }; arr.push(e); return e; });
  store.events.set(sessionId, arr); store.ops.push(`events.append:${payloads.map((p) => p.type).join(",")}`);
  return structuredClone(out);
}

export const events = {
  async withSession(sessionId: string, fn: (c: unknown, s: { status: string; idle_ms: number }) => Promise<unknown>) {
    const s = store.sessions.get(sessionId);
    if (!s) throw new Error(`session not found: ${sessionId}`);
    return fn({}, { status: s.status, idle_ms: 0 });
  },
  async appendIn(_c: unknown, sessionId: string, payloads: Row[]) { return appendRows(sessionId, payloads); },
  async setStatusIn(_c: unknown, sessionId: string, status: string) { store.sessions.get(sessionId)!.status = status; },
  async appendEvents(sessionId: string, payloads: Row[], opts: { publish?: boolean; status?: string } = {}) {
    if (!payloads.length) return [];
    const out = appendRows(sessionId, payloads);
    if (opts.status) store.sessions.get(sessionId)!.status = opts.status;
    if (opts.publish !== false) for (const event of out) await publish({ type: "event", event } as never);
    return out;
  },
  async listEvents(sessionId: string, opts: { since?: number; limit?: number } = {}) {
    const since = opts.since ?? 0; const limit = opts.limit ?? 10000;
    pgCheck(since, limit);
    return structuredClone((store.events.get(sessionId) ?? []).filter((e) => e.seq > since).slice(0, limit));
  },
  async listAllEvents(sessionId: string, _pageSize = 5000, since = 0) { return structuredClone((store.events.get(sessionId) ?? []).filter((e) => e.seq > since)); },
  async listEventsWindow(sessionId: string, opts: { since?: number; limit?: number } = {}) { return structuredClone(q.windowOf(store.events.get(sessionId) ?? [], opts)); },
  async lastSeq(sessionId: string) { return q.lastSeqOf(store.events.get(sessionId) ?? []); },
  async latestOfTypes(sessionId: string, types: string[]) { return structuredClone(q.latestOfTypesIn(store.events.get(sessionId) ?? [], types)); },
  async listEventsForState(sessionId: string, types: string[], toolNames: string[] = []) { return structuredClone(q.stateFilter(store.events.get(sessionId) ?? [], types, toolNames)); },
};

export const queue = {
  jobs: [] as Row[],
  async enqueueRun(job: Row) { queue.jobs.push(job); },
  async queueDepth() { return queue.jobs.length; },
  async consumeRuns() {},
};

export const leaseStore = {
  async getScoped(id: string, owner: string) { const r = store.sandboxes.get(id); return r && r.owner_id === owner ? structuredClone(r) : null; },
  async get(id: string) { return structuredClone(store.sandboxes.get(id)) ?? null; },
  async list(opts: { includeDestroyed?: boolean; owner?: string } = {}) {
    store.ops.push(`sandboxes.list:${JSON.stringify(opts)}`);
    return [...store.sandboxes.values()].filter((r) => (opts.includeDestroyed || r.status !== "destroyed") && (!opts.owner || r.owner_id === opts.owner)).map((r) => structuredClone(r));
  },
  async markForDestroy(id: string) {
    store.hooks.beforeMark?.(id);
    const r = store.sandboxes.get(id);
    if (!r || (r.status !== "ready" && r.status !== "paused")) return false;
    r.status = "destroying"; return true;
  },
  async markForPause(id: string) {
    store.hooks.beforeMark?.(id);
    const r = store.sandboxes.get(id);
    if (!r || r.status !== "ready") return false;
    r.paused_requested = true; return true;
  },
};

export const byoc = {
  WORKER_TTL_S: 60,
  async isWorkerAlive(envId: string, workerId: string) { return store.alive.has(`${envId}/${workerId}`); },
  async markWorkerAlive(envId: string, workerId: string) { store.alive.add(`${envId}/${workerId}`); },
  async anyWorkerAlive() { return store.alive.size > 0; },
  async pollForWorker(envId: string, workerId: string, ids: string[]) { store.pollCalls.push({ envId, workerId, ids }); return null; },
  async pushResult(res: unknown) { store.results.push(res); },
  async enqueue() {},
  async awaitResult() { throw new Error("not used"); },
  async workerFor() { return null; },
  newReqId: () => newId("req"),
};

export const blobs = {
  blobsConfigured: () => false,
  ensureBucket: async () => {},
  putBlob: async () => {},
  getBlob: async () => Buffer.alloc(0),
  deleteBlob: async () => {},
  blobStore: () => ({ configured: false }),
};

/** Test resolver: `x-as: <principal id>` authenticates as that principal (auto-provisioned); `x-org` sets the owner scope. */
export const headerResolver: PrincipalResolver = {
  async resolve(req) {
    const id = req.header("x-as");
    if (!id) return null;
    const actor = (store.principals.get(id) as never) ?? ({ id, kind: "user", handle: null, display_name: id, created_at: "" } as never);
    return { actor, owner: req.header("x-org") || undefined };
  },
};
