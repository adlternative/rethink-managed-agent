/**
 * pi-ai model registry built from the `providers` table. Providers are data (api kind, base URL,
 * headers, model list, compat flags); credentials are env-var references resolved on the runner.
 */
import { createModels, createProvider, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { env } from "../shared/env.ts";
import type { ModelRef, ProviderResource } from "../shared/types.ts";

const APIS = {
  "openai-completions": () => openAICompletionsApi(),
  "openai-responses": () => openAIResponsesApi(),
  "anthropic-messages": () => anthropicMessagesApi(),
} as const;

/** The built-in Qoder proxy definition; seeded into the DB on first start and used when the table is empty. */
export function defaultProviders(): Omit<ProviderResource, "created_at" | "updated_at">[] {
  const ids = ["auto", "ultimate", "performance", "efficient", "lite", "cmodel", "kmodel", "gmodel", "qmodel"];
  const out: Omit<ProviderResource, "created_at" | "updated_at">[] = [{
    id: "qoder",
    name: "Qoder (local OpenAI-compatible proxy)",
    api: "openai-completions",
    base_url: env.QODER_BASE_URL,
    headers: {},
    // keyless proxy, but pi-ai's client refuses an empty key: QODER_API_KEY holds a placeholder
    auth: { type: "env", name: "QODER_API_KEY" },
    models: ids.map((id) => ({ id, name: `qoder/${id}`, context_window: id === "ultimate" || id === "cmodel" ? 1_000_000 : 200_000, max_tokens: 32_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } })),
    enabled: true,
  }];
  if (env.ANTHROPIC_API_KEY) {
    out.push({
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      base_url: "https://api.anthropic.com",
      headers: {},
      auth: { type: "env", name: "ANTHROPIC_API_KEY" },
      models: [
        { id: "claude-sonnet-4-6", context_window: 200_000, max_tokens: 64_000, input: ["text", "image"], reasoning: true, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
        { id: "claude-opus-4-6", context_window: 200_000, max_tokens: 32_000, input: ["text", "image"], reasoning: true, cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 } },
      ],
      enabled: true,
    });
  }
  return out;
}

function resolveKey(auth: ProviderResource["auth"]): string {
  if (auth.type === "none") return "none"; // pi-ai needs a non-empty string; proxies ignore it
  // QODER_API_KEY has a code default (the proxy ignores it); every other name must really be set.
  const v = process.env[auth.name] ?? (auth.name === "QODER_API_KEY" ? env.QODER_API_KEY : undefined);
  if (!v) throw new Error(`provider credential env var ${auth.name} is not set on the runner`);
  return v;
}

/** Build a pi-ai registry from provider rows (disabled rows are skipped; broken rows are logged and skipped). */
export function buildModelRegistry(providers: ProviderResource[]): Models {
  const models = createModels();
  for (const p of providers) {
    if (!p.enabled) continue;
    const makeApi = APIS[p.api];
    if (!makeApi) { console.warn(`[models] provider ${p.id}: unsupported api ${p.api}`); continue; }
    const list: Model<Api>[] = p.models.map((m) => ({
      id: m.id,
      name: m.name ?? `${p.id}/${m.id}`,
      api: p.api,
      provider: p.id,
      baseUrl: p.base_url,
      reasoning: m.reasoning ?? false,
      input: m.input ?? ["text"],
      cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cache_read ?? 0, cacheWrite: m.cost?.cache_write ?? 0 },
      contextWindow: m.context_window,
      maxTokens: m.max_tokens ?? 32_000,
      headers: Object.keys(p.headers).length ? p.headers : undefined,
      compat: m.compat as Model<Api>["compat"],
    }));
    models.setProvider(
      createProvider({
        id: p.id,
        name: p.name,
        baseUrl: p.base_url,
        auth: { apiKey: { name: p.name, resolve: async () => ({ auth: { apiKey: resolveKey(p.auth) }, source: p.auth.type === "env" ? p.auth.name : "none" }) } },
        models: list,
        api: makeApi() as never,
      }),
    );
  }
  return models;
}

/** Registry from the built-in defaults only (used by tests and as a fallback before the DB is seeded). */
export function createModelRegistry(): Models {
  const now = new Date().toISOString();
  return buildModelRegistry(defaultProviders().map((p) => ({ ...p, created_at: now, updated_at: now })));
}

export function resolveModel(models: Models, ref: ModelRef): Model<any> {
  const model = models.getModel(ref.provider, ref.id);
  if (!model) {
    const known = models.getModels().map((m) => `${m.provider}/${m.id}`).join(", ");
    throw new Error(`Unknown model ${ref.provider}/${ref.id}. Known models: ${known || "(none)"}`);
  }
  return model;
}
