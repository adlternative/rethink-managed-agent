import type { UiAPI } from "../src/ui-api.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** /bookmark [label] saves the current session; /bookmarks (or ctrl+b) picks one to resume. Local file only. */
const FILE = path.join(homedir(), ".pma", "bookmarks.json");
type Mark = { id: string; label: string; at: string };
const load = (): Mark[] => { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return []; } };
const save = (m: Mark[]) => { mkdirSync(path.dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(m, null, 2)); };

export default function (ui: UiAPI) {
  ui.registerCommand({
    name: "bookmark",
    description: "bookmark the current session: /bookmark [label]",
    handler(args, ctx) {
      if (!ctx.session) return ctx.note("no session to bookmark");
      const marks = load().filter((m) => m.id !== ctx.session!.id);
      marks.unshift({ id: ctx.session.id, label: args.trim() || ctx.session.agent.name, at: new Date().toISOString() });
      save(marks.slice(0, 50));
      ctx.note(`bookmarked ${ctx.session.id}${args.trim() ? ` as "${args.trim()}"` : ""}`);
    },
  });
  const pick = async (ctx: Parameters<UiAPI["registerShortcut"]>[0]["handler"] extends (c: infer C) => any ? C : never) => {
    const marks = load();
    if (!marks.length) return ctx.note("no bookmarks yet (/bookmark)");
    const id = await ctx.select("Bookmarks", marks.map((m) => ({ id: m.id, label: m.label, hint: `${m.id} · ${m.at.slice(0, 16).replace("T", " ")}` })));
    if (id) await ctx.openSession(id);
  };
  ui.registerCommand({ name: "bookmarks", description: "pick a bookmarked session to resume", handler: (_a, ctx) => pick(ctx) });
  ui.registerShortcut({ key: "ctrl+b", description: "open bookmarks", handler: (ctx) => pick(ctx) });
}
