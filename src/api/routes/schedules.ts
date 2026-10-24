import { Hono } from "hono";
import { repos, schedules as scheduleRepo } from "../../infra/db.ts";
import { assertTimezone, nextRunAfter, parseCron } from "../../shared/cron.ts";
import type { ScheduleAction } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";
import { scope, ownerId } from "../auth.ts";
import type { Scope } from "../../infra/db.ts";
import { validateVaultIds } from "./vaults.ts";

function validateCron(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw invalid("cron must be a 5-field expression (min hour dom month dow)");
  try { parseCron(raw); } catch (e) { throw invalid((e as Error).message); }
  return raw.trim();
}

function validateTimezone(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "UTC";
  if (typeof raw !== "string") throw invalid("timezone must be a string");
  try { return assertTimezone(raw); } catch (e) { throw invalid((e as Error).message); }
}

async function validateAction(raw: unknown, sc: Scope): Promise<ScheduleAction> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("action must be an object");
  const a = raw as Record<string, unknown>;
  if (a.type === "session.create") {
    if (typeof a.agent_id !== "string" || !a.agent_id) throw invalid("action.agent_id is required");
    if (typeof a.environment_id !== "string" || !a.environment_id) throw invalid("action.environment_id is required");
    if (typeof a.message !== "string" || !a.message) throw invalid("action.message is required");
    if (!(await repos.agents.get(a.agent_id, sc))) throw notFound("agent", a.agent_id);
    if (!(await repos.environments.get(a.environment_id, sc))) throw notFound("environment", a.environment_id);
    const vault_ids = await validateVaultIds(a.vault_ids, sc);
    return { type: "session.create", agent_id: a.agent_id, environment_id: a.environment_id, message: a.message, ...(vault_ids.length ? { vault_ids } : {}) };
  }
  if (a.type === "session.message") {
    if (typeof a.session_id !== "string" || !a.session_id) throw invalid("action.session_id is required");
    if (typeof a.message !== "string" || !a.message) throw invalid("action.message is required");
    if (!(await repos.sessions.get(a.session_id, sc))) throw notFound("session", a.session_id);
    return { type: "session.message", session_id: a.session_id, message: a.message };
  }
  throw invalid("action.type must be 'session.create' or 'session.message'");
}

function computeNext(cron: string, timezone: string): Date {
  const next = nextRunAfter(cron, new Date(), timezone);
  if (!next) throw invalid(`cron ${JSON.stringify(cron)} has no next fire time in the next two years`);
  return next;
}

/** Schedules API: POST/GET/PATCH/DELETE /v1/schedules. */
export const schedulesRoute = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; cron?: unknown; timezone?: unknown; enabled?: unknown; action?: unknown }>(c);
    const sc = scope(c);
    const cron = validateCron(body.cron);
    const timezone = validateTimezone(body.timezone);
    const action = await validateAction(body.action, sc);
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    if (body.name !== undefined && body.name !== null && typeof body.name !== "string") throw invalid("name must be a string");
    const row = await scheduleRepo.create({
      owner_id: ownerId(c),
      name: body.name ?? null,
      cron,
      timezone,
      enabled: body.enabled ?? true,
      action,
      next_run_at: computeNext(cron, timezone),
    });
    return c.json(row, 201);
  })
  .get("/", async (c) => {
    const data = await scheduleRepo.list(scope(c));
    return c.json({ data, has_more: false });
  })
  .get("/:id", async (c) => {
    const row = await scheduleRepo.get(c.req.param("id"), scope(c));
    if (!row) throw notFound("schedule", c.req.param("id"));
    return c.json(row);
  })
  .patch("/:id", async (c) => {
    const sc = scope(c);
    const existing = await scheduleRepo.get(c.req.param("id"), sc);
    if (!existing) throw notFound("schedule", c.req.param("id"));
    const body = await readJson<{ name?: string | null; cron?: unknown; timezone?: unknown; enabled?: unknown; action?: unknown }>(c);
    const patch: Parameters<typeof scheduleRepo.update>[1] = {};
    if (body.name !== undefined) {
      if (body.name !== null && typeof body.name !== "string") throw invalid("name must be a string or null");
      patch.name = body.name;
    }
    if (body.cron !== undefined) patch.cron = validateCron(body.cron);
    if (body.timezone !== undefined) patch.timezone = validateTimezone(body.timezone);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
      patch.enabled = body.enabled;
    }
    if (body.action !== undefined) patch.action = await validateAction(body.action, sc);
    if (!Object.keys(patch).length) throw invalid("body must include name, cron, timezone, enabled, and/or action");
    // Recompute next_run when the cadence changes (or when re-enabling).
    if (patch.cron !== undefined || patch.timezone !== undefined || patch.enabled === true) {
      patch.next_run_at = computeNext(patch.cron ?? existing.cron, patch.timezone ?? existing.timezone);
    }
    const row = await scheduleRepo.update(existing.id, patch, sc);
    return c.json(row);
  })
  .delete("/:id", async (c) => {
    if (!(await scheduleRepo.delete(c.req.param("id"), scope(c)))) throw notFound("schedule", c.req.param("id"));
    return c.json({ id: c.req.param("id"), type: "schedule_deleted" });
  });
