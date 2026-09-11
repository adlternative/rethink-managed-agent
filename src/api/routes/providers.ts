import { Hono } from "hono";
import { repos } from "../../infra/db.ts";
import { publishProvidersChanged } from "../../infra/pubsub.ts";
import { defaultProviders } from "../../harness/models.ts";
import { seal, secretsConfigured } from "../../infra/secrets.ts";
import type { ProviderApi, ProviderAuth, ProviderModel, ProviderResource } from "../../shared/types.ts";
import { ApiError, invalid, notFound, readJson } from "../errors.ts";
import { scope, ownerId } from "../auth.ts";

const APIS: ProviderApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function validate(body: Record<string, unknown>, owner: string, existing?: ProviderResource): Omit<ProviderResource, "created_at" | "updated_at"> {
  const id = (body.id ?? existing?.id) as string | undefined;
  if (!id || !ID_RE.test(id)) throw invalid(`id must match ${ID_RE}`);
  const api = (body.api ?? existing?.api) as ProviderApi | undefined;
  if (!api || !APIS.includes(api)) throw invalid(`api must be one of ${APIS.join(" | ")}`);
  const base_url = (body.base_url ?? existing?.base_url) as string | undefined;
  if (!base_url || !/^https?:\/\//.test(base_url)) throw invalid("base_url must be an http(s) URL");
  const authIn = (body.auth ?? existing?.auth ?? { type: "none" }) as ProviderAuth | { type: "key"; key: string };
  let auth: ProviderAuth;
  if (authIn.type === "key") {
    // BYOK: seal the user's key now; the plaintext never reaches the DB or a later response.
    if (typeof authIn.key !== "string" || !authIn.key.trim()) throw invalid("auth.key must be a non-empty string");
    if (!secretsConfigured()) throw invalid("storing keys needs PMA_SECRET_KEY on the api and runner; use auth {type:'env', name} instead");
    auth = seal(authIn.key.trim());
  } else if (authIn.type === "env") {
    if (!/^[A-Z][A-Z0-9_]*$/.test(authIn.name ?? "")) throw invalid("auth.name must be an env var name");
    auth = authIn;
  } else if (authIn.type === "none" || authIn.type === "encrypted") auth = authIn;
  else throw invalid("auth.type must be 'key' (BYOK, sealed at rest) | 'env' | 'none'");
  const models = (body.models ?? existing?.models ?? []) as ProviderModel[];
  if (!Array.isArray(models) || models.some((m) => !m || typeof m.id !== "string" || typeof m.context_window !== "number")) throw invalid("models must be [{id, context_window, ...}]");
  const headers = (body.headers ?? existing?.headers ?? {}) as Record<string, string>;
  if (typeof headers !== "object" || Object.values(headers).some((v) => typeof v !== "string")) throw invalid("headers must be a string map");
  return { id, owner_id: existing?.owner_id ?? owner, name: String(body.name ?? existing?.name ?? id), api, base_url, headers, auth, models, enabled: (body.enabled ?? existing?.enabled ?? true) as boolean };
}

/** First start: seed the built-in definitions so existing agents (model qoder/…) keep working. */
export async function seedProviders(): Promise<void> {
  if ((await repos.providers.list()).length > 0) return;
  for (const p of defaultProviders()) await repos.providers.upsert(p);
  await publishProvidersChanged();
  console.log("[providers] seeded defaults:", defaultProviders().map((p) => p.id).join(", "));
}

/** Never return sealed material. */
const mask = (p: ProviderResource): ProviderResource => (p.auth.type === "encrypted" ? { ...p, auth: { type: "encrypted", v: 1, iv: "", ct: "", tag: "" } } : p);

export const providers = new Hono()
  .get("/", async (c) => c.json({ data: (await repos.providers.list(scope(c))).map(mask) }))
  .get("/:id", async (c) => {
    const p = await repos.providers.get(c.req.param("id"), scope(c));
    if (!p) throw notFound("provider", c.req.param("id"));
    return c.json(mask(p));
  })
  .post("/", async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    if (typeof body.id === "string" && (await repos.providers.get(body.id))) throw new ApiError(409, "already_exists", `provider ${body.id} exists; use PATCH`); // global id namespace
    const p = await repos.providers.upsert(validate(body, ownerId(c)));
    await publishProvidersChanged();
    return c.json(mask(p), 201);
  })
  .patch("/:id", async (c) => {
    const existing = await repos.providers.get(c.req.param("id"), scope(c));
    if (!existing) throw notFound("provider", c.req.param("id"));
    const body = await readJson<Record<string, unknown>>(c);
    delete body.id;
    const p = await repos.providers.upsert(validate(body, ownerId(c), existing));
    await publishProvidersChanged();
    return c.json(mask(p));
  })
  .delete("/:id", async (c) => {
    if (!(await repos.providers.delete(c.req.param("id"), scope(c)))) throw notFound("provider", c.req.param("id"));
    await publishProvidersChanged();
    return c.json({ id: c.req.param("id"), deleted: true });
  });
