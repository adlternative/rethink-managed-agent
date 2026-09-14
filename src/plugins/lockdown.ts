/**
 * Network lockdown for the plugin host. Node 22's permission model covers fs / child processes /
 * workers / addons but not sockets, so before any plugin code loads we (1) refuse to resolve the
 * networking builtins for both ESM and CJS via the synchronous module hooks, and (2) replace and
 * freeze the global fetch/WebSocket. A plugin's only way to the network is then `ctx.fetch`, which
 * the runner serves under PLUGIN_FETCH_ALLOW.
 */
import { isBuiltin, registerHooks } from "node:module";

const BLOCKED = new Set([
  "net", "tls", "http", "https", "http2", "dgram", "dns", "dns/promises",
  "child_process", "worker_threads", "cluster", "inspector", "inspector/promises", "repl", "v8", "vm",
]);

/** A blocked builtin: the list above, or any internal "_"-prefixed one (_http_client, _tls_wrap, ...). */
function isBlocked(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return BLOCKED.has(bare) || (bare.startsWith("_") && isBuiltin(specifier));
}

export function lockdown(): void {
  const denied = (what: string) => new Error(`pma plugin host: module "${what}" is not available to plugins; use ctx.* capabilities`);
  registerHooks({
    resolve(specifier, context, next) {
      if (isBlocked(specifier)) throw denied(specifier);
      return next(specifier, context);
    },
  });
  // Side doors that skip the resolve hooks entirely.
  const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (getBuiltinModule) {
    Object.defineProperty(process, "getBuiltinModule", { value: (id: string) => { if (typeof id !== "string" || isBlocked(id)) throw denied(String(id)); return getBuiltinModule.call(process, id); }, writable: false, configurable: false });
  }
  for (const name of ["binding", "_linkedBinding"] as const) {
    Object.defineProperty(process, name, { value: (id: string) => { throw denied(`process.${name}(${String(id)})`); }, writable: false, configurable: false });
  }
  const deny = (name: string) => () => { throw new Error(`pma plugin host: global ${name} is not available to plugins; use ctx.fetch`); };
  for (const name of ["fetch", "WebSocket", "EventSource"] as const) {
    Object.defineProperty(globalThis, name, { value: deny(name), writable: false, configurable: false, enumerable: false });
  }
}
