import { Hono } from "hono";
import { memoryStores } from "../../infra/db.ts";
import type { MemoryMount } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MOUNT_RE = /^\/?[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/** `memory_stores: [{memory_store_id, mount_path?}]` (or bare ids) -> mounts; mount paths are relative to the workspace root. */
export async function validateMounts(v: unknown): Promise<MemoryMount[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalid("memory_stores must be an array");
  const out: MemoryMount[] = [];
  for (const x of v) {
    const id = typeof x === "string" ? x : (x as { memory_store_id?: unknown })?.memory_store_id;
    if (typeof id !== "string" || !id.startsWith("mem_")) throw invalid("each entry must be a mem_ id or {memory_store_id, mount_path?}");
    const store = await memoryStores.get(id);
    if (!store) throw notFound("memory_store", id);
    const mp = typeof x === "object" && x && typeof (x as { mount_path?: unknown }).mount_path === "string" ? (x as { mount_path: string }).mount_path : `/memories/${store.name}`;
    if (!MOUNT_RE.test(mp) || mp.split("/").includes("..")) throw invalid(`mount_path ${JSON.stringify(mp)} is not a safe relative path`);
    if (out.some((m) => m.mount_path === mp.replace(/^\//, ""))) throw invalid(`duplicate mount_path ${mp}`);
    out.push({ memory_store_id: id, mount_path: mp.replace(/^\//, "") });
  }
  return out;
}

/** Memory stores API: POST/GET/DELETE /v1/memory_stores. */
export const memoryStoresRoute = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; description?: string }>(c);
    if (!body.name || !NAME_RE.test(body.name)) throw invalid(`name must match ${NAME_RE}`);
    return c.json(await memoryStores.create({ name: body.name, description: body.description }), 201);
  })
  .get("/", async (c) => { const data = await memoryStores.list(); return c.json({ data, has_more: false }); })
  .get("/:id", async (c) => {
    const m = await memoryStores.get(c.req.param("id"));
    if (!m) throw notFound("memory_store", c.req.param("id"));
    return c.json(m);
  })
  .delete("/:id", async (c) => {
    if (!(await memoryStores.delete(c.req.param("id")))) throw notFound("memory_store", c.req.param("id"));
    return c.json({ id: c.req.param("id"), type: "memory_store_deleted" });
  });
