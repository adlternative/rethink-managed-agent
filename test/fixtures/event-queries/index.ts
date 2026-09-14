/**
 * In-memory mirrors of the bounded event-log queries in src/infra/events.ts (same row selection and
 * order as the SQL). Route fakes use them, and the it-perf-queries test checks the SQL against them.
 */
type Ev = { seq: number; type: string; payload: any };

/** lastSeq: MAX(seq), 0 when empty. */
export const lastSeqOf = (events: Ev[]) => events.reduce((m, e) => Math.max(m, e.seq), 0);

/** listEventsForState: events of `types`, plus tool_use calls to `toolNames` and the tool_result rows answering them; payload.pi is dropped. */
export function stateFilter<E extends Ev>(events: E[], types: string[], toolNames: string[] = []): E[] {
  const names = new Set(toolNames);
  const calls = new Set(events.filter((e) => e.type === "agent.tool_use" && names.has(e.payload?.name)).map((e) => e.payload?.tool_use_id));
  return events
    .filter((e) => types.includes(e.type) || (names.size > 0 && ((e.type === "agent.tool_use" && names.has(e.payload?.name)) || (e.type === "agent.tool_result" && calls.has(e.payload?.tool_use_id)))))
    .sort((a, b) => a.seq - b.seq)
    .map((e) => (e.payload && "pi" in e.payload ? { ...e, payload: (({ pi: _pi, ...rest }) => rest)(e.payload) } : e));
}

/** latestOfTypes: the newest event of each type, in seq order. */
export function latestOfTypesIn<E extends Ev>(events: E[], types: string[]): E[] {
  const out = new Map<string, E>();
  for (const e of events) if (types.includes(e.type) && (!out.has(e.type) || out.get(e.type)!.seq < e.seq)) out.set(e.type, e);
  return [...out.values()].sort((a, b) => a.seq - b.seq);
}

/** listEventsWindow: seq > since, the newest `limit` when given. */
export function windowOf<E extends Ev>(events: E[], opts: { since?: number; limit?: number } = {}): E[] {
  const after = events.filter((e) => e.seq > (opts.since ?? 0)).sort((a, b) => a.seq - b.seq);
  return opts.limit === undefined ? after : opts.limit > 0 ? after.slice(-opts.limit) : [];
}

/** foldSince: the cursor before the latest compaction's min(first_kept_seq, own seq); 0 without one. */
export function foldSinceOf(events: Ev[]): number {
  let c: Ev | null = null;
  for (const e of events) if (e.type === "agent.thread_context_compacted" && (!c || e.seq > c.seq)) c = e;
  if (!c) return 0;
  const fk = c.payload?.first_kept_seq;
  return Math.max(0, Math.min(typeof fk === "number" && Number.isFinite(fk) ? fk : 0, c.seq) - 1);
}
