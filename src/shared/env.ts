export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://pi:pi@localhost:5432/pi",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  QODER_BASE_URL: process.env.QODER_BASE_URL ?? "http://127.0.0.1:4141/v1",
  /** The qoder proxy ignores the bearer token, but pi-ai refuses to send a request without one. */
  QODER_API_KEY: process.env.QODER_API_KEY || "qoder",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  SANDBOX_DEFAULT_PROVIDER: (process.env.SANDBOX_DEFAULT_PROVIDER ?? "local") as "local" | "docker",
  SANDBOX_LOCAL_ROOT: process.env.SANDBOX_LOCAL_ROOT ?? "./data/sandboxes",
  /**
   * Where SANDBOX_LOCAL_ROOT lives on the docker *host*. Needed by the docker provider when the
   * runner itself is a container: `docker run -v` is interpreted by the host daemon, so bind mounts
   * must use host paths. Empty means "the runner is on the host" (paths are used verbatim).
   */
  SANDBOX_HOST_ROOT: process.env.SANDBOX_HOST_ROOT ?? "",
  SANDBOX_IDLE_TTL_MS: Number(process.env.SANDBOX_IDLE_TTL_MS ?? 600000),
  API_PORT: Number(process.env.API_PORT ?? 8080),
  MAX_TURNS: Number(process.env.MAX_TURNS ?? 50),
};
