/**
 * pi-ai model registry built from the `providers` table. Providers are data (api kind, base URL,
 * headers, model list, compat flags); credentials are env-var references resolved on the runner.
 */
import { createModels, createProvider, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { env } from "../shared/env.ts";
import { open as unseal } from "../infra/secrets.ts";
import type { ModelRef, ProviderResource } from "../shared/types.ts";

const APIS = {
  "openai-completions": () => openAICompletionsApi(),
  "openai-responses": () => openAIResponsesApi(),
  "anthropic-messages": () => anthropicMessagesApi(),
} as const;

/**
 * Provider rows owned by the operator (the seed owner / dev default principal) are shared by every
 * tenant and may reference runner env vars; any other row is private to its owner and BYOK/none only.
 */
export function isOperatorOwner(owner: string | undefined): boolean {
  return owner === "prc_local" || owner === env.PMA_DEFAULT_PRINCIPAL;
}

/** Owner of each provider id in a registry built by buildModelRegistry (for per-tenant access checks). */
const registryOwners = new WeakMap<Models, Map<string, string>>();

/** The built-in Qoder proxy definition; seeded into the DB on first start and used when the table is empty. */
export function defaultProviders(): Omit<ProviderResource, "created_at" | "updated_at">[] {
  const ids = ["auto", "ultimate", "performance", "efficient", "lite", "cmodel", "kmodel", "gmodel", "qmodel"];
  const out: Omit<ProviderResource, "created_at" | "updated_at">[] = [{
    id: "qoder",
    owner_id: "prc_local",
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
      owner_id: "prc_local",
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

function resolveKey(auth: ProviderResource["auth"], owner: string): string {
  if (auth.type === "none") return "none"; // pi-ai needs a non-empty string; proxies ignore it
  if (auth.type === "encrypted") return unseal(auth); // BYOK: sealed with PMA_SECRET_KEY
  // a tenant-created row must not name runner secrets (PMA_SECRET_KEY, ANTHROPIC_API_KEY, ...)
  if (!isOperatorOwner(owner)) throw new Error(`provider auth type 'env' is only available to operator-owned providers`);
  // QODER_API_KEY has a code default (the proxy ignores it); every other name must really be set.
  const v = process.env[auth.name] ?? (auth.name === "QODER_API_KEY" ? env.QODER_API_KEY : undefined);
  if (!v) throw new Error(`provider credential env var ${auth.name} is not set on the runner`);
  return v;
}

/** Build a pi-ai registry from provider rows (disabled rows are skipped; broken rows are logged and skipped). */
export function buildModelRegistry(providers: ProviderResource[]): Models {
  const models = createModels();
  const owners = new Map<string, string>();
  registryOwners.set(models, owners);
  for (const p of providers) {
    if (!p.enabled) continue;
    const makeApi = APIS[p.api];
    if (!makeApi) { console.warn(`[models] provider ${p.id}: unsupported api ${p.api}`); continue; }
    try {
      if (!p.base_url || !Array.isArray(p.models) || (p.headers !== undefined && (p.headers === null || typeof p.headers !== "object")) || !p.auth) throw new Error("malformed row");
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
        headers: p.headers && Object.keys(p.headers).length ? p.headers : undefined,
        compat: m.compat as Model<Api>["compat"],
      }));
      models.setProvider(
        createProvider({
          id: p.id,
          name: p.name,
          baseUrl: p.base_url,
          auth: { apiKey: { name: p.name, resolve: async () => ({ auth: { apiKey: resolveKey(p.auth, p.owner_id) }, source: p.auth.type === "env" ? p.auth.name : p.auth.type }) } },
          models: list,
          api: makeApi() as never,
        }),
      );
      owners.set(p.id, p.owner_id);
    } catch (e) {
      console.warn(`[models] provider ${p.id}: skipped (${e instanceof Error ? e.message : e})`);
    }
  }
  return models;
}

/** Registry from the built-in defaults only (used by tests and as a fallback before the DB is seeded). */
export function createModelRegistry(): Models {
  const now = new Date().toISOString();
  return buildModelRegistry(defaultProviders().map((p) => ({ ...p, created_at: now, updated_at: now })));
}

/**
 * Resolve an agent's model. With `owner`, a provider owned by another tenant is treated as unknown
 * (a tenant must never run on someone else's BYOK key).
 */
export function resolveModel(models: Models, ref: ModelRef, owner?: string): Model<any> {
  const providerOwner = registryOwners.get(models)?.get(ref.provider);
  const hidden = owner !== undefined && providerOwner !== undefined && providerOwner !== owner && !isOperatorOwner(providerOwner);
  const model = hidden ? undefined : models.getModel(ref.provider, ref.id);
  if (!model) {
    const known = models.getModels().map((m) => `${m.provider}/${m.id}`).join(", ");
    throw new Error(`Unknown model ${ref.provider}/${ref.id}. Known models: ${known || "(none)"}`);
  }
  return model;
}
