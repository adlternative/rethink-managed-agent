import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listArtifacts, readArtifact, deleteArtifact } from "../src/infra/artifacts.ts";

describe("workspace artifact reader", () => {
  it("lists and reads files from a dir workspace, confines paths, ignores .git", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "art-"));
    await writeFile(path.join(dir, "note.txt"), "hello");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");

    const ref = { kind: "dir", path: dir } as const;
    const list = await listArtifacts(ref);
    expect(list.map((e) => e.path)).toEqual(["note.txt", "src/a.ts"]); // sorted, .git skipped
    expect(list.find((e) => e.path === "note.txt")!.size).toBe(5);

    const f = await readArtifact(ref, "src/a.ts");
    expect(new TextDecoder().decode(f!.bytes)).toBe("export const a = 1;");

    // path escape is refused
    await expect(readArtifact(ref, "../../etc/passwd")).rejects.toThrow(/escapes/);

    // non-dir refs have no host tree
    expect(await listArtifacts({ kind: "empty" } as const)).toEqual([]);
    expect(await listArtifacts({ kind: "git", remote: "x", base: "y" } as const)).toEqual([]);

    expect(await deleteArtifact(ref, "note.txt")).toBe(true);
    expect((await listArtifacts(ref)).map((e) => e.path)).toEqual(["src/a.ts"]);
  });
});
