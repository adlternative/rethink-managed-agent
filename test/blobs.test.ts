import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let blobStore: typeof import("../src/infra/blobs.ts").blobStore;
beforeAll(async () => {
  process.env.BLOB_BACKEND = "fs";
  process.env.BLOB_DIR = await mkdtemp(path.join(tmpdir(), "blobs-"));
  ({ blobStore } = await import("../src/infra/blobs.ts"));
});

describe("BlobStore fs backend", () => {
  it("put/get/delete round-trips and is nested-key aware", async () => {
    const s = blobStore();
    expect(s.configured).toBe(true);
    await s.ensure();
    await s.put("files/abc", Buffer.from("hello"), "text/plain");
    expect((await s.get("files/abc"))?.toString()).toBe("hello");
    await s.delete("files/abc");
    expect(await s.get("files/abc")).toBeNull();          // ENOENT -> null, not throw
    expect(await s.get("files/missing")).toBeNull();
  });
  it("rejects keys that escape the blob dir", async () => {
    await expect(blobStore().put("../escape", Buffer.from("x"))).rejects.toThrow(/escapes/);
  });
});
