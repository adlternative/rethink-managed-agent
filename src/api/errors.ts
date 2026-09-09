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
  try {
    return (await c.req.json()) as T;
  } catch {
    throw invalid("body must be valid JSON");
  }
}
