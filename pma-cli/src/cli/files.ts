import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiDelete, apiGet } from "../lib/client.ts";
import { resolveConfig, buildHeaders } from "../lib/config.ts";
import { die, parseArgs, printJson, table } from "../lib/args.ts";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv", ".ts": "text/plain", ".js": "text/plain", ".py": "text/plain" };
export const mimeOf = (p: string) => MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";

export async function uploadFile(p: string): Promise<{ id: string; filename: string; mime_type: string; size_bytes: number }> {
  const cfg = resolveConfig();
  const data = await readFile(p);
  const r = await fetch(`${cfg.host}/v1/files`, { method: "POST", headers: { ...buildHeaders(cfg), "content-type": mimeOf(p), "x-file-name": path.basename(p) }, body: data });
  const json = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${json?.error?.message ?? ""}`);
  return json;
}

export async function cmdFiles(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "upload":
      if (!a) die("usage: pma files upload <path>");
      return printJson(await uploadFile(a));
    case "list": case "ls": {
      const { data } = (await apiGet("/files")) as { data: any[] };
      table([["ID", "FILENAME", "MIME", "BYTES"], ...data.map((f) => [f.id, f.filename, f.mime_type, String(f.size_bytes)])]);
      return;
    }
    case "get":
      if (!a) die("usage: pma files get <id>");
      return printJson(await apiGet(`/files/${a}`));
    case "delete": case "rm":
      if (!a) die("usage: pma files delete <id>");
      return printJson(await apiDelete(`/files/${a}`));
    default:
      die("files subcommand: upload <path> | list | get <id> | delete <id>");
  }
}
