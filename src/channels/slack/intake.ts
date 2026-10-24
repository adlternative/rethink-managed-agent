import { channelThreads, claimChannelEventId, repos, vaultSecrets } from "../../infra/db.ts";
import { log } from "../../infra/log.ts";
import type { ChannelIntegrationResource, SessionResource } from "../../shared/types.ts";
import { sendUserEvents } from "../../api/routes/events.ts";
import { initialRef } from "../../api/routes/sessions.ts";
import { slackClient, stripSlackMentions } from "./client.ts";
import { startSlackBridge } from "./bridge.ts";

const BOT_TOKEN = "SLACK_BOT_TOKEN";
const SIGNING_SECRET = "SLACK_SIGNING_SECRET";

export async function loadSlackSecrets(integration: ChannelIntegrationResource): Promise<{ botToken: string; signingSecret: string } | null> {
  const secrets = await vaultSecrets(integration.owner_id, [integration.vault_id]);
  const botToken = secrets[BOT_TOKEN];
  const signingSecret = secrets[SIGNING_SECRET];
  if (!botToken || !signingSecret) return null;
  return { botToken, signingSecret };
}

/** Slack Events API envelope (subset). */
export interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  token?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    channel_type?: string;
  };
}

/**
 * Process one Slack Events API payload after signature verification.
 * Returns a JSON-serializable response body (challenge echo or `{ok:true}`).
 */
export async function handleSlackEvent(integration: ChannelIntegrationResource, envelope: SlackEventEnvelope): Promise<Record<string, unknown>> {
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    return { challenge: envelope.challenge };
  }
  if (!integration.enabled) return { ok: true, skipped: "disabled" };

  const eventId = envelope.event_id;
  if (eventId) {
    const fresh = await claimChannelEventId(integration.id, eventId);
    if (!fresh) return { ok: true, duplicate: true };
  }

  const ev = envelope.event;
  if (!ev || !ev.channel || !ev.ts) return { ok: true, skipped: "no_event" };
  // Ignore bot messages and message_changed noise.
  if (ev.bot_id || ev.subtype === "bot_message" || ev.subtype === "message_changed" || ev.subtype === "message_deleted") {
    return { ok: true, skipped: "bot_or_edit" };
  }
  if (integration.config.bot_user_id && ev.user === integration.config.bot_user_id) {
    return { ok: true, skipped: "self" };
  }

  const allow = integration.config.channel_ids;
  if (allow?.length && !allow.includes(ev.channel)) return { ok: true, skipped: "channel" };

  // Mentions start (or continue) a thread; plain thread replies continue an existing mapping.
  const isMention = ev.type === "app_mention";
  const isThreadReply = ev.type === "message" && !!ev.thread_ts;
  if (!isMention && !isThreadReply) return { ok: true, skipped: "not_mention_or_thread" };

  const teamId = envelope.team_id ?? "";
  const threadTs = ev.thread_ts ?? ev.ts;
  const text = stripSlackMentions(ev.text ?? "");
  if (!text) return { ok: true, skipped: "empty" };

  // `/answer <tool_use_id> <body>` fulfills a pending client tool without creating a user.message turn.
  const answer = text.match(/^\/answer\s+(\S+)\s+([\s\S]+)$/i);
  if (answer) {
    const existing = await channelThreads.get(integration.id, teamId, ev.channel, threadTs);
    if (!existing) return { ok: true, skipped: "no_thread" };
    const session = await repos.sessions.get(existing.session_id);
    if (!session || session.status === "terminated") return { ok: true, skipped: "no_session" };
    const toolUseId = answer[1]!;
    const body = answer[2]!.trim();
    let content: { type: "text"; text: string }[];
    try {
      const parsed = JSON.parse(body);
      content = [{ type: "text", text: typeof parsed === "string" ? parsed : JSON.stringify(parsed) }];
    } catch {
      content = [{ type: "text", text: body }];
    }
    await sendUserEvents(session, [{ type: "tool_result", tool_use_id: toolUseId, content }]);
    const secrets = await loadSlackSecrets(integration);
    if (secrets) startSlackBridge(session.id, slackClient(secrets.botToken), { channel: ev.channel, thread_ts: threadTs });
    return { ok: true, session_id: session.id, tool_result: toolUseId };
  }

  try {
    const { session, created } = await resolveSession(integration, teamId, ev.channel, threadTs, text);
    const secrets = await loadSlackSecrets(integration);
    if (secrets) startSlackBridge(session.id, slackClient(secrets.botToken), { channel: ev.channel, thread_ts: threadTs });
    return { ok: true, session_id: session.id, created };
  } catch (e) {
    log.error("slack.intake", { integration_id: integration.id, err: (e as Error).message });
    return { ok: false, error: (e as Error).message };
  }
}

async function resolveSession(
  integration: ChannelIntegrationResource,
  teamId: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<{ session: SessionResource; created: boolean }> {
  const existing = await channelThreads.get(integration.id, teamId, channelId, threadTs);
  if (existing) {
    const session = await repos.sessions.get(existing.session_id);
    if (session && session.status !== "terminated") {
      await sendUserEvents(session, [{ type: "user.message", content: [{ type: "text", text }] }]);
      return { session, created: false };
    }
  }

  const sc = { owner: integration.owner_id };
  const agent = await repos.agents.get(integration.agent_id, sc);
  if (!agent) throw new Error(`agent ${integration.agent_id} not found`);
  const environment = await repos.environments.get(integration.environment_id, sc);
  if (!environment) throw new Error(`environment ${integration.environment_id} not found`);

  const { created_at: _c, ...snap } = agent;
  const workspace = await repos.workspaces.create(environment.workspace, initialRef(environment.workspace), integration.owner_id);
  const vaultIds = [...new Set([integration.vault_id, ...(integration.config.session_vault_ids ?? [])])];
  const session = await repos.sessions.create({
    owner_id: integration.owner_id,
    agent_id: agent.id,
    environment_id: environment.id,
    workspace_id: workspace.id,
    agent: snap,
    environments: [{ key: "main", environment_id: environment.id, workspace_id: workspace.id }],
    parent_id: null,
    memory_stores: [],
    vault_ids: vaultIds,
    metadata: {
      channel: "slack",
      slack_team_id: teamId,
      slack_channel_id: channelId,
      slack_thread_ts: threadTs,
      integration_id: integration.id,
    },
  });
  await channelThreads.upsert({
    owner_id: integration.owner_id,
    integration_id: integration.id,
    kind: "slack",
    team_id: teamId,
    channel_id: channelId,
    thread_ts: threadTs,
    session_id: session.id,
  });
  await sendUserEvents(session, [{ type: "user.message", content: [{ type: "text", text }] }]);
  return { session, created: true };
}

/** Slack interactive payload (button click) after form-decoding. */
export interface SlackInteractionPayload {
  type?: string;
  team?: { id?: string };
  channel?: { id?: string };
  message?: { thread_ts?: string; ts?: string };
  container?: { thread_ts?: string; channel_id?: string };
  user?: { id?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}

export async function handleSlackInteraction(integration: ChannelIntegrationResource, payload: SlackInteractionPayload): Promise<Record<string, unknown>> {
  if (!integration.enabled) return { ok: true, skipped: "disabled" };
  const action = payload.actions?.[0];
  if (!action?.action_id || !action.value) return { ok: true, skipped: "no_action" };
  if (action.action_id !== "tool_confirm_allow" && action.action_id !== "tool_confirm_deny") {
    return { ok: true, skipped: "unknown_action" };
  }

  const teamId = payload.team?.id ?? "";
  const channelId = payload.channel?.id ?? payload.container?.channel_id ?? "";
  const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts ?? payload.message?.ts ?? "";
  if (!channelId || !threadTs) return { ok: true, skipped: "no_thread" };

  const mapping = await channelThreads.get(integration.id, teamId, channelId, threadTs);
  if (!mapping) return { ok: true, skipped: "no_mapping" };
  const session = await repos.sessions.get(mapping.session_id);
  if (!session || session.status === "terminated") return { ok: true, skipped: "no_session" };

  const result = action.action_id === "tool_confirm_allow" ? "allow" : "deny";
  await sendUserEvents(session, [{
    type: "user.tool_confirmation",
    tool_use_id: action.value,
    result,
    ...(result === "deny" ? { deny_message: "Denied from Slack" } : {}),
  }]);

  const secrets = await loadSlackSecrets(integration);
  if (secrets) {
    const client = slackClient(secrets.botToken);
    await client.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: result === "allow" ? `Allowed \`${action.value}\`` : `Denied \`${action.value}\``,
    });
    startSlackBridge(session.id, client, { channel: channelId, thread_ts: threadTs });
  }
  return { ok: true, session_id: session.id, result };
}
