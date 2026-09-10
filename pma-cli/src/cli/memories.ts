import { apiDelete, apiGet, apiPost } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `memories subcommand:
  list
  get <id>
  create <name> [--description D]     (mounted into sessions at .memory/<name>; pass --memories id,id to sessions create)
  delete <id>`;

export async function cmdMemories(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/memories")) as { data: any[] };
      table([["ID", "NAME", "DESCRIPTION", "REF", "UPDATED"], ...data.map((m) => [m.id, m.name, m.description.slice(0, 40), m.ref.kind, m.updated_at.slice(0, 16)])]);
      return;
    }
    case "get": if (!a) die(USAGE); return printJson(await apiGet(`/memories/${a}`));
    case "create": if (!a) die(USAGE); return printJson(await apiPost("/memories", { name: a, description: str(flags, "description") }));
    case "delete": case "rm": if (!a) die(USAGE); return printJson(await apiDelete(`/memories/${a}`));
    default: die(USAGE);
  }
}
