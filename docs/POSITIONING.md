# Positioning — where rethink-managed-agent wins

Managed-agent products keep shipping: OpenAI Agents API, Claude Managed Agents, Qoder Cloud Agent,
and now Moonshot **Kimi** and Zhipu **GLM**. That is not a threat to this project — it is the reason
it exists.

## The thesis

**rethink is not another managed-agent vendor. It is the vendor-neutral, self-hostable runtime that
runs any of their agent workloads on your own infrastructure, with your choice of model, swappable by
a config row.** The more managed-agent vendors appear, the more valuable a layer that sits *above* all
of them becomes — betting your product on one vendor's hosted runtime is now the risky choice; rethink
is the hedge.

Every hosted offering makes the same three coupling choices, by construction:

1. **Model-locked** — OpenAI runs OpenAI, Claude runs Anthropic, Kimi runs Moonshot, GLM runs Zhipu.
2. **Sandbox bound to the session** — the box is the session; lose it and you lose the run.
3. **Your data on their cloud** — the event log and sandbox live on the vendor's infra.

rethink inverts all three, and — because Kimi and GLM's APIs are **OpenAI-compatible**, and GLM-5.2
ships as **MIT open weights** — the inversion is not theoretical.

## The advantage, made concrete

| Axis | OpenAI / Claude / Kimi / GLM (hosted) | rethink-managed-agent |
|---|---|---|
| **Model** | one vendor's models | any provider row (BYOK); OpenAI- or Anthropic-compatible — Qoder, Kimi, GLM, OpenAI, Anthropic |
| **Fully self-hosted** | no (Kimi/GLM cloud too) | yes — Postgres/Redis/MinIO + api + runner, all yours |
| **Air-gapped option** | no | yes — GLM-5.2 **open weights** on vLLM + rethink + BYOC sandbox = no outside call |
| **Sandbox ↔ session** | 1:1, bound | N:N — disposable lease, rebuildable from the workspace ref, shared across a spawn tree |
| **State of truth** | vendor-internal | your append-only event log — exportable, replayable, auditable |
| **Multi-tenancy** | the account (their tenant) | first-class `principal` on every resource; bring-your-own-identity resolver |
| **Extensibility** | vendor's tool catalog | pi-style plugins in a capability sandbox + real MCP-over-HTTP client |
| **API lock-in** | their SDK | **OpenAI Agents API-compatible** surface — run their showcases on your stack |

The punchline: **rethink speaks the OpenAI Agents API and takes any OpenAI-compatible model, so the
exact same agent app runs on OpenAI, Kimi, or GLM by changing one string — on your own cloud.**

## How to show it (runnable)

1. **Cross-vendor portability** (`demos/cross-vendor.sh`). Register Kimi and GLM as provider rows
   (both OpenAI-compatible), then run the *same* `examples/docs-qa` (or `sev-bot`) against each by
   changing only the model. Same compat API, same code, different vendor. This is the differentiation
   you can watch: model portability with no rewrite.

2. **The structural demos** (`demos/`, `make demo`). N:N sandbox, disposable-and-rebuilt sandbox,
   shared container, provider swap, pause/resume — properties a session-bound hosted product cannot
   offer. Each prints event-log evidence.

3. **The compat examples** (`examples/`). sev-bot (client tools + approval), code-agent (sandbox
   code exec), doc-review (multi-agent), docs-qa (real MCP) — OpenAI's own showcase shapes, running
   vendor-neutral on your stack.

4. **The air-gap story**. GLM-5.2 open weights on vLLM as a provider row + a BYOC sandbox worker in
   your VPC = a managed-agent stack with no call leaving your network. Narrate it; it is the one thing
   no hosted vendor can match.

## One-liner for a deck

> Kimi and GLM just proved every model vendor will ship a managed agent. rethink is the runtime that
> runs all of them — on your cloud, with your model, behind your tenancy — and speaks the OpenAI
> Agents API so you never rewrite the app.

## Prior art, and where we differ

*(moved here from the README)*

We genuinely admire the architecture of OpenAI's Agents API and Anthropic's Managed Agents. They got the
decomposition right: a **brain–hands split** where the model does the thinking and a managed sandbox does
the doing, with a durable session on top. Independently, this project arrived at nearly the same object
model (agent / session / environment / events), which is the strongest evidence that split is correct. If
you want the fastest path to a hosted agent with zero ops, use them — they are excellent.

Two things about those designs we think are not good enough, and set out to fix:

- **They bind you to one cloud vendor.** The model is the vendor's, the sandbox runs on the vendor's infra,
  and your event log lives there too. You cannot bring your own model, run it in your own VPC, or take the
  agent air-gapped. rethink makes the model a provider row (BYOK, any OpenAI/Anthropic-compatible endpoint),
  the sandbox a pluggable provider (local/docker/e2b/BYOC), and the whole stack self-hostable.
- **The architecture is not elegant enough.** The sandbox is welded 1:1 to the session, so state is split
  between an opaque platform store and a live container: suspend/resume means freezing a box, a session
  can't span or swap sandboxes, and the loop's truth is hidden inside the vendor. rethink keeps the same
  brain–hands split but makes the **event log the only source of truth** and the **sandbox a disposable
  lease** — session, workspace, and sandbox become three independent lifecycles that compose freely (N:N,
  rebuildable, shareable). Everything above core — sub-agents, approval, plan mode — is a plugin, not
  platform.

It is the same good idea, decoupled and made portable. See `docs/POSITIONING.md` for the full comparison.
