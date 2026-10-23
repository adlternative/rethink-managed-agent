import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createTools, truncateOutput, type ToolContext } from "../src/harness/tools.ts";
import { env } from "../src/shared/env.ts";
import type { ExecChunk } from "../src/shared/types.ts";
import { memSandbox, type ExecHandler } from "./fixtures/harness-fakes/deps.ts";

const saved = { ...env };
afterEach(() => { Object.assign(env, saved); });

function setup(opts: { exec?: ExecHandler; envKeys?: string[]; spill?: boolean; spillPutFails?: boolean } = {}) {
  const sb = memSandbox("sbx_t", opts.exec);
  const spilled = new Map<string, { tool_name: string; content: string; bytes: number }>();
  const ctx: ToolContext = {
    sandbox: async () => sb,
    envKeys: opts.envKeys,
    spill: opts.spill === false ? undefined : {
      put: async (id, name, content) => { if (opts.spillPutFails) throw new Error("spill store down"); spilled.set(id, { tool_name: name, content, bytes: Buffer.byteLength(content) }); },
      get: async (id) => spilled.get(id) ?? null,
    },
  };
  const tools = createTools(["bash", "read", "write", "edit"], ctx);
  const byName = (n: string) => tools.find((t) => t.name === n)!;
  const run = async (name: string, params: Record<string, unknown>, id = "call_1") => {
    const r = await byName(name).execute(id, params as never);
    return (r.content[0] as { text: string }).text;
  };
  return { sb, spilled, tools, byName, run, ctx };
}
const put = (sb: ReturnType<typeof memSandbox>, p: string, s: string) => sb.files.set(`/work/${p}`, Buffer.from(s, "utf8"));
const chunks = (...c: ExecChunk[]): ExecHandler => () => c;

describe("bash", () => {
  it("returns '(no output)' for a silent success and runs in the workdir", async () => {
    const t = setup({ exec: chunks({ type: "exit", code: 0 }) });
    expect(await t.run("bash", { command: "true" })).toBe("(no output)");
    expect(t.sb.execs[0]!.opts?.cwd).toBe("/work");
  });

  it("combines stdout and stderr and throws with the body on a non-zero exit", async () => {
    const t = setup({ exec: chunks({ type: "stdout", data: "out\n" }, { type: "stderr", data: "boom" }, { type: "exit", code: 2 }) });
    await expect(t.run("bash", { command: "x" })).rejects.toThrow(/out\nboom\n\nCommand exited with code 2$/);
  });

  it("mentions the timeout on exit 137 and reports an unknown code when no exit chunk arrives", async () => {
    env.BASH_TIMEOUT_MS = 1234;
    const t = setup({ exec: chunks({ type: "exit", code: 137 }) });
    await expect(t.run("bash", { command: "sleep 9" })).rejects.toThrow(/killed: timeout 1234ms or interrupt/);
    const u = setup({ exec: chunks({ type: "stdout", data: "x" }) });
    await expect(u.run("bash", { command: "x" })).rejects.toThrow(/code unknown/);
  });

  it("converts the timeout from seconds, caps it at BASH_MAX_TIMEOUT_MS and defaults when omitted or 0", async () => {
    env.BASH_TIMEOUT_MS = 600_000; env.BASH_MAX_TIMEOUT_MS = 900_000;
    const t = setup({ exec: chunks({ type: "exit", code: 0 }) });
    await t.run("bash", { command: "a", timeout: 5 });
    await t.run("bash", { command: "b", timeout: 99_999 });
    await t.run("bash", { command: "c" });
    await t.run("bash", { command: "d", timeout: 0 });
    expect(t.sb.execs.map((e) => e.opts?.timeoutMs)).toEqual([5000, 900_000, 600_000, 600_000]);
  });

  it("a negative timeout falls back to the default (regression: negative timeoutMs is passed to the sandbox)", async () => {
    env.BASH_TIMEOUT_MS = 600_000;
    const t = setup({ exec: chunks({ type: "exit", code: 0 }) });
    await t.run("bash", { command: "make", timeout: -1 });
    expect(t.sb.execs[0]!.opts?.timeoutMs).toBe(600_000);
  });

  it("spills oversized output and tells the model how to read it back", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"z".repeat(10)}`).join("\n");
    const t = setup({ exec: chunks({ type: "stdout", data: big }, { type: "exit", code: 0 }) });
    const out = await t.run("bash", { command: "cat big" }, "call_big");
    expect(t.spilled.get("call_big")).toMatchObject({ tool_name: "bash", content: big });
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain(`call tool_output with tool_use_id "call_big"`);
    expect(out.startsWith("line 0 ")).toBe(true);
    expect(out.endsWith(big.slice(-100))).toBe(true);
  });

  it("truncates without a hint when no spill store is configured", async () => {
    const big = "q".repeat(40_000);
    const t = setup({ spill: false, exec: chunks({ type: "stdout", data: big }, { type: "exit", code: 0 }) });
    const out = await t.run("bash", { command: "x" });
    expect(out).toBe(truncateOutput(big));
    expect(out).not.toContain("tool_output");
    expect(t.tools.map((x) => x.name)).not.toContain("tool_output");
  });

  it("a failing spill store does not turn a successful command into an error", async () => {
    const t = setup({ spillPutFails: true, exec: chunks({ type: "stdout", data: "k".repeat(40_000) }, { type: "exit", code: 0 }) });
    const out = await t.run("bash", { command: "x" });
    expect(out).toContain("chars truncated");
  });
});

describe("read", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");

  it("numbers lines and windows with offset/limit plus a continuation footer", async () => {
    const t = setup();
    put(t.sb, "f.txt", ten);
    expect(await t.run("read", { path: "f.txt", offset: 3, limit: 2 })).toBe("     3\tL3\n     4\tL4\n\n[6 more lines. Use offset=5 to continue.]");
    expect(await t.run("read", { path: "f.txt", offset: 9 })).toBe("     9\tL9\n    10\tL10");
    expect(await t.run("read", { path: "./sub/../f.txt", limit: 1 })).toContain("[9 more lines. Use offset=2 to continue.]");
  });

  it("throws past EOF and reads an empty file as one empty line", async () => {
    const t = setup();
    put(t.sb, "f.txt", ten);
    await expect(t.run("read", { path: "f.txt", offset: 11 })).rejects.toThrow(/Offset 11 is beyond end of file \(10 lines\)/);
    put(t.sb, "empty.txt", "");
    expect(await t.run("read", { path: "empty.txt" })).toBe("     1\t");
    await expect(t.run("read", { path: "missing.txt" })).rejects.toThrow(/ENOENT/);
  });

  it("limit 0 returns no lines but points at the rest", async () => {
    const t = setup();
    put(t.sb, "f.txt", ten);
    expect(await t.run("read", { path: "f.txt", limit: 0 })).toBe("\n\n[10 more lines. Use offset=1 to continue.]");
  });

  it("a negative limit is rejected or treated as no limit", async () => {
    const t = setup();
    put(t.sb, "f.txt", ten);
    const out = await t.run("read", { path: "f.txt", limit: -2 }).catch((e: Error) => `ERR ${e.message}`);
    expect(out.startsWith("ERR") || out.includes("    10\tL10")).toBe(true);
    expect(out).not.toMatch(/\[\d+ more lines/);
  });
});

describe("write and edit", () => {
  it("write counts UTF-8 bytes for multibyte content", async () => {
    const t = setup();
    expect(await t.run("write", { path: "u.txt", content: "héllo wörld" })).toBe("Wrote 13 bytes to u.txt");
    expect(Buffer.from(t.sb.files.get("/work/u.txt")!).toString("utf8")).toBe("héllo wörld");
  });

  it("edit replaces exactly one occurrence and inserts replacement patterns literally", async () => {
    const t = setup();
    put(t.sb, "a.ts", "const x = 1;\nconst y = 2;\n");
    expect(await t.run("edit", { path: "a.ts", oldText: "x = 1", newText: "x = '$&$1$$'" })).toBe("Edited a.ts");
    expect(Buffer.from(t.sb.files.get("/work/a.ts")!).toString()).toBe("const x = '$&$1$$';\nconst y = 2;\n");
  });

  it("edit rejects missing and ambiguous oldText without writing", async () => {
    const t = setup();
    put(t.sb, "a.ts", "foo foo");
    await expect(t.run("edit", { path: "a.ts", oldText: "bar", newText: "x" })).rejects.toThrow(/oldText not found in a.ts/);
    await expect(t.run("edit", { path: "a.ts", oldText: "foo", newText: "x" })).rejects.toThrow(/occurs more than once/);
    // the uniqueness scan is non-overlapping: "aa" in "aaa" counts as a single occurrence
    put(t.sb, "b.ts", "aaa");
    await expect(t.run("edit", { path: "b.ts", oldText: "aa", newText: "x" })).resolves.toBe("Edited b.ts");
    expect(Buffer.from(t.sb.files.get("/work/a.ts")!).toString()).toBe("foo foo");
  });

  it("edit with an empty oldText reports a clear error (regression: says 'occurs more than once')", async () => {
    const t = setup();
    put(t.sb, "a.ts", "abc");
    await expect(t.run("edit", { path: "a.ts", oldText: "", newText: "x" })).rejects.toThrow(/empty/i);
  });
});

describe("withEnv schemas", () => {
  const props = (t: AgentTool) => Object.keys((t.parameters as { properties: object }).properties);
  it("adds an optional env parameter only when several environments are attached", () => {
    const one = setup({ envKeys: ["main"] });
    for (const t of one.tools.filter((x) => x.name !== "tool_output")) expect(props(t)).not.toContain("env");
    const two = setup({ envKeys: ["main", "db"] });
    const bash = two.byName("bash");
    expect(props(bash)).toEqual(["command", "timeout", "env"]);
    expect((bash.parameters as { required?: string[] }).required).toEqual(["command"]);
    expect((two.byName("edit").parameters as { required?: string[] }).required).toEqual(["path", "oldText", "newText"]);
    expect(JSON.stringify(bash.parameters)).toContain("main | db");
  });

  it("routes a tool call to the named environment", async () => {
    const asked: (string | undefined)[] = [];
    const sb = memSandbox();
    const tools = createTools(["write"], { sandbox: async (k) => { asked.push(k); return sb; }, envKeys: ["main", "db"] });
    await tools[0]!.execute("c", { path: "x", content: "y", env: "db" } as never);
    await tools[0]!.execute("c", { path: "x", content: "y" } as never);
    expect(asked).toEqual(["db", undefined]);
  });
});

describe("tool_output", () => {
  async function spilled(content: string) {
    const t = setup();
    await t.ctx.spill!.put("call_x", "bash", content);
    const tool = t.tools.find((x) => x.name === "tool_output")!;
    const run = async (p: Record<string, unknown>) => ((await tool.execute("c2", { tool_use_id: "call_x", ...p } as never)).content[0] as { text: string }).text;
    return { run, tool };
  }
  const thousand = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? `ERR ${i + 1}` : `ok ${i + 1}`)).join("\n");

  it("greps case-insensitively with line numbers, capped at 200 matches", async () => {
    const { run } = await spilled(thousand);
    const out = await run({ grep: "err" });
    expect(out.split("\n")[0]).toMatch(/^\(bash output, 1000 lines, \d+ bytes\)$/);
    expect(out).toContain("     1\tERR 1");
    expect(out).not.toContain("ok 2");
    expect(out).toContain("[300 more matches]");
  });

  it("reports no matches and bad regexes", async () => {
    const { run } = await spilled(thousand);
    expect(await run({ grep: "nothing-here" })).toContain("(no matches)");
    await expect(run({ grep: "(" })).rejects.toThrow(/bad grep regex/);
  });

  it("windows with offset/limit (default 200) and a footer; unknown ids throw", async () => {
    const { run, tool } = await spilled(thousand);
    const w = await run({ offset: 999, limit: 5 });
    expect(w).toContain("   999\tERR 999\n  1000\tok 1000");
    expect(w).not.toContain("more lines");
    const d = await run({});
    expect(d).toContain("   200\tok 200");
    expect(d).toContain("[800 more lines. Use offset=201 to continue.]");
    await expect(tool.execute("c", { tool_use_id: "nope" } as never)).rejects.toThrow(/no stored output for tool call nope/);
  });

  it("createTools rejects unknown builtin names", () => {
    expect(() => createTools(["bash", "rm" as never], { sandbox: async () => memSandbox() })).toThrow(/Unknown builtin tool: rm/);
  });
});

describe("truncateOutput", () => {
  it("keeps head and tail and reports the dropped count", () => {
    expect(truncateOutput("short", 10)).toBe("short");
    expect(truncateOutput("0123456789abcdef", 10, " note")).toBe("01234\n\n[... 6 chars truncated ... note]\n\nbcdef");
  });
});
