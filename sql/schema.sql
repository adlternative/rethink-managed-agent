CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model JSONB NOT NULL,
  system TEXT,
  tools JSONB NOT NULL DEFAULT '["bash","read","write","edit"]',
  packages JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  image TEXT,
  network TEXT NOT NULL DEFAULT 'none',
  plugin_host TEXT NOT NULL DEFAULT 'runner',
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
