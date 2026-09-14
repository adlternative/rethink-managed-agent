import { Hono } from "hono";
import * as store from "../../sandbox/lease-store.ts";
import { ApiError, notFound } from "../errors.ts";
import { ownerId } from "../auth.ts";

/**
 * Read + retire view over the lease table, scoped to the caller's principal. The API process holds
 * no docker socket or SDK handles, so DELETE only marks a ready sandbox; a runner's reaper destroys
 * it on its next pass.
 */
export const sandboxes = new Hono()
  .get("/", async (c) => c.json({ data: await store.list({ includeDestroyed: c.req.query("include_destroyed") === "true", owner: ownerId(c) }) }))
  .get("/:id", async (c) => {
    const row = await store.getScoped(c.req.param("id"), ownerId(c));
    if (!row) throw notFound("sandbox", c.req.param("id"));
    return c.json(row);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const row = await store.getScoped(id, ownerId(c));
    if (!row) throw notFound("sandbox", id);
    if (row.status === "destroyed") return c.json({ id, status: "destroyed" });
    if (row.status === "busy") throw new ApiError(409, "sandbox_busy", `sandbox ${id} is leased by a running session`);
    if (!(await store.markForDestroy(id))) throw new ApiError(409, "sandbox_busy", `sandbox ${id} was leased by a running session`);
    return c.json({ id, status: "destroying" }, 202);
  })
  /** Pause a ready sandbox on the reaper's next pass (docker: stop; e2b: snapshot). Resumes on next use. */
  .post("/:id/pause", async (c) => {
    const id = c.req.param("id");
    const row = await store.getScoped(id, ownerId(c));
    if (!row) throw notFound("sandbox", id);
    if (row.status === "paused") return c.json({ id, status: "paused" });
    if (row.status !== "ready") throw new ApiError(409, "sandbox_not_idle", `sandbox ${id} is ${row.status}`);
    if (!(await store.markForPause(id))) throw new ApiError(409, "sandbox_not_idle", `sandbox ${id} is no longer idle`);
    return c.json({ id, status: "pausing" }, 202);
  });
