import { Hono } from "hono";
import { channelIntegrations, repos, vaults } from "../../infra/db.ts";
import type { ChannelKind, SlackIntegrationConfig } from "../../shared/types.ts";
import { ApiError, invalid, notFound, readJson } from "../errors.ts";
import { scope, ownerId } from "../auth.ts";
import { verifySlackSignature } from "../../channels/slack/verify.ts";
import { handleSlackEvent, handleSlackInteraction, loadSlackSecrets, type SlackEventEnvelope, type SlackInteractionPayload } from "../../channels/slack/intake.ts";
import { log } from "../../infra/log.ts";

const KINDS: ChannelKind[] = ["slack"];

function publicIntegration<T extends { vault_id: string }>(row: T): T {
  // Secrets never leave the vault; the integration resource only exposes the vault id.
  return row;
}

async function requireOwnedRefs(owner: string, agentId: string, environmentId: string, vaultId: string): Promise<void> {
  const sc = { owner };
  if (!(await repos.agents.get(agentId, sc))) throw notFound("agent", agentId);
  if (!(await repos.environments.get(environmentId, sc))) throw notFound("environment", environmentId);
  if (!(await vaults.get(vaultId, sc))) throw notFound("vault", vaultId);
}

function validateConfig(kind: ChannelKind, raw: unknown): SlackIntegrationConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("config must be an object");
  const c = raw as Record<string, unknown>;
  const out: SlackIntegrationConfig = {};
  if (c.channel_ids !== undefined) {
    if (!Array.isArray(c.channel_ids) || !c.channel_ids.every((x) => typeof x === "string" && x)) throw invalid("config.channel_ids must be an array of strings");
    out.channel_ids = c.channel_ids as string[];
  }
  if (c.session_vault_ids !== undefined) {
    if (!Array.isArray(c.session_vault_ids) || !c.session_vault_ids.every((x) => typeof x === "string" && x)) throw invalid("config.session_vault_ids must be an array of vault ids");
    out.session_vault_ids = c.session_vault_ids as string[];
  }
  if (c.bot_user_id !== undefined) {
    if (typeof c.bot_user_id !== "string") throw invalid("config.bot_user_id must be a string");
    out.bot_user_id = c.bot_user_id;
  }
  if (kind !== "slack") throw invalid(`unsupported channel kind ${JSON.stringify(kind)}`);
  return out;
}

/**
 * Channel integrations: owner-scoped Slack (v1) adapters that map mentions/threads onto sessions.
 *
 * Authenticated CRUD under `/v1/integrations`. Slack Events + Interactions are mounted at
 * `/v1/integrations/:id/events` and `/v1/integrations/:id/interactions` and authenticate via
 * Slack signing secret (Bearer auth is skipped for those paths — see auth.ts).
 */
export const integrations = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{
      kind?: string;
      name?: string;
      agent_id?: string;
      environment_id?: string;
      vault_id?: string;
      config?: unknown;
      enabled?: boolean;
    }>(c);
    if (body.kind !== "slack") throw invalid(`kind must be one of ${KINDS.join(",")}`);
    if (!body.agent_id || typeof body.agent_id !== "string") throw invalid("agent_id is required");
    if (!body.environment_id || typeof body.environment_id !== "string") throw invalid("environment_id is required");
    if (!body.vault_id || typeof body.vault_id !== "string") throw invalid("vault_id is required (store SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET there)");
    const owner = ownerId(c);
    await requireOwnedRefs(owner, body.agent_id, body.environment_id, body.vault_id);
    const config = validateConfig("slack", body.config);
    if (config.session_vault_ids?.length) {
      for (const id of config.session_vault_ids) if (!(await vaults.get(id, scope(c)))) throw notFound("vault", id);
    }
    const row = await channelIntegrations.create({
      owner_id: owner,
      kind: "slack",
      name: typeof body.name === "string" ? body.name : "",
      agent_id: body.agent_id,
      environment_id: body.environment_id,
      vault_id: body.vault_id,
      config,
      enabled: body.enabled !== false,
    });
    return c.json(publicIntegration(row), 201);
  })
  .get("/", async (c) => c.json({ object: "list", data: (await channelIntegrations.list(scope(c))).map(publicIntegration) }))
  .get("/:id", async (c) => {
    const row = await channelIntegrations.get(c.req.param("id"), scope(c));
    if (!row) throw notFound("integration", c.req.param("id"));
    return c.json(publicIntegration(row));
  })
  .patch("/:id", async (c) => {
    const body = await readJson<{
      name?: string;
      agent_id?: string;
      environment_id?: string;
      vault_id?: string;
      config?: unknown;
      enabled?: boolean;
    }>(c);
    const existing = await channelIntegrations.get(c.req.param("id"), scope(c));
    if (!existing) throw notFound("integration", c.req.param("id"));
    const owner = ownerId(c);
    const agentId = body.agent_id ?? existing.agent_id;
    const environmentId = body.environment_id ?? existing.environment_id;
    const vaultId = body.vault_id ?? existing.vault_id;
    await requireOwnedRefs(owner, agentId, environmentId, vaultId);
    const config = body.config !== undefined ? validateConfig(existing.kind, body.config) : undefined;
    if (config?.session_vault_ids?.length) {
      for (const id of config.session_vault_ids) if (!(await vaults.get(id, scope(c)))) throw notFound("vault", id);
    }
    const row = await channelIntegrations.update(existing.id, {
      name: body.name,
      agent_id: body.agent_id,
      environment_id: body.environment_id,
      vault_id: body.vault_id,
      config,
      enabled: body.enabled,
    }, scope(c));
    return c.json(publicIntegration(row!));
  })
  .delete("/:id", async (c) => {
    if (!(await channelIntegrations.delete(c.req.param("id"), scope(c)))) throw notFound("integration", c.req.param("id"));
    return c.json({ id: c.req.param("id"), deleted: true });
  })
  /**
   * Slack Events API Request URL. Verifies X-Slack-Signature against the vault signing secret.
   * Acks quickly; heavy work (session create / bridge) runs after the response is on its way for
   * non-challenge payloads via waitUntil-style fire-and-forget (we still await for correctness in
   * tests — Slack only needs <3s).
   */
  .post("/:id/events", async (c) => {
    const id = c.req.param("id");
    const integration = await channelIntegrations.get(id);
    if (!integration || integration.kind !== "slack") throw notFound("integration", id);

    const rawBody = await c.req.text();
    const secrets = await loadSlackSecrets(integration);
    if (!secrets) throw new ApiError(503, "api_error", "integration vault is missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET");

    const ok = verifySlackSignature({
      signingSecret: secrets.signingSecret,
      signature: c.req.header("x-slack-signature"),
      timestamp: c.req.header("x-slack-request-timestamp"),
      body: rawBody,
    });
    if (!ok) throw new ApiError(401, "authentication_error", "invalid Slack signature");

    let envelope: SlackEventEnvelope;
    try {
      envelope = JSON.parse(rawBody) as SlackEventEnvelope;
    } catch {
      throw invalid("body must be JSON");
    }

    // url_verification must be answered with the challenge immediately.
    if (envelope.type === "url_verification") {
      return c.json(await handleSlackEvent(integration, envelope));
    }

    // Process (idempotent) and return 200 so Slack does not retry on our application errors.
    try {
      const result = await handleSlackEvent(integration, envelope);
      return c.json(result);
    } catch (e) {
      log.error("slack.events", { integration_id: id, err: (e as Error).message });
      return c.json({ ok: false, error: (e as Error).message }, 200);
    }
  })
  /** Slack Interactivity Request URL (button clicks for tool confirmation). */
  .post("/:id/interactions", async (c) => {
    const id = c.req.param("id");
    const integration = await channelIntegrations.get(id);
    if (!integration || integration.kind !== "slack") throw notFound("integration", id);

    const rawBody = await c.req.text();
    const secrets = await loadSlackSecrets(integration);
    if (!secrets) throw new ApiError(503, "api_error", "integration vault is missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET");

    const ok = verifySlackSignature({
      signingSecret: secrets.signingSecret,
      signature: c.req.header("x-slack-signature"),
      timestamp: c.req.header("x-slack-request-timestamp"),
      body: rawBody,
    });
    if (!ok) throw new ApiError(401, "authentication_error", "invalid Slack signature");

    const params = new URLSearchParams(rawBody);
    const rawPayload = params.get("payload");
    if (!rawPayload) throw invalid("missing payload");
    let payload: SlackInteractionPayload;
    try {
      payload = JSON.parse(rawPayload) as SlackInteractionPayload;
    } catch {
      throw invalid("payload must be JSON");
    }

    try {
      return c.json(await handleSlackInteraction(integration, payload));
    } catch (e) {
      log.error("slack.interactions", { integration_id: id, err: (e as Error).message });
      return c.json({ ok: false, error: (e as Error).message }, 200);
    }
  });
