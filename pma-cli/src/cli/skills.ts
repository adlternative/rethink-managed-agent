import { readFile } from "node:fs/promises";
import { apiDelete, apiGet, apiPost, apiRequest } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `skills subcommand:
  list
  get <id>
  create --file SKILL.md            (frontmatter name/description + body)
  create --name N --description D --body B
  update <id> [--file SKILL.md | --name N --description D --body B]
  delete <id>`;

async function body(flags: Record<string, string | true>) {
  const b: Record<string, unknown> = {};
  if (str(flags, "file")) b.markdown = await readFile(str(flags, "file")!, "utf8");
  if (str(flags, "name")) b.name = str(flags, "name");
  if (str(flags, "description")) b.description = str(flags, "description");
  if (str(flags, "body")) b.body = str(flags, "body");
  return b;
}

export async function cmdSkills(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/skills")) as { data: any[] };
      table([["ID", "NAME", "DESCRIPTION"], ...data.map((s) => [s.id, s.name, s.description.slice(0, 70)])]);
      return;
    }
    case "get": if (!a) die(USAGE); return printJson(await apiGet(`/skills/${a}`));
    case "create": return printJson(await apiPost("/skills", await body(flags)));
    case "update": if (!a) die(USAGE); return printJson(await apiRequest("PATCH", `/skills/${a}`, await body(flags)));
    case "delete": case "rm": if (!a) die(USAGE); return printJson(await apiDelete(`/skills/${a}`));
    default: die(USAGE);
  }
}
