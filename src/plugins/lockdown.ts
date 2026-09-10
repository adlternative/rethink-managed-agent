/**
 * Network lockdown for the plugin host. Node 22's permission model covers fs / child processes /
 * workers / addons but not sockets, so before any plugin code loads we (1) refuse to resolve the
 * networking builtins for both ESM and CJS via the synchronous module hooks, and (2) replace and
 * freeze the global fetch/WebSocket. A plugin's only way to the network is then `ctx.fetch`, which
 * the runner serves under PLUGIN_FETCH_ALLOW.
 */
import { registerHooks } from "node:module";

const BLOCKED = new Set([
  "net", "tls", "http", "https", "http2", "dgram", "dns", "dns/promises",
  "child_process", "worker_threads", "cluster", "inspector", "inspector/promises", "repl", "v8", "vm",
]);

export function lockdown(): void {
  registerHooks({
    resolve(specifier, context, next) {
      const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
      if (BLOCKED.has(bare)) throw new Error(`pma plugin host: module "${specifier}" is not available to plugins; use ctx.* capabilities`);
      return next(specifier, context);
    },
  });
  const deny = (name: string) => () => { throw new Error(`pma plugin host: global ${name} is not available to plugins; use ctx.fetch`); };
  for (const name of ["fetch", "WebSocket", "EventSource"] as const) {
    Object.defineProperty(globalThis, name, { value: deny(name), writable: false, configurable: false, enumerable: false });
  }
}
