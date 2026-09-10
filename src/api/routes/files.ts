import { Hono } from "hono";
import { files } from "../../infra/db.ts";
import { invalid, notFound } from "../errors.ts";

const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Files API (shape follows the Claude Files API):
 *   POST /v1/files            multipart field "file" (or a raw body with x-file-name + content-type)
 *   GET  /v1/files            { data: [...], has_more, first_id, last_id }
 *   GET  /v1/files/:id        metadata   ·   GET /v1/files/:id/content   bytes   ·   DELETE /v1/files/:id
 * Reference a file from a user.message block: {type:"document"|"image", source:{type:"file", file_id}}.
 */
export const filesRoute = new Hono()
  .post("/", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    let filename: string; let mime: string; let data: Buffer;
    if (ct.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const f = form.get("file");
      if (!(f instanceof File)) throw invalid("multipart field 'file' is required");
      filename = f.name || "upload"; mime = f.type || "application/octet-stream"; data = Buffer.from(await f.arrayBuffer());
    } else {
      filename = c.req.header("x-file-name") ?? "upload";
      mime = ct.split(";")[0] || "application/octet-stream";
      data = Buffer.from(await c.req.arrayBuffer());
    }
    if (data.length === 0) throw invalid("empty file");
    if (data.length > MAX_BYTES) throw invalid(`file exceeds ${MAX_BYTES} bytes`);
    filename = filename.replace(/[^\w.\-() ]+/g, "_").slice(0, 200);
    return c.json(await files.create({ filename, mime_type: mime, data }), 201);
  })
  .get("/", async (c) => {
    const data = await files.list();
    return c.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null });
  })
  .get("/:id", async (c) => {
    const f = await files.get(c.req.param("id"));
    if (!f) throw notFound("file", c.req.param("id"));
    return c.json(f);
  })
  .get("/:id/content", async (c) => {
    const f = await files.content(c.req.param("id"));
    if (!f) throw notFound("file", c.req.param("id"));
    return c.body(f.data, 200, { "content-type": f.meta.mime_type, "content-disposition": `inline; filename="${f.meta.filename}"` });
  })
  .delete("/:id", async (c) => {
    if (!(await files.delete(c.req.param("id")))) throw notFound("file", c.req.param("id"));
    return c.json({ id: c.req.param("id"), type: "file_deleted" });
  });
