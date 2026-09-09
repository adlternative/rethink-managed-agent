export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://pi:pi@localhost:5432/pi",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
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
  SANDBOX_IDLE_TTL_MS: Number(process.env.SANDBOX_IDLE_TTL_MS ?? 600000),
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
  API_PORT: Number(process.env.API_PORT ?? 8080),
  MAX_TURNS: Number(process.env.MAX_TURNS ?? 50),
  /** Default and hard cap for a single bash tool call. */
  BASH_TIMEOUT_MS: Number(process.env.BASH_TIMEOUT_MS ?? 600000),
  BASH_MAX_TIMEOUT_MS: Number(process.env.BASH_MAX_TIMEOUT_MS ?? 900000),
  /** Wall-clock cap for one run (all turns); exceeding it aborts with a session.error. */
  RUN_TIMEOUT_MS: Number(process.env.RUN_TIMEOUT_MS ?? 1800000),
};
