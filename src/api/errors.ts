import type { Context } from "hono";

export class ApiError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
  }
}
export const notFound = (what: string, id: string) => new ApiError(404, "not_found_error", `${what} ${id} not found`);
export const invalid = (message: string) => new ApiError(400, "invalid_request_error", message);

export function errorResponse(c: Context, err: unknown): Response {
  const e = err instanceof ApiError ? err : new ApiError(500, "api_error", err instanceof Error ? err.message : String(err));
  if (e.status >= 500) console.error(err);
  return c.json({ type: "error", error: { type: e.type, message: e.message } }, e.status as 400);
}

export async function readJson<T>(c: Context): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    if (err instanceof ApiError) throw err; // e.g. the body-size guard aborting the stream
    throw invalid("body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalid("body must be a JSON object");
  return body as T;
}

/** An integer query parameter within [min, max]; absent -> `def`, anything else -> 400 (never NaN into SQL). */
export function queryInt(c: Context, name: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** Parse a multipart body; a malformed one is the client's fault (400), not a server error. */
export async function readForm(c: Context): Promise<FormData> {
  try {
    return await c.req.formData();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw invalid("body must be valid multipart/form-data");
  }
}

