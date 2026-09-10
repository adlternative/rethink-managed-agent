import { apiDelete, apiGet, apiPost } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `memory-stores subcommand:
  list
  get <id>
  create <name> [--description D]     (mount into sessions: sessions create --memory-stores mem_a[:path],mem_b ; default path memories/<name>)
  delete <id>`;

export async function cmdMemoryStores(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/memory_stores")) as { data: any[] };
      table([["ID", "NAME", "DESCRIPTION", "REF", "UPDATED"], ...data.map((m) => [m.id, m.name, m.description.slice(0, 40), m.ref.kind, m.updated_at.slice(0, 16)])]);
      return;
    }
    case "get": if (!a) die(USAGE); return printJson(await apiGet(`/memory_stores/${a}`));
    case "create": if (!a) die(USAGE); return printJson(await apiPost("/memory_stores", { name: a, description: str(flags, "description") }));
    case "delete": case "rm": if (!a) die(USAGE); return printJson(await apiDelete(`/memory_stores/${a}`));
    default: die(USAGE);
  }
}
