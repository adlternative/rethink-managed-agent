/** Tiny flag parser: `--k v`, `--k=v`, `--flag`, `-x`. */
export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    } else if (a.startsWith("-") && a.length === 2) {
      flags[a.slice(1)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
export const str = (flags: Record<string, string | true>, k: string): string | undefined => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
export function die(msg: string, code = 1): never { console.error(msg); process.exit(code); }
export const printJson = (v: unknown) => console.log(JSON.stringify(v, null, 2));
export function table(rows: string[][]): void {
  if (rows.length === 0) return;
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  for (const r of rows) console.log(r.map((c, i) => (c ?? "").padEnd(w[i]!)).join("  ").trimEnd());
}
export const fmtTime = (iso: string) => iso.replace("T", " ").slice(0, 16);
