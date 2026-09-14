import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { repos } from "../infra/db.ts";
import { appendEvents, latestMatching, latestOfTypes } from "../infra/events.ts";
import { pushSteer } from "../infra/pubsub.ts";
import { enqueueRun } from "../infra/queue.ts";
import { settledAfterLastMessage } from "../harness/fold.ts";
import type { ChildSpawn } from "../harness/run-turn.ts";
import { workspaceRoot } from "../sandbox/workspace.ts";
import type { WorkspaceRef } from "../shared/types.ts";

const run = promisify(execFile);

/** Fork a workspace for a child session: metadata refs are copied; `dir` refs are copied on disk (runner owns that volume). */
async function forkWorkspace(parentWorkspaceId: string) {
  const parent = await repos.workspaces.get(parentWorkspaceId);
  if (!parent) throw new Error(`workspace ${parentWorkspaceId} not found`);
  if (parent.ref.kind === "local") throw new Error("local workspaces cannot be forked");
  const child = await repos.workspaces.create(parent.spec, parent.ref, parent.owner_id);
  if (parent.ref.kind === "dir") {
    const dest = path.join(workspaceRoot(), child.id);
    await mkdir(dest, { recursive: true });
    await run("cp", ["-R", `${parent.ref.path}/.`, dest]);
    const ref: WorkspaceRef = { kind: "dir", path: dest };
    await repos.workspaces.updateRef(child.id, ref, parent.ref);
  }
  return child;
}

export const children: ChildSpawn = {
  async spawn(parent, envRow, task, opts = {}) {
    const ws = opts.shareWorkspace ? await repos.workspaces.get(envRow.workspace_id) : await forkWorkspace(envRow.workspace_id);
    if (!ws) throw new Error(`workspace ${envRow.workspace_id} not found`);
    const agent = { ...parent.agent };
    if (opts.system) agent.system = opts.system;
    if (opts.model) agent.model = opts.model;
    if (opts.tools) agent.tools = agent.tools.filter((t) => opts.tools!.includes(t));
    const child = await repos.sessions.create({
      owner_id: parent.owner_id,
      agent_id: parent.agent_id,
      environment_id: envRow.environment_id,
      workspace_id: ws.id,
      agent,
      environments: [{ key: "main", environment_id: envRow.environment_id, workspace_id: ws.id }],
      parent_id: parent.id,
      memory_stores: parent.memory_stores ?? [],
      container_group: parent.container_group,
    });
    const brief = [opts.role ? `You are the "${opts.role}" agent${opts.name ? ` (${opts.name})` : ""} working for a parent agent.` : "You are a sub-agent working for a parent agent.", "Use report_to_parent for progress, questions, and your final report.", "", task].join("\n");
    const [ev] = await appendEvents(child.id, [{ type: "user.message", content: [{ type: "text", text: brief }] }]);
    await enqueueRun({ session_id: child.id, trigger_seq: ev!.seq, owner_id: child.owner_id });
    return child;
  },
  async wait(childId, signal, opts = {}) {
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    for (;;) {
      if (signal.aborted) throw new Error("parent run aborted while waiting for child session");
      if (Date.now() > deadline) throw new Error(`timed out waiting for child ${childId}`);
      const s = await repos.sessions.get(childId);
      if (!s) throw new Error(`child session ${childId} disappeared`);
      if (s.status === "terminated") return s;
      // Both probes need only the newest user.message / status_idle / question, not the log (index lookups).
      if (s.status === "idle") {
        // idle *after* answering its newest message (a child starts idle before its job is claimed, and a
        // reply/steer to an idle child must not be mistaken as done because of the previous turn's idle)
        if (settledAfterLastMessage(await latestOfTypes(childId, ["user.message", "session.status_idle"]))) return s;
      }
      if (opts.untilQuestion) {
        const q = await latestMatching(childId, "agent.thread_message_sent", { kind: "question" });
        if (q && !(await latestOfTypes(childId, ["user.message"])).some((e) => e.seq > q.seq)) return s;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  },
  async list(parentId) {
    return repos.sessions.childrenOf(parentId);
  },
  async message(childId, text) {
    const s = await repos.sessions.get(childId);
    if (!s) throw new Error(`child session ${childId} not found`);
    const [ev] = await appendEvents(childId, [{ type: "user.message", content: [{ type: "text", text }] }]);
    if (s.status === "running") await pushSteer(childId, { seq: ev!.seq, content: ev!.payload.type === "user.message" ? ev!.payload.content : [] });
    else if (s.status === "idle") await enqueueRun({ session_id: childId, trigger_seq: ev!.seq, owner_id: s.owner_id });
  },
  async stop(childId) {
    const { publishInterrupt } = await import("../infra/pubsub.ts");
    await publishInterrupt(childId);
    await appendEvents(childId, [{ type: "session.status_terminated", reason: "stopped by parent" }], { status: "terminated" });
  },
};
