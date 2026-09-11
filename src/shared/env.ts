export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://pi:pi@localhost:5432/pi",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  /** Messaging backend for the run queue + event bus: "redis" (default; cross-process), "postgres" (cross-process, no Redis — the whole stack on Postgres alone), or "memory" (single-process dev/test). BYOC needs "redis". */
  MESSAGING_BACKEND: (process.env.MESSAGING_BACKEND ?? "redis") as "redis" | "postgres" | "memory",
  QODER_BASE_URL: process.env.QODER_BASE_URL ?? "http://127.0.0.1:4141/v1",
  /** The qoder proxy ignores the bearer token, but pi-ai refuses to send a request without one. */
  QODER_API_KEY: process.env.QODER_API_KEY || "qoder",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  SANDBOX_DEFAULT_PROVIDER: (process.env.SANDBOX_DEFAULT_PROVIDER ?? "local") as "local" | "docker" | "e2b",
  /** Ephemeral sandbox dirs (reaped when idle). */
  SANDBOX_LOCAL_ROOT: process.env.SANDBOX_LOCAL_ROOT ?? "./data/sandboxes",
  /** Persistent `dir` workspaces; captured into from sandboxes, never reaped. */
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT ?? "./data/workspaces",
  /**
   * Where `{kind:"local", path}` workspace specs may point. Empty (default) rejects them: a local
   * spec makes an arbitrary runner-host directory the workdir (and a docker bind mount).
   */
  LOCAL_WORKSPACE_ALLOW_ROOT: process.env.LOCAL_WORKSPACE_ALLOW_ROOT ?? "",
  /**
   * Where SANDBOX_LOCAL_ROOT lives on the docker *host*. Needed by the docker provider when the
   * runner itself is a container: `docker run -v` is interpreted by the host daemon, so bind mounts
   * must use host paths. Empty means "the runner is on the host" (paths are used verbatim).
   */
  SANDBOX_HOST_ROOT: process.env.SANDBOX_HOST_ROOT ?? "",
  /** Idle tiers: ready -> paused after IDLE_TTL (providers without pause destroy instead); paused -> destroyed after PAUSED_TTL. */
  SANDBOX_IDLE_TTL_MS: Number(process.env.SANDBOX_IDLE_TTL_MS ?? 600000),
  SANDBOX_PAUSED_TTL_MS: Number(process.env.SANDBOX_PAUSED_TTL_MS ?? 24 * 3600 * 1000),
  /** Docker sandbox limits. Network defaults to none: model code gets no egress unless an operator opts in. */
  SANDBOX_DOCKER_NETWORK: process.env.SANDBOX_DOCKER_NETWORK ?? "none",
  SANDBOX_DOCKER_MEMORY: process.env.SANDBOX_DOCKER_MEMORY ?? "2g",
  SANDBOX_DOCKER_CPUS: process.env.SANDBOX_DOCKER_CPUS ?? "2",
  SANDBOX_DOCKER_PIDS: process.env.SANDBOX_DOCKER_PIDS ?? "512",
  /** e2b cloud sandboxes (https://e2b.dev). Empty key disables the provider. */
  E2B_API_KEY: process.env.E2B_API_KEY ?? "",
  E2B_TEMPLATE: process.env.E2B_TEMPLATE ?? "base",
  /** Lifetime asked of e2b on acquire (refreshed on every acquire). Keep >= SANDBOX_IDLE_TTL_MS so reuse works. */
  E2B_SANDBOX_TIMEOUT_MS: Number(process.env.E2B_SANDBOX_TIMEOUT_MS ?? 1200000),
  /** Per-agent pi agentDir root: packages (extensions/skills/prompts) are installed under <root>/<agent_id>. */
  PI_AGENT_ROOT: process.env.PI_AGENT_ROOT ?? "./data/pi-agents",
  /** Hostnames plugins may fetch through ctx.fetch ("*" = any). Empty denies all. */
  PLUGIN_FETCH_ALLOW: process.env.PLUGIN_FETCH_ALLOW ?? "*",
  /** When true the API rejects requests without a valid bearer token; when false, unauthenticated requests act as PMA_DEFAULT_PRINCIPAL. */
  AUTH_REQUIRED: (process.env.AUTH_REQUIRED ?? "false") === "true",
  /** The principal unauthenticated (dev) requests act as. Seeded by the schema. */
  PMA_DEFAULT_PRINCIPAL: process.env.PMA_DEFAULT_PRINCIPAL ?? "prc_local",
  /** Module (default-exporting a PrincipalResolver) that maps a credential to a principal. Empty = built-in Bearer/api_keys. This is the seam for bringing your own identity (JWT/OIDC, a trusted gateway header, per-tenant key). */
  PRINCIPAL_RESOLVER: process.env.PRINCIPAL_RESOLVER ?? "",
  /** trusted-header resolver only: the header an upstream (already-authenticated) gateway sets to the principal id. */
  TRUSTED_PRINCIPAL_HEADER: process.env.TRUSTED_PRINCIPAL_HEADER ?? "x-principal-id",
  /** Experimental: host pi-coding-agent's AgentSession instead of the pma plugin host. */
  EXPERIMENTAL_PI_PACKAGES: process.env.EXPERIMENTAL_PI_PACKAGES === "1",
  /** Runs a runner handles concurrently (sub-agent sessions need > 1). */
  RUNNER_CONCURRENCY: Number(process.env.RUNNER_CONCURRENCY ?? 4),
  /** Context compaction (pi heuristics): compact when tokens > contextWindow - reserve; keep ~keepRecent tokens of recent turns. */
  COMPACTION_ENABLED: process.env.COMPACTION_ENABLED !== "0",
  COMPACTION_RESERVE_TOKENS: Number(process.env.COMPACTION_RESERVE_TOKENS ?? 16384),
  COMPACTION_KEEP_RECENT_TOKENS: Number(process.env.COMPACTION_KEEP_RECENT_TOKENS ?? 20000),
  /** 32-byte key (base64/hex) that encrypts user-supplied provider credentials at rest (BYOK). */
  PMA_SECRET_KEY: process.env.PMA_SECRET_KEY ?? "",
  /** S3-compatible blob store for files and memory snapshots (MinIO in compose). Unset = keep bytes in Postgres. */
  /** Blob backend: "s3" (BLOB_ENDPOINT), "fs" (BLOB_DIR), or "" = auto (fs if BLOB_DIR, else s3 if BLOB_ENDPOINT, else none -> Postgres inline). */
  BLOB_BACKEND: process.env.BLOB_BACKEND ?? "",
  /** Local filesystem blob store directory (the "fs" backend). */
  BLOB_DIR: process.env.BLOB_DIR ?? "",
  BLOB_ENDPOINT: process.env.BLOB_ENDPOINT ?? "",
  BLOB_BUCKET: process.env.BLOB_BUCKET ?? "pma",
  BLOB_REGION: process.env.BLOB_REGION ?? "us-east-1",
  BLOB_ACCESS_KEY: process.env.BLOB_ACCESS_KEY ?? "",
  BLOB_SECRET_KEY: process.env.BLOB_SECRET_KEY ?? "",
  API_PORT: Number(process.env.API_PORT ?? 8080),
  /** structured logging */
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  LOG_FORMAT: process.env.LOG_FORMAT ?? "json",
  /** the runner serves Prometheus metrics on this port (0 disables) */
  RUNNER_METRICS_PORT: Number(process.env.RUNNER_METRICS_PORT ?? 9090),
  /** max JSON request body (bytes) on the API; the multipart /v1/files route has its own larger cap */
  API_MAX_BODY_BYTES: Number(process.env.API_MAX_BODY_BYTES ?? 4_000_000),
  MAX_TURNS: Number(process.env.MAX_TURNS ?? 50),
  /** Default and hard cap for a single bash tool call. */
  BASH_TIMEOUT_MS: Number(process.env.BASH_TIMEOUT_MS ?? 600000),
  BASH_MAX_TIMEOUT_MS: Number(process.env.BASH_MAX_TIMEOUT_MS ?? 900000),
  /** Wall-clock cap for one run (all turns); exceeding it aborts with a session.error. */
  RUN_TIMEOUT_MS: Number(process.env.RUN_TIMEOUT_MS ?? 1800000),
  /** How long a client/function tool call waits in-turn for the caller's tool_result before returning a timeout error. Must be < RUN_TIMEOUT_MS. */
  CLIENT_TOOL_WAIT_MS: Number(process.env.CLIENT_TOOL_WAIT_MS ?? 300000),
  // ---- OpenAI Agents API compatibility layer (/agents-api/v1) ----
  /** Default rethink provider for an OpenAI model string with no explicit "provider/" prefix. */
  COMPAT_DEFAULT_PROVIDER: process.env.COMPAT_DEFAULT_PROVIDER ?? "qoder",
  /** JSON map of OpenAI model string -> "provider/id" (or bare id), e.g. {"sev-astra":"qoder/ultimate"}. */
  COMPAT_MODEL_MAP: process.env.COMPAT_MODEL_MAP ?? "{}",
  /** Environment id backing OpenAI environment.type when no environment_id is given (self_hosted / openai_hosted). */
  COMPAT_DEFAULT_ENVIRONMENT: process.env.COMPAT_DEFAULT_ENVIRONMENT ?? "",
  /** Package added when agent.multi_agent.enabled is set (e.g. a team plugin path); empty = advisory no-op. */
  COMPAT_TEAM_PACKAGE: process.env.COMPAT_TEAM_PACKAGE ?? "",
  /** Package added when a {type:'web_search'} tool is declared (e.g. the web-search plugin path); empty = accepted-and-ignored. */
  COMPAT_WEBSEARCH_PACKAGE: process.env.COMPAT_WEBSEARCH_PACKAGE ?? "",
};
