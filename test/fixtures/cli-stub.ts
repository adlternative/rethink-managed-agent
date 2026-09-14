/** A scriptable HTTP stub of the pma API (node:http on an ephemeral port) plus an in-process CLI runner. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { run } from "../../src/cli/commands.ts";

export interface Recorded { method: string; path: string; headers: IncomingMessage["headers"]; body: string; json?: any }
export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

export async function startStub(handler: Handler): Promise<{ url: string; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const r: Recorded = { method: req.method!, path: req.url!, headers: req.headers, body };
    try { r.json = body ? JSON.parse(body) : undefined; } catch { /* raw body */ }
    requests.push(r);
    try { await handler(r, res); } catch (e) { if (!res.headersSent) res.writeHead(500); res.end(String(e)); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export const sendJson = (res: ServerResponse, status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
export const apiError = (res: ServerResponse, status: number, type: string, message: string) => sendJson(res, status, { type: "error", error: { type, message } });
export const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** Run the CLI in-process against `url`; captures stdout/stderr and the exit code. */
export async function cli(url: string, argv: string[], env: Record<string, string> = {}, stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, env: { PMA_API: url, ...env }, readStdin: async () => stdin });
  return { code, stdout, stderr };
}
