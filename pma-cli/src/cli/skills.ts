import { readFile } from "node:fs/promises";
import { apiDelete, apiGet, apiPost } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `skills subcommand:
  list
  get <id>
  create --file SKILL.md [--title T]            (frontmatter name/description + body)
  create --name N --description D --body B
  version <id> --file SKILL.md                  (new version; latest_version increments)
  delete <id>`;

async function body(flags: Record<string, string | true>) {
  const b: Record<string, unknown> = {};
  if (str(flags, "file")) b.markdown = await readFile(str(flags, "file")!, "utf8");
  if (str(flags, "title")) b.display_title = str(flags, "title");
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
      table([["ID", "TITLE", "NAME", "VER", "DESCRIPTION"], ...data.map((s) => [s.id, s.display_title, s.name, s.latest_version, s.description.slice(0, 60)])]);
      return;
    }
    case "get": if (!a) die(USAGE); return printJson(await apiGet(`/skills/${a}`));
    case "create": return printJson(await apiPost("/skills", await body(flags)));
    case "version": if (!a) die(USAGE); return printJson(await apiPost(`/skills/${a}/versions`, await body(flags)));
    case "delete": case "rm": if (!a) die(USAGE); return printJson(await apiDelete(`/skills/${a}`));
    default: die(USAGE);
  }
}
