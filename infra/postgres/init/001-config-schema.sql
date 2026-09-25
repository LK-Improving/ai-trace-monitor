CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  retention_days SMALLINT NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  environment VARCHAR(32) NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  sdk_version VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name, environment)
);

CREATE TABLE IF NOT EXISTS project_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  key_prefix VARCHAR(24) NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['spans:write'],
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  metric VARCHAR(64) NOT NULL,
  operator VARCHAR(16) NOT NULL,
  threshold DOUBLE PRECISION NOT NULL,
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  level VARCHAR(16) NOT NULL DEFAULT 'warning' CHECK (level IN ('info', 'warning', 'critical')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
  trace_id VARCHAR(128),
  level VARCHAR(16) NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'closed', 'muted')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id VARCHAR(160) NOT NULL,
  role VARCHAR(32) NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  actor_id VARCHAR(160),
  action VARCHAR(120) NOT NULL,
  resource VARCHAR(240) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_services_project ON services (project_id, environment);
CREATE INDEX IF NOT EXISTS idx_project_keys_project ON project_keys (project_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_items_project_created ON alert_items (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created ON audit_logs (project_id, created_at DESC);
