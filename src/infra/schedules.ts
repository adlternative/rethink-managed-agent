/**
 * Runner-side schedule tick: claim due /v1/schedules rows, execute their action
 * (create a session or message an existing one), then advance next_run_at.
 */
import { hostname } from "node:os";
import { repos, schedules as scheduleRepo } from "./db.ts";
import { sendUserEvents } from "../api/routes/events.ts";
import { nextRunAfter, parseCron } from "../shared/cron.ts";
import { env } from "../shared/env.ts";
import type { ScheduleAction, ScheduleResource, WorkspaceRef, WorkspaceSpec } from "../shared/types.ts";
import { log } from "./log.ts";

const runnerId = `runner:${hostname()}:${process.pid}`;

function initialRef(spec: WorkspaceSpec): WorkspaceRef {
  if (spec.kind === "git") return { kind: "git", remote: spec.remote, base: spec.ref ?? "HEAD" };
  if (spec.kind === "local") return { kind: "local", path: spec.path };
  return { kind: "empty" };
}

function messageEvent(text: string) {
  return [{ type: "user.message" as const, content: [{ type: "text" as const, text }] }];
}

async function fireAction(schedule: ScheduleResource, action: ScheduleAction): Promise<string> {
  const sc = { owner: schedule.owner_id };
  if (action.type === "session.message") {
    const session = await repos.sessions.get(action.session_id, sc);
    if (!session) throw new Error(`session ${action.session_id} not found`);
    if (session.status === "terminated") throw new Error(`session ${action.session_id} is terminated`);
    await sendUserEvents(session, messageEvent(action.message));
    return session.id;
  }
  if (action.type === "session.create") {
    const agent = await repos.agents.get(action.agent_id, sc);
    if (!agent) throw new Error(`agent ${action.agent_id} not found`);
    const environment = await repos.environments.get(action.environment_id, sc);
    if (!environment) throw new Error(`environment ${action.environment_id} not found`);
    const { created_at: _c, ...snap } = agent;
    const spec = environment.workspace as WorkspaceSpec;
    const workspace = await repos.workspaces.create(spec, initialRef(spec), schedule.owner_id);
    const session = await repos.sessions.create({
      owner_id: schedule.owner_id,
      agent_id: agent.id,
      environment_id: environment.id,
      workspace_id: workspace.id,
      agent: snap,
      environments: [{ key: "main", environment_id: environment.id, workspace_id: workspace.id }],
      vault_ids: action.vault_ids ?? [],
    });
    await sendUserEvents(session, messageEvent(action.message));
    return session.id;
  }
  throw new Error(`unsupported schedule action ${(action as { type?: string }).type}`);
}

/** Advance past `from` (or now if that would still be due) so missed ticks are skipped, not replayed. */
export function advanceNextRun(schedule: Pick<ScheduleResource, "cron" | "timezone">, from: Date = new Date()): Date {
  const cron = parseCron(schedule.cron);
  const next = nextRunAfter(cron, from, schedule.timezone);
  if (!next) throw new Error(`no next run for cron ${JSON.stringify(schedule.cron)} in ${schedule.timezone}`);
  return next;
}

async function completeFire(schedule: ScheduleResource, status: "ok" | "error", sessionId: string | null, error: string | null): Promise<void> {
  const next = advanceNextRun(schedule, new Date());
  await scheduleRepo.complete(schedule.id, { next_run_at: next, status, error, session_id: sessionId });
}

/** Claim and fire every due schedule once. Returns how many were claimed. */
export async function tickSchedules(opts: { claimMs?: number; limit?: number } = {}): Promise<number> {
  const claimMs = opts.claimMs ?? env.SCHEDULE_CLAIM_MS;
  const due = await scheduleRepo.claimDue(runnerId, claimMs, opts.limit ?? 16);
  for (const schedule of due) {
    const slog = log.child({ schedule: schedule.id, owner: schedule.owner_id });
    try {
      const sessionId = await fireAction(schedule, schedule.action);
      await completeFire(schedule, "ok", sessionId, null);
      slog.info("schedule.fired", { session_id: sessionId, action: schedule.action.type });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      try {
        await completeFire(schedule, "error", null, msg.slice(0, 2000));
      } catch (completeErr) {
        slog.error("schedule.complete_failed", { error: (completeErr as Error)?.message ?? String(completeErr) });
      }
      slog.error("schedule.fire_failed", { error: msg });
    }
  }
  return due.length;
}
