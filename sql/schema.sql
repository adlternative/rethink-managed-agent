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
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sandboxes_affinity ON sandboxes(affinity) WHERE status <> 'destroyed';
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
