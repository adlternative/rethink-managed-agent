#!/usr/bin/env node
// pma CLI entry point. Usage: npm run cli -- <command> [args] [--flag value | --flag=value]; see HELP in commands.ts.
import { pathToFileURL } from "node:url";
import { run } from "./commands.ts";
import { Client, resolveConfig } from "./http.ts";

export { parse } from "./args.ts";
export { authHeaders, resolveConfig } from "./http.ts";
export { makePrinter, waitOutcome } from "./format.ts";
export { run } from "./commands.ts";

/** JSON request against the API configured by the environment (PMA_API / PMA_API_KEY). */
export const api = (method: string, path: string, body?: unknown): Promise<any> => new Client(resolveConfig()).json(method, path, body);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env: process.env, readStdin })
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
}
