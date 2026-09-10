import type { UiAPI } from "../src/ui-api.ts";

/** Nicer tool rows: write/edit show the content they touch, bash shows the command and exit hint. */
export default function (ui: UiAPI) {
  const head = (s: string, n: number) => s.split("\n").slice(0, n);
  ui.registerToolRenderer("write", (input, result, ctx) => {
    const content = String(input?.content ?? "");
    const lines = ctx.expanded ? content.split("\n") : head(content, 4);
    return { title: `write ${input?.path} (${content.length} chars)`, lines: [...lines.map((l) => `│ ${l}`), ...(result ? [result] : [])] };
  });
  ui.registerToolRenderer("edit", (input, result) => ({
    title: `edit ${input?.path}`,
    lines: [...head(String(input?.oldText ?? ""), 2).map((l) => `- ${l}`), ...head(String(input?.newText ?? ""), 2).map((l) => `+ ${l}`), ...(result ? [result] : [])],
  }));
  ui.registerToolRenderer("bash", (input, result, ctx) => {
    const cmd = String(input?.command ?? "");
    const out = (result ?? "").split("\n");
    return { title: `$ ${cmd.split("\n")[0]}${cmd.includes("\n") ? " …" : ""}`, lines: ctx.expanded ? out : out.slice(0, 5).concat(out.length > 5 ? [`… ${out.length - 5} more lines (ctrl+o)`] : []) };
  });
}
