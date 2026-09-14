import type { IncomingMessage, ServerResponse } from "node:http";
import type { MiddlewareHandler } from "hono";
import { env } from "../shared/env.ts";
import { ApiError, errorResponse } from "./errors.ts";

/**
 * Request body size limit that keeps keep-alive connections healthy.
 *
 * The limit is enforced early on Content-Length and again while the body streams (chunked uploads carry
 * no length). Rejecting early means responding before the client finished sending, and on
 * @hono/node-server the request stream already exists by then (reading any header creates it), so Node's
 * own "dump the unread body" never runs: the rest of the upload would sit unread until the keep-alive
 * timeout destroys the socket — the uploading client gets EPIPE/ECONNRESET instead of the 413, and a
 * request it reuses the connection for is lost. So once the response is decided (413, 401 from auth, or a
 * handler that did not read its body), whatever is left of the body is read and dropped. Draining is
 * bounded by bytes and time; past either bound the connection is closed instead (an abusive or huge upload).
 */

export interface DrainOptions { maxBytes?: number; maxMs?: number }

/** Read and drop the rest of a body. "drained" = the connection stays usable; "gave_up" = it was closed. */
export async function discardRest(reader: ReadableStreamDefaultReader<Uint8Array>, opts: DrainOptions = {}): Promise<"drained" | "gave_up"> {
  const maxBytes = opts.maxBytes ?? env.API_DRAIN_MAX_BYTES;
  const maxMs = opts.maxMs ?? env.API_DRAIN_MAX_MS;
  let seen = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, maxMs);
  timer.unref?.();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return timedOut ? "gave_up" : "drained";
      seen += value.byteLength;
      // don't await: cancelling node-server's request stream can stay pending while the client is still writing
      if (seen > maxBytes) { void reader.cancel().catch(() => {}); return "gave_up"; }
    }
  } catch {
    return "gave_up"; // the client went away or the stream was torn down
  } finally {
    clearTimeout(timer);
  }
}

const tooLarge = (max: number) => new ApiError(413, "payload_too_large", `request body exceeds ${max} bytes`);

/** Enforce `maxFor(path)` on POST/PATCH/PUT bodies and drain unread leftovers once the response is decided. */
export function bodyLimit(maxFor: (path: string) => number): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST" && c.req.method !== "PATCH" && c.req.method !== "PUT") return next();
    const source = c.req.raw.body;
    if (!source) return next();
    const max = maxFor(c.req.path);
    const reader = source.getReader();
    let ended = false;
    let settled = false;
    // Cancelling the body stream only stops reading; closing a connection we gave up on needs the socket
    // (node-server bindings). Close it once the response is flushed so the client still gets its status.
    const node = c.env as { incoming?: IncomingMessage; outgoing?: ServerResponse } | undefined;
    const socket = node?.incoming?.socket; // captured now: Node detaches it from the request once the response ends
    const closeConnection = () => {
      if (!socket || socket.destroyed) return;
      const out = node?.outgoing;
      if (!out || out.writableFinished) socket.destroy();
      else { out.once("finish", () => socket.destroy()); out.once("close", () => socket.destroy()); }
    };
    const settle = () => {
      if (settled || ended) return;
      settled = true;
      // No socket (in-process request, another runtime): there is no connection to keep, so stop reading.
      if (!socket) return void reader.cancel().catch(() => {});
      void discardRest(reader).then((r) => { if (r === "gave_up") closeConnection(); });
    };

    if (Number(c.req.header("content-length") ?? 0) > max) { settle(); return errorResponse(c, tooLarge(max)); }
    let size = 0;
    const limited = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) { ended = true; return ctrl.close(); }
        size += value.byteLength;
        if (size > max) return ctrl.error(tooLarge(max)); // leftovers are drained by settle() after the 413
        ctrl.enqueue(value);
      },
      cancel() { /* the handler stopped reading: settle() drains what is left */ },
    });
    c.req.raw = new Request(c.req.raw, { body: limited, duplex: "half" } as RequestInit);
    try { await next(); } finally { settle(); }
  };
}
