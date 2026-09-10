# Architecture demos

Each script drives the **real** `SandboxManager` and the **real** providers (`local` / `docker` /
`e2b`). The only thing faked is the lease store — it runs in memory (`demos/lib.ts`) so a demo needs
**no Postgres, redis, minio, API, or runner**. The docker demos need a running docker daemon; they
skip themselves cleanly if one isn't present. Nothing here runs a privileged or destructive command.

```bash
npm install
bash demos/run.sh            # all five
bash demos/run.sh 03-shared-container   # just one
# or: make demo
```

To record them as animated GIFs (into `demos/gifs/`, git-ignored — regenerate any time), run
`bash demos/record.sh`. It captures each demo's real output and renders a terminal-style GIF with
Pillow, no external screen recorder needed (needs `python3` + Pillow and a monospace font; override
the font with `DEMO_FONT=/path/to.ttf`).

Every demo prints its ground-truth evidence: the sandbox rows (id, provider, status, container_key,
container_ref, workspace). That container_ref column is where the claims become visible — several
sandboxes sharing one `container=…` is a shared runtime; a workspace surviving across different
`id=…` rows is the sandbox being disposable.

## What each one proves

| # | Demo | Claim it makes concrete |
|---|------|--------------------------|
| 01 | `nn-session-sandbox` | Sessions↔sandboxes are **N:N**. One session drives two sandboxes at once; a workspace outlives its sandbox and a *different* session resumes it. |
| 02 | `sandbox-disposable` | The **session is the truth**, the sandbox is disposable. We destroy a running sandbox mid-work and rebuild the exact state in a fresh one from the captured ref. |
| 03 | `shared-container` | A parent and its sub-agents **share one container** (one PID namespace, one `/host` filesystem, warm caches) while keeping **separate working directories** — no git worktree. |
| 04 | `provider-swap` | The sandbox layer is **pluggable**. The same workspace and the same call site run on `local` then `docker`; a workspace captured on one materializes on the other. |
| 05 | `pause-resume` | **Idle tiers.** An idle container is paused (`docker pause` / e2b snapshot) with its processes frozen in place, resumed in place on the next turn, and only destroyed after a longer TTL. |

## Why heavy products can't do these

Claude Managed Agent and Qoder Cloud Agent bind **one sandbox to one session for that session's
whole life**. That single decision forecloses all five:

- **N:N (01):** a session can't fan out across environments, and its sandbox can't be reused by
  another session.
- **Disposable (02):** losing the box loses the session; there's no capture/rebuild seam because the
  box *is* the state.
- **Shared container (03):** sub-agents get their own boxes, so they can't share a dev server, a
  warmed cache, or built `node_modules`; coordinating them means copying artifacts between boxes.
- **Provider swap (04):** you're on the vendor's one managed runtime; you can't lift a workspace onto
  your own docker or e2b (no BYOC).
- **Idle tiers (05):** you either pay to hold the box hot for the whole session, or it's tiered down
  by cold-start, losing in-box state.

The root cause here is the opposite choice: **events are the only source of truth**, the **workspace**
is a portable ref, and the **sandbox** is an ephemeral lease over a pluggable provider. Session,
workspace, and sandbox have three independent lifecycles, so they compose freely.

See `../DESIGN.md` (§11 N:N, §12 idle tiers, §13 BYOC/BYOK, §14 multi-agent) and the architecture
diagram (`make diagram` → `docs/architecture.html`, spec in `docs/architecture.archify.json`).
