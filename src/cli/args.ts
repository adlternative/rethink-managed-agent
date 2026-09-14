/** Argument parsing shared by every CLI command. */

/** Flags that never take a value, so `send --wait sess_x hi` keeps its positionals. */
export const BOOLEAN_FLAGS = new Set(["wait", "json", "help", "all", "no-system", "no-auth", "value-stdin", "version"]);

export type Flags = Record<string, string | true>;

/** A misuse of the CLI (unknown command, missing argument): exit code 2, unlike API/network failures (1). */
export class UsageError extends Error {}

export function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; } // everything after `--` is positional
    if (a === "-h") { flags.help = true; continue; }
    if (!a.startsWith("--") || a === "--") { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else flags[name] = true;
  }
  return { positional, flags };
}

export const str = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);

export function need(flags: Flags, name: string, usage?: string): string {
  const v = flags[name];
  if (typeof v !== "string") throw new UsageError(`--${name} is required${usage ? `\n${usage}` : ""}`);
  return v;
}

export function int(flags: Flags, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return n;
}

export const list = (v: string | undefined): string[] | undefined => (v === undefined ? undefined : v.split(",").map((x) => x.trim()).filter(Boolean));

/** `provider/model-id` (the id may itself contain slashes). */
export function modelRef(spec: string): { provider: string; id: string } {
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1) throw new UsageError(`model must be provider/model-id, got ${JSON.stringify(spec)}`);
  return { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}
