import { apiGet } from "../lib/client.ts";
import { parseArgs, printJson, table } from "../lib/args.ts";

/** What this deployment ships, the source to attach, and where the allowlist lets each one run. */
export async function cmdPlugins(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub, q] = positional;
  const query = sub === "list" || sub === "ls" || sub === "search" ? q : sub; // `pma plugins <query>` searches
  const { data } = (await apiGet(`/plugins${query ? `?q=${encodeURIComponent(query)}` : ""}`)) as {
    data: { name: string; source: string; description: string; allowed: { runner: boolean; sandbox: boolean } }[];
  };
  if (flags.json) return printJson(data);
  if (!data.length) return console.log(query ? `no plugin matches "${query}"` : "(none)");
  table([
    ["NAME", "SOURCE", "RUNS ON", "DESCRIPTION"],
    ...data.map((p) => [p.name, p.source, [p.allowed.runner && "runner", p.allowed.sandbox && "sandbox"].filter(Boolean).join("+") || "blocked", p.description.slice(0, 60)]),
  ]);
}
