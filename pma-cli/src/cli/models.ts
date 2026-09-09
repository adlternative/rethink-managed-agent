import { apiGet, type ModelInfo } from "../lib/client.ts";
import { table } from "../lib/args.ts";

export async function cmdModels(): Promise<void> {
  const { data } = (await apiGet("/models")) as { data: ModelInfo[] };
  table([["PROVIDER", "ID", "CONTEXT"], ...data.map((m) => [m.provider, m.id, String(m.context_window)])]);
}
