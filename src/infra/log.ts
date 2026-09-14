/**
 * Structured JSON logging. One line per event, machine-parseable, with a bound context (service,
 * request id, session, principal). Use `log.child({...})` to bind context for a request or a run.
 * Set LOG_LEVEL=debug|info|warn|error (default info) and LOG_FORMAT=json|pretty (default json).
 */
import { env } from "../shared/env.ts";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(env.LOG_LEVEL as Level) in ORDER ? (env.LOG_LEVEL as Level) : "info"];

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}

/** JSON that never throws: BigInt becomes a string, a repeated (circular) object becomes "[Circular]". */
function safeJson(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(v, (_k, x) => {
      if (typeof x === "bigint") return x.toString();
      if (x && typeof x === "object") { if (seen.has(x)) return "[Circular]"; seen.add(x); }
      return x;
    }) ?? String(v);
  } catch (e) { return JSON.stringify({ log_error: String(e) }); }
}

function make(ctx: Record<string, unknown>): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    // level, msg and ts are the record's own: context/fields cannot override them
    const rec = { ...ctx, ...fields, level, msg, ts: new Date().toISOString() };
    if (env.LOG_FORMAT === "pretty") {
      const extra = Object.entries({ ...ctx, ...fields }).map(([k, v]) => `${k}=${typeof v === "string" ? v : safeJson(v)}`).join(" ");
      (level === "error" ? console.error : console.log)(`${rec.ts} ${level.toUpperCase()} ${msg}${extra ? " " + extra : ""}`);
    } else {
      (level === "error" ? console.error : console.log)(safeJson(rec));
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => make({ ...ctx, ...extra }),
  };
}

export const log = make({});
