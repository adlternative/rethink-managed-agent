CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model JSONB NOT NULL,
  system TEXT,
  tools JSONB NOT NULL DEFAULT '["bash","read","write","edit"]',
  packages JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api TEXT NOT NULL,
  base_url TEXT NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}',
  auth JSONB NOT NULL DEFAULT '{"type":"none"}',
  models JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  image TEXT,
  network TEXT NOT NULL DEFAULT 'none',
  plugin_host TEXT NOT NULL DEFAULT 'runner',
  worker_key TEXT,
  workspace JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  spec JSONB NOT NULL,
  ref JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace_id TEXT,
  affinity TEXT,
  external_ref TEXT,
  container_key TEXT,
  container_ref TEXT,
  workdir TEXT,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sandboxes_affinity ON sandboxes(affinity) WHERE status <> 'destroyed';
CREATE INDEX IF NOT EXISTS sandboxes_container ON sandboxes(container_key) WHERE status <> 'destroyed';
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  status TEXT NOT NULL DEFAULT 'idle',
  agent JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session_environments (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key)
);
-- append-only. (session_id, seq) is the cursor; never UPDATE rows.
CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS packages JSONB NOT NULL DEFAULT '[]';
-- full outputs of tool calls whose result was truncated for the model (spill-to-store)
CREATE TABLE IF NOT EXISTS tool_outputs (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, tool_use_id)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  blob_key TEXT,           -- set when bytes live in the blob store
  data BYTEA,              -- set when no blob store is configured
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  display_title TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  latest_version TEXT NOT NULL DEFAULT '1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memory_stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  ref JSONB NOT NULL DEFAULT '{"kind":"empty"}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- plugin key/value store (scope = 'agent' | 'workspace'; owner = agent_id | workspace_id)
CREATE TABLE IF NOT EXISTS plugin_store (
  scope TEXT NOT NULL,
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, owner, key)
);
ALTER TABLE environments ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'none';
ALTER TABLE environments ADD COLUMN IF NOT EXISTS plugin_host TEXT NOT NULL DEFAULT 'runner';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_id TEXT;
INSERT INTO session_environments (session_id, key, environment_id, workspace_id)
  SELECT id, 'main', environment_id, workspace_id FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM session_environments e WHERE e.session_id = s.id) ON CONFLICT DO NOTHING;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS usage JSONB NOT NULL DEFAULT '{"input":0,"output":0,"cache_read":0,"cache_write":0,"total_tokens":0,"requests":0}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context JSONB;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS worker_key TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS memory_stores JSONB NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_system_prompt TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS container_group TEXT;
UPDATE sessions SET container_group = id WHERE container_group IS NULL;

-- ============================================================================
-- Principals & ownership (multi-tenant phase 1)
-- A principal is the polymorphic owner/actor: a user, an org, or a service are
-- all principals, so extending to orgs later is new rows + a memberships table,
-- not a schema-wide migration. Every top-level resource references principals(id).
-- ============================================================================
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'user',        -- 'user' | 'org' | 'service'
  handle TEXT UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The built-in local/dev principal that owns everything created before auth existed.
INSERT INTO principals (id, kind, handle, display_name)
  VALUES ('prc_local', 'user', 'local', 'Local User') ON CONFLICT (id) DO NOTHING;

-- Bearer tokens (stored as sha256) that authenticate a request as a principal (the actor).
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_principal ON api_keys(principal_id);

-- owner_id on every top-level resource. DEFAULT backfills existing rows to prc_local.
ALTER TABLE agents        ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'prc_local' REFERENCES principals(id);
ALTER TABLE environments  ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'prc_local' REFERENCES principals(id);
ALTER TABLE workspaces    ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'prc_local' REFERENCES principals(id);
ALTER TABLE providers     ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'prc_local' REFERENCES principals(id);
ALTER TABLE files         ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'prc_local' REFERENCES principals(id);
ALTER TABLE skills        ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'prc_local' REFERENCES principals(id);
ALTER TABLE memory_stores ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'prc_local' REFERENCES principals(id);
ALTER TABLE sessions      ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'prc_local' REFERENCES principals(id);
CREATE INDEX IF NOT EXISTS agents_owner        ON agents(owner_id);
CREATE INDEX IF NOT EXISTS environments_owner  ON environments(owner_id);
CREATE INDEX IF NOT EXISTS workspaces_owner    ON workspaces(owner_id);
CREATE INDEX IF NOT EXISTS providers_owner     ON providers(owner_id);
CREATE INDEX IF NOT EXISTS files_owner         ON files(owner_id);
CREATE INDEX IF NOT EXISTS skills_owner        ON skills(owner_id);
CREATE INDEX IF NOT EXISTS memory_stores_owner ON memory_stores(owner_id);
CREATE INDEX IF NOT EXISTS sessions_owner      ON sessions(owner_id);

-- ============================================================================
-- Phase 2: owner-keyed isolation
-- ============================================================================
-- Sandboxes belong to a principal too (ephemeral, so nullable + no FK). The ops
-- view (/v1/sandboxes) filters on it; container_key already carries the owner as
-- a prefix so a container is never shared across principals.
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS owner_id TEXT;
CREATE INDEX IF NOT EXISTS sandboxes_owner ON sandboxes(owner_id) WHERE status <> 'destroyed';
-- Per-principal plugin fetch allowlist (comma list of hosts, or '*'); NULL falls back to PLUGIN_FETCH_ALLOW.
ALTER TABLE principals ADD COLUMN IF NOT EXISTS fetch_allow TEXT;

-- ============================================================================
-- Postgres messaging backend (MESSAGING_BACKEND=postgres): run the whole stack on
-- Postgres alone, with no Redis. Queue via FOR UPDATE SKIP LOCKED + LISTEN/NOTIFY;
-- steer + per-call tool results as small tables. (Redis stays the default.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS run_jobs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger_seq BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | running
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_jobs_pending ON run_jobs(id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS run_jobs_running ON run_jobs(claimed_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS steer_msgs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS steer_msgs_session ON steer_msgs(session_id, id);

CREATE TABLE IF NOT EXISTS tool_result_msgs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_result_msgs_key ON tool_result_msgs(session_id, call_id, id);

-- Per-tenant brain routing: a runner scoped via RUNNER_OWNERS claims only its owners' jobs.
ALTER TABLE run_jobs ADD COLUMN IF NOT EXISTS owner_id TEXT;
CREATE INDEX IF NOT EXISTS run_jobs_pending_owner ON run_jobs(owner_id, id) WHERE status = 'pending';

-- Vaults: named, per-principal encrypted secrets injected into a session's sandbox as env vars.
-- The secret ciphertext never leaves the DB and is never returned by the API (write-only).
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vaults_owner ON vaults(owner_id, id);

CREATE TABLE IF NOT EXISTS vault_credentials (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  secret JSONB NOT NULL, -- Sealed (AES-256-GCM); never returned by the API
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, name)
);
-- Typed credentials: an env var injected into the sandbox (the original kind, hence the default), or an
-- MCP credential the runner sends to the server at mcp_server_url. `refresh` holds the sealed mcp_oauth
-- refresh block; the access token itself lives in `secret` like every other value.
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'environment_variable';
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS mcp_server_url TEXT;
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS refresh JSONB;
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
-- Remote MCP servers an agent connects to. Credentials are NOT stored here: a session supplies them
-- from its vaults (or, on the OpenAI inline path, sealed into the session's own agent snapshot).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS mcp_servers JSONB NOT NULL DEFAULT '[]';

-- Compat-dialect fields: caller labels, the caller's function-tool declarations, and whatever a dialect
-- must echo back verbatim (its declared tool list, reasoning/verbosity knobs). The engine reads none of it.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS client_tools JSONB NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS compat JSONB NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- One credential per MCP server in a vault (the URL is the match key, so a second one would be ambiguous).
CREATE UNIQUE INDEX IF NOT EXISTS vault_credentials_mcp_url ON vault_credentials(vault_id, mcp_server_url) WHERE mcp_server_url IS NOT NULL;

-- Vaults whose secrets are injected into this session's sandboxes.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vault_ids TEXT[] NOT NULL DEFAULT '{}';

-- Hot-path indexes. A non-concurrent index build blocks writes to its table: on a large existing
-- deployment, build these beforehand with the CONCURRENTLY option (same names) and this becomes a no-op.
-- Session list pages: WHERE owner_id ORDER BY created_at DESC, id DESC LIMIT n (no sort of the whole tenant).
CREATE INDEX IF NOT EXISTS sessions_owner_created ON sessions(owner_id, created_at DESC, id DESC);
-- Sub-agent lookups (childrenOf, subagent routes, runner children.list).
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id, created_at) WHERE parent_id IS NOT NULL;
-- BYOC worker reconnect: idle sessions of an environment.
CREATE INDEX IF NOT EXISTS sessions_env_status ON sessions(environment_id, status);
-- Reaper / lease store: live mounts of a container.
CREATE INDEX IF NOT EXISTS sandboxes_container_ref ON sandboxes(container_ref) WHERE status <> 'destroyed';
-- Latest event of a type without walking the log (status/user.message probes, compaction cut, turns).
CREATE INDEX IF NOT EXISTS events_session_type_seq ON events(session_id, type, seq);

-- Deleting an agent/environment that sessions still reference archives it instead (sessions keep an agent
-- snapshot and the runner still reads the environment): hidden from owner-scoped reads, unusable for new sessions.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
