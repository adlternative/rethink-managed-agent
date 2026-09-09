import { Hono } from "hono";
import * as store from "../../sandbox/lease-store.ts";
import { ApiError, notFound } from "../errors.ts";

/**
 * Read + retire view over the lease table. The API process holds no docker socket or SDK
 * handles, so DELETE only marks a ready sandbox; a runner's reaper destroys it on its next pass.
 */
export const sandboxes = new Hono()
  .get("/", async (c) => c.json({ data: await store.list({ includeDestroyed: c.req.query("include_destroyed") === "true" }) }))
  .get("/:id", async (c) => {
    const row = await store.get(c.req.param("id"));
    if (!row) throw notFound("sandbox", c.req.param("id"));
    return c.json(row);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const row = await store.get(id);
    if (!row) throw notFound("sandbox", id);
    if (row.status === "destroyed") return c.json({ id, status: "destroyed" });
    if (row.status === "busy") throw new ApiError(409, "sandbox_busy", `sandbox ${id} is leased by a running session`);
    await store.markForDestroy(id);
    return c.json({ id, status: "destroying" }, 202);
  });
