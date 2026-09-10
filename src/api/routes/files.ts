import { Hono } from "hono";
import { files } from "../../infra/db.ts";
import { invalid, notFound } from "../errors.ts";

const MAX_BYTES = 32 * 1024 * 1024;

/**
 * POST /v1/files  multipart (field "file") or a raw body with x-file-name / content-type headers.
 * Files are content-addressed metadata + bytes in Postgres; reference them from user.message blocks
 * as {type:"image"|"document", file_id}.
 */
export const filesRoute = new Hono()
  .post("/", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    let name: string; let mime: string; let data: Buffer;
    if (ct.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const f = form.get("file");
      if (!(f instanceof File)) throw invalid("multipart field 'file' is required");
      name = f.name || "upload"; mime = f.type || "application/octet-stream"; data = Buffer.from(await f.arrayBuffer());
    } else {
      name = c.req.header("x-file-name") ?? "upload";
      mime = ct.split(";")[0] || "application/octet-stream";
      data = Buffer.from(await c.req.arrayBuffer());
    }
    if (data.length === 0) throw invalid("empty file");
    if (data.length > MAX_BYTES) throw invalid(`file exceeds ${MAX_BYTES} bytes`);
    name = name.replace(/[^\w.\-() ]+/g, "_").slice(0, 200);
    return c.json(await files.create({ name, mime, data }), 201);
  })
  .get("/", async (c) => c.json({ data: await files.list() }))
  .get("/:id", async (c) => {
    const f = await files.get(c.req.param("id"));
    if (!f) throw notFound("file", c.req.param("id"));
    return c.json(f);
  })
  .get("/:id/content", async (c) => {
    const f = await files.content(c.req.param("id"));
    if (!f) throw notFound("file", c.req.param("id"));
    return c.body(f.data, 200, { "content-type": f.meta.mime, "content-disposition": `inline; filename="${f.meta.name}"` });
  })
  .delete("/:id", async (c) => {
    if (!(await files.delete(c.req.param("id")))) throw notFound("file", c.req.param("id"));
    return c.json({ id: c.req.param("id"), deleted: true });
  });
