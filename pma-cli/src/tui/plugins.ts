/** Loader + registry for UI plugins (see ../ui-api.ts). */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../lib/config.ts";
import type { SessionEvent } from "../lib/client.ts";
import type { ToolRender, UiAPI, UiCommand, UiContext, UiPluginFactory, UiShortcut } from "../ui-api.ts";

export interface UiRegistry {
  commands: Map<string, UiCommand & { source: string }>;
  shortcuts: Map<string, UiShortcut & { source: string }>; // key normalized: "ctrl+g"
  status: Map<string, (ctx: UiContext) => string | null>;
  toolRenderers: Map<string, (input: any, result: string | undefined, ctx: UiContext) => ToolRender | null>;
  eventRenderers: Map<string, (payload: any, event: SessionEvent, ctx: UiContext) => string | null>;
  listeners: Map<string, ((event: SessionEvent, ctx: UiContext) => void)[]>;
  loaded: { source: string; error?: string }[];
}

export const normalizeKey = (k: string) => k.toLowerCase().split("+").map((s) => s.trim()).sort((a, b) => (a.length === 1 ? 1 : b.length === 1 ? -1 : a.localeCompare(b))).join("+");

export function keyOf(input: string, key: { ctrl?: boolean; meta?: boolean; shift?: boolean }): string | null {
  if (!input || input.length !== 1 || !/[a-z]/i.test(input)) return null;
  const mods = [key.ctrl && "ctrl", key.meta && "meta", key.shift && "shift"].filter(Boolean) as string[];
  if (mods.length === 0) return null;
  return normalizeKey([...mods, input.toLowerCase()].join("+"));
}

function pluginFiles(): string[] {
  const dirs = [path.join(homedir(), ".pma", "plugins")];
  const extra = (loadConfig() as { ui_plugins?: string[] }).ui_plugins ?? [];
  const files: string[] = [];
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) if (/\.(ts|js|mjs)$/.test(f)) files.push(path.join(d, f));
    } catch { /* no dir */ }
  }
  for (const p of extra) {
    try {
      const abs = p.startsWith("~") ? path.join(homedir(), p.slice(1)) : path.resolve(p);
      if (statSync(abs).isDirectory()) for (const f of readdirSync(abs)) { if (/\.(ts|js|mjs)$/.test(f)) files.push(path.join(abs, f)); }
      else files.push(abs);
    } catch { /* missing */ }
  }
  return files;
}

export async function loadUiPlugins(): Promise<UiRegistry> {
  const reg: UiRegistry = { commands: new Map(), shortcuts: new Map(), status: new Map(), toolRenderers: new Map(), eventRenderers: new Map(), listeners: new Map(), loaded: [] };
  for (const file of pluginFiles()) {
    const source = path.basename(file).replace(/\.(ts|js|mjs)$/, "");
    const api: UiAPI = {
      registerCommand: (c) => reg.commands.set(c.name.replace(/^\//, ""), { ...c, source }),
      registerShortcut: (s) => reg.shortcuts.set(normalizeKey(s.key), { ...s, source }),
      registerStatus: (id, render) => reg.status.set(`${source}:${id}`, render),
      registerToolRenderer: (name, render) => reg.toolRenderers.set(name, render),
      registerEventRenderer: (type, render) => reg.eventRenderers.set(type, render),
      on: (type, handler) => reg.listeners.set(type, [...(reg.listeners.get(type) ?? []), handler]),
    };
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: UiPluginFactory };
      if (typeof mod.default !== "function") throw new Error("must default-export (ui) => void");
      await mod.default(api);
      reg.loaded.push({ source });
    } catch (e: any) {
      reg.loaded.push({ source, error: e?.message ?? String(e) });
    }
  }
  return reg;
}

export function emitUiEvent(reg: UiRegistry, event: SessionEvent, ctx: UiContext): void {
  for (const h of [...(reg.listeners.get(event.type) ?? []), ...(reg.listeners.get("*") ?? [])]) {
    try { h(event, ctx); } catch (e: any) { ctx.note(`✗ ui plugin listener failed: ${e?.message ?? e}`); }
  }
}
