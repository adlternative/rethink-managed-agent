import { Hono } from "hono";
import { skills } from "../../infra/db.ts";
import type { SkillRef } from "../../shared/types.ts";
import { ApiError, invalid, notFound, readJson } from "../errors.ts";
import { scope, ownerId } from "../auth.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** SKILL.md: frontmatter name/description + body. */
export function parseSkillMarkdown(markdown: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/.exec(markdown);
  if (!m) return { body: markdown.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ""); }
  return { name: meta.name, description: meta.description, body: m[2]!.trim() };
}

/** Accepts `skills: ["skill_x", {type:"custom", skill_id, version?}]` and normalizes to refs. */
export function validateSkillRefs(v: unknown): SkillRef[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalid("skills must be an array");
  return v.map((x) => {
    if (typeof x === "string" && x.startsWith("skill_")) return { type: "custom" as const, skill_id: x };
    if (x && typeof x === "object" && (x as { type?: string }).type === "custom" && typeof (x as { skill_id?: unknown }).skill_id === "string") return { type: "custom" as const, skill_id: (x as { skill_id: string }).skill_id, ...(typeof (x as { version?: unknown }).version === "string" ? { version: (x as { version: string }).version } : {}) };
    throw invalid("each skill must be a skill_ id or {type:'custom', skill_id, version?}");
  });
}

async function fromRequest(c: { req: { header(n: string): string | undefined; formData(): Promise<FormData>; json(): Promise<any> } }, existing?: { name: string; description: string; body: string; display_title: string }) {
  const ct = c.req.header("content-type") ?? "";
  let display_title: string | undefined; let markdown: string | undefined; let fields: Record<string, string> = {};
  if (ct.startsWith("multipart/form-data")) {
    // Claude Skills API style: files[] with a SKILL.md, plus display_title
    const form = await c.req.formData().catch((err) => { throw err instanceof ApiError ? err : invalid("body must be valid multipart/form-data"); });
    display_title = (form.get("display_title") as string | null) ?? undefined;
    for (const [, v] of form.entries()) if (v instanceof File && /(^|\/)SKILL\.md$/i.test(v.name)) markdown = await v.text();
    if (!markdown) throw invalid("multipart upload must include a SKILL.md");
  } else {
    const body = await c.req.json().catch((err) => { throw err instanceof ApiError ? err : invalid("body must be JSON or multipart"); });
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalid("body must be a JSON object");
    for (const k of ["display_title", "markdown", "name", "description", "body"]) if (body[k] !== undefined && typeof body[k] !== "string") throw invalid(`${k} must be a string`);
    display_title = body.display_title; markdown = body.markdown; fields = body;
  }
  const parsed = markdown ? parseSkillMarkdown(markdown) : { body: fields.body };
  const name = fields.name ?? parsed.name ?? existing?.name;
  const description = fields.description ?? parsed.description ?? existing?.description;
  const text = parsed.body || existing?.body;
  if (!name || !NAME_RE.test(name)) throw invalid(`skill name must match ${NAME_RE} (frontmatter 'name')`);
  if (!description) throw invalid("description is required (frontmatter 'description' tells the model when to use it)");
  if (!text) throw invalid("SKILL.md body is required");
  return { display_title: display_title ?? existing?.display_title ?? name, name, description, body: text };
}

export const skillsRoute = new Hono()
  .post("/", async (c) => c.json(await skills.upsert({ owner_id: ownerId(c), ...(await fromRequest(c)) }), 201))
  .get("/", async (c) => { const data = await skills.list(scope(c)); return c.json({ data, has_more: false }); })
  .get("/:id", async (c) => {
    const s = await skills.get(c.req.param("id"), scope(c));
    if (!s) throw notFound("skill", c.req.param("id"));
    return c.json(s);
  })
  .post("/:id/versions", async (c) => {
    // a new version replaces the content; latest_version increments
    const existing = await skills.get(c.req.param("id"), scope(c));
    if (!existing) throw notFound("skill", c.req.param("id"));
    return c.json(await skills.upsert({ id: existing.id, owner_id: existing.owner_id, ...(await fromRequest(c, existing)) }), 201);
  })
  .delete("/:id", async (c) => {
    if (!(await skills.delete(c.req.param("id"), scope(c)))) throw notFound("skill", c.req.param("id"));
    return c.json({ id: c.req.param("id"), type: "skill_deleted" });
  });
