import { describe, expect, it, vi } from "vitest";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSession } from "../src/harness/run-turn.ts";
import { settledAfterLastMessage } from "../src/harness/fold.ts";
import { buildModelRegistry, resolveModel } from "../src/harness/models.ts";
import { captureGit } from "../src/sandbox/workspace.ts";
import type { ProviderResource, SessionEvent, SessionEventPayload } from "../src/shared/types.ts";
import { fakeDeps, text, userMsg } from "./fixtures/harness-fakes/deps.ts";

const run = promisify(execFile);
const log = (...payloads: SessionEventPayload[]): SessionEvent[] => payloads.map((payload, i) => ({ id: `e${i + 1}`, session_id: "s", seq: i + 1, type: payload.type, payload, created_at: "2026-01-01T00:00:00.000Z" }));

describe("settledAfterLastMessage (children.wait / agents.status)", () => {
  it("a reply sent after the previous turn's idle is not settled until a later idle", () => {
    const first = [userMsg("task"), { type: "session.status_running" }, { type: "session.status_idle", stop_reason: "end_turn", consumed_seq: 1 }] as SessionEventPayload[];
    expect(settledAfterLastMessage(log(...first))).toBe(true);
    expect(settledAfterLastMessage(log(...first, userMsg("[reply to question q] yes")))).toBe(false);
    expect(settledAfterLastMessage(log(...first, userMsg("reply"), { type: "session.status_running" }, { type: "session.status_idle", stop_reason: "end_turn", consumed_seq: 4 }))).toBe(true);
  });

  it("an idle that did not consume a steered message is not the one that counts", () => {
    const steered = log(userMsg("a"), { type: "session.status_running" }, userMsg("steer"), { type: "session.status_idle", stop_reason: "end_turn", consumed_seq: 1 });
    expect(settledAfterLastMessage(steered)).toBe(false);
  });
});

describe("runSession claim outcomes", () => {
  it("a terminated session reports 'terminated' (the queue drops the job) instead of 'busy' (retried forever)", async () => {
    const f = fakeDeps({ events: [userMsg("hi")] });
    f.deps.claimRun = async () => "terminated";
    expect(await runSession("sess_1", f.deps)).toEqual({ status: "terminated" });
    expect(f.unsubscribed).toBe(1);
    expect(f.finishCalls).toEqual([]);
  });

  it("a run failing before the fold still counts the messages before its claim as consumed (no follow-up loop)", async () => {
    const f = fakeDeps({ events: [userMsg("hi")], replies: [text("ok")] });
    f.deps.vaultSecrets = async () => { throw new Error("decrypt failed"); };
    await runSession("sess_1", f.deps);
    expect(f.finishCalls).toEqual([{ stopReason: "error", consumedSeq: 2 }]); // seq 2 = this run's status_running
  });
});

describe("resolveModel tenant isolation (runner side)", () => {
  const T = "2026-01-01T00:00:00.000Z";
  const row = (id: string, owner_id: string): ProviderResource => ({ id, owner_id, name: id, api: "openai-completions", base_url: "https://x", headers: {}, auth: { type: "none" }, models: [{ id: "m", context_window: 1000 }], enabled: true, created_at: T, updated_at: T });

  it("another tenant's provider is unknown to a session owner; the owner's own and operator providers resolve", () => {
    const models = buildModelRegistry([row("acme", "prc_a"), row("shared", "prc_local")]);
    expect(() => resolveModel(models, { provider: "acme", id: "m" }, "prc_b")).toThrow(/Unknown model acme\/m/);
    expect(resolveModel(models, { provider: "acme", id: "m" }, "prc_a").provider).toBe("acme");
    expect(resolveModel(models, { provider: "shared", id: "m" }, "prc_b").provider).toBe("shared");
  });
});

describe("captureGit on a sandbox-writable repo", () => {
  it("does not run clean filters or textconv drivers defined by the repo", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "fix-git-"));
    const dir = path.join(tmp, "repo");
    const git = (...a: string[]) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir });
    await run("mkdir", ["-p", dir]);
    await git("init", "-q");
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "init");
    const marker = path.join(tmp, "PWNED");
    await git("config", "filter.x.clean", `touch ${marker}; cat`);
    await git("config", "diff.y.textconv", `touch ${marker}; cat`);
    await writeFile(path.join(dir, ".gitattributes"), "a.txt filter=x diff=y\n");
    await writeFile(path.join(dir, "a.txt"), "two\n");
    const ref = await captureGit(dir, { kind: "git", remote: "r", base: "x" });
    expect(await stat(marker).then(() => true, () => false)).toBe(false);
    expect((ref as { patch?: string }).patch).toMatch(/two/);
    vi.restoreAllMocks();
  });
});
