# Dynamic multi-agent workflows (`run_workflow`)

`plugins/workflow` gives an agent a `run_workflow` tool: a **deterministic JavaScript script** that
fans work out across child sessions and composes the results. It is the same shape as the
pi-subagents / Claude Code `Workflow` tool, but it runs inside the plugin host as an ordinary tool —
no special core support. Use it for parallel reviews, per-item migrations, verify loops, or any
pipeline that would overflow a single context.

## How it runs

The script body runs with `new Function` in the plugin host. Each `agent()` call spawns a **child
session on a fork of the workspace** (via `ctx.agents.spawn`) and joins it (`ctx.agents.wait`), so
children are parallel by construction and never write the same files. `Date.now()` and `Math.random()`
throw — a workflow must be reproducible (vary work by index or pass timestamps through `args`).

Enable it by putting the package on the agent and giving the runner enough slots for the children:

```bash
pma agents create reviewer qoder/kmodel --packages /app/plugins/workflow
# RUNNER_CONCURRENCY must exceed the number of concurrent children (sub-agent sessions need > 1)
```

The model then calls `run_workflow` with `{ script, args?, max_agents? }`. `max_agents` caps the total
`agent()` calls (default 16, hard max 50); the tool returns the script's return value plus a run log.

## Script API

A script starts with a `meta` literal (stripped before execution) and then a body:

```js
export const meta = { name: "review", description: "review changed files", phases: [{ title: "Review" }] }
// body:
phase("Review")
const findings = await agent("Review src/app.ts for bugs.", { schema: FINDINGS })
return findings
```

| in the body | what it does |
|---|---|
| `agent(prompt, opts?)` | spawn one child, wait, return its final report **string**. With `opts.schema` (a JSON Schema) the child is asked to return JSON and `agent()` returns the parsed object (or `null` if it didn't). Returns `null` if the child fails. |
| `parallel(thunks)` | `Promise.all` of `() => Promise` thunks; a thrown/failed thunk becomes `null` (filter with `.filter(Boolean)`). A barrier — awaits all. |
| `pipeline(items, ...stages)` | run each item through all stages independently, no barrier between stages. Each stage is `(prev, item, i) => Promise`. A stage that throws drops that item to `null`. |
| `phase(title)` | start a named phase; labels and the log group under it. |
| `log(msg)` | append a line to the run log shown to the user. |
| `args` | the `args` value passed to `run_workflow`, verbatim. |

`agent()` options: `{ label, phase, role, system, model, tools, maxTurns (20), timeoutS (900), schema }`.
`role`/`name`/`system`/`model`/`tools` are forwarded to the child session; `schema` also appends a
"return ONLY JSON matching this schema" instruction to the prompt.

## Examples

**Fan-out review — parallel dimensions, structured results:**

```js
export const meta = { name: "review", description: "review a file across dimensions", phases: [{ title: "Review" }] }
phase("Review")
const DIMS = ["correctness", "security", "performance"]
const FINDINGS = { type: "object", properties: { findings: { type: "array", items: { type: "string" } } }, required: ["findings"] }
const results = await parallel(DIMS.map((d) => () =>
  agent(`Review ${args.file} for ${d} issues.`, { label: `review:${d}`, phase: "Review", schema: FINDINGS })))
return results.filter(Boolean).flatMap((r) => r.findings)
```

Invoke with `args: { file: "src/app.ts" }`.

**Per-item pipeline — no barrier between stages (item A verifies while item B still drafts):**

```js
export const meta = { name: "migrate", description: "migrate then verify each file", phases: [{ title: "Migrate" }, { title: "Verify" }] }
const files = args.files // e.g. ["a.ts", "b.ts", "c.ts"]
const out = await pipeline(
  files,
  (file) => agent(`Migrate ${file} to the new API. Report what you changed.`, { phase: "Migrate", label: `migrate:${file}` }),
  (report, file) => agent(`Verify the migration of ${file}. Report PASS or FAIL with reasons.\n\n${report}`, { phase: "Verify", label: `verify:${file}` }),
)
return out
```

**Find → adversarially verify — a barrier where the verify stage needs all findings first:**

```js
export const meta = { name: "audit", description: "find bugs, then verify each", phases: [{ title: "Find" }, { title: "Verify" }] }
const BUGS = { type: "object", properties: { bugs: { type: "array", items: { type: "string" } } }, required: ["bugs"] }
phase("Find")
const found = (await parallel([1, 2].map((i) => () =>
  agent(`Find bugs in ${args.path} (pass ${i}, look for different ones than an obvious first pass).`, { schema: BUGS }))))
  .filter(Boolean).flatMap((r) => r.bugs)
phase("Verify")
const verdicts = await parallel(found.map((bug) => () =>
  agent(`Is this a real bug? Answer real:true/false with a reason.\n\n${bug}`, { label: `verify`, schema: { type: "object", properties: { real: { type: "boolean" }, reason: { type: "string" } }, required: ["real"] } })
    .then((v) => (v ? { bug, ...v } : null))))
return verdicts.filter((v) => v && v.real)
```

## When it is NOT the right tool

`run_workflow` is for **one fan-out with a known shape**. For long-lived orchestration where the
parent keeps talking to children over time, use `plugins/team` directly (`spawn_agent` / `wait_agents`
/ `message_agent`). Keep fleets small — children consume runner slots and tokens; `max_agents` is the
backstop, not a target.
