-- W21-W24 built-in alert incidents and idempotent Span occurrence ledger.
-- This file is also applied on API and Collector startup so existing Compose
-- volumes receive the schema upgrade (initdb scripts run only on new volumes).

CREATE TABLE IF NOT EXISTS alert_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment VARCHAR(32) NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  service VARCHAR(120) NOT NULL,
  rule VARCHAR(64) NOT NULL CHECK (rule IN (
    'span_error',
    'span_latency',
    'llm_token_threshold',
    'rag_empty_recall'
  )),
  title VARCHAR(160) NOT NULL,
  message VARCHAR(500) NOT NULL,
  level VARCHAR(16) NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  state VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'acknowledged', 'resolved')),
  trace_id VARCHAR(128) NOT NULL,
  span_id VARCHAR(128) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  trigger_count BIGINT NOT NULL DEFAULT 1 CHECK (trigger_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_incidents_scope_state_last_seen
  ON alert_incidents (project_id, environment, service, rule, state, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_incidents_project_last_seen
  ON alert_incidents (project_id, last_seen_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS alert_occurrences (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment VARCHAR(32) NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  service VARCHAR(120) NOT NULL,
  rule VARCHAR(64) NOT NULL CHECK (rule IN (
    'span_error',
    'span_latency',
    'llm_token_threshold',
    'rag_empty_recall'
  )),
  trace_id VARCHAR(128) NOT NULL,
  span_id VARCHAR(128) NOT NULL,
  alert_id UUID REFERENCES alert_incidents(id) ON DELETE SET NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment, service, rule, trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_alert_occurrences_project_created
  ON alert_occurrences (project_id, created_at DESC);
