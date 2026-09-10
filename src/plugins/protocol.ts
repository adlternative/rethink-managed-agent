/**
 * JSON-RPC-ish line protocol between the runner and a plugin host process (stdio, one JSON per line).
 * Both sides can send requests; every request gets exactly one response.
 */
import type { HookEvent, PackageManifest } from "./api.ts";

export interface Req { id: number; method: string; params: unknown }
export interface Res { id: number; result?: unknown; error?: { message: string; stack?: string } }
export type Frame = Req | Res;

// runner -> host
export interface HostMethods {
  /** Load packages; returns registered tools (schemas) and hooks present. */
  load: { params: { packages: PackageManifest[] }; result: { tools: { name: string; description: string; parameters: unknown; source: string }[]; hooks: string[]; warnings: string[] } };
  "tool.execute": { params: { session: SessionInfo; name: string; input: unknown }; result: { content: { type: "text"; text: string }[]; isError?: boolean } };
  "hook.emit": { params: { session: SessionInfo; event: HookEvent }; result: unknown };
}
// host -> runner (capability calls). `session` identifies which run they belong to.
export interface RunnerMethods {
  "sandbox.exec": { params: { session: SessionInfo; command: string; cwd?: string; timeoutMs?: number }; result: { stdout: string; stderr: string; code: number } };
  "sandbox.readFile": { params: { session: SessionInfo; path: string }; result: string };
  "sandbox.writeFile": { params: { session: SessionInfo; path: string; content: string }; result: null };
  "store.get": { params: { session: SessionInfo; key: string; scope: "agent" | "workspace" }; result: unknown };
  "store.set": { params: { session: SessionInfo; key: string; scope: "agent" | "workspace"; value: unknown }; result: null };
  "model.complete": { params: { session: SessionInfo; prompt: string; system?: string; maxTokens?: number }; result: string };
  "agent.run": { params: { session: SessionInfo; task: string; system?: string; maxTurns?: number; tools?: string[] }; result: string };
  fetch: { params: { session: SessionInfo; url: string; method?: string; headers?: Record<string, string>; body?: string }; result: { status: number; headers: Record<string, string>; body: string } };
  log: { params: { session: SessionInfo; args: unknown[] }; result: null };
}
export interface SessionInfo { sessionId: string; agentId: string; workspaceId: string }

export function encode(f: Frame): string {
  return JSON.stringify(f) + "\n";
}

/** Minimal duplex RPC over line streams. */
export class Rpc {
  private next = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private buf = "";
  private write: (line: string) => void;
  private handle: (method: string, params: unknown) => Promise<unknown>;
  // no parameter properties: this file runs under Node's native type stripping in the plugin host
  constructor(write: (line: string) => void, handle: (method: string, params: unknown) => Promise<unknown>) {
    this.write = write;
    this.handle = handle;
  }

  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) void this.onFrame(JSON.parse(line) as Frame);
    }
  }

  private async onFrame(f: Frame): Promise<void> {
    if ("method" in f) {
      try {
        const result = await this.handle(f.method, f.params);
        this.write(encode({ id: f.id, result: result ?? null }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.write(encode({ id: f.id, error: { message: err.message, stack: err.stack } }));
      }
      return;
    }
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    if (f.error) p.reject(Object.assign(new Error(f.error.message), { remoteStack: f.error.stack }));
    else p.resolve(f.result);
  }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write(encode({ id, method, params }));
    });
  }

  /** Fail every in-flight call (host died). */
  abortAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}
