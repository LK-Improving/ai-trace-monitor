-- W24-W27 project-scoped notification channels and durable delivery outbox.

CREATE TABLE IF NOT EXISTS alert_notification_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  channel_type VARCHAR(16) NOT NULL CHECK (channel_type IN ('webhook', 'email')),
  environment VARCHAR(32) NOT NULL CHECK (environment IN ('all', 'dev', 'staging', 'prod')),
  min_level VARCHAR(16) NOT NULL CHECK (min_level IN ('info', 'warning', 'critical')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  target_ciphertext TEXT NOT NULL,
  destination_hint VARCHAR(254) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_notification_channels_project_name
  ON alert_notification_channels (project_id, lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_notification_channels_match
  ON alert_notification_channels (project_id, environment, enabled, min_level)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS alert_notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES alert_notification_channels(id) ON DELETE SET NULL,
  channel_name VARCHAR(120) NOT NULL,
  channel_type VARCHAR(16) NOT NULL CHECK (channel_type IN ('webhook', 'email')),
  event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('alert', 'test')),
  alert_id UUID REFERENCES alert_incidents(id) ON DELETE SET NULL,
  alert_title VARCHAR(160),
  level VARCHAR(16) CHECK (level IS NULL OR level IN ('info', 'warning', 'critical')),
  service VARCHAR(120),
  environment VARCHAR(32) CHECK (environment IS NULL OR environment IN ('dev', 'staging', 'prod')),
  trace_id VARCHAR(128),
  safe_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'retrying', 'sent', 'failed', 'canceled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  attempts_in_cycle SMALLINT NOT NULL DEFAULT 0 CHECK (attempts_in_cycle >= 0),
  manual_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry_count >= 0),
  max_attempts SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'sending') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_notification_deliveries_incident_channel
  ON alert_notification_deliveries (alert_id, channel_id)
  WHERE event_type = 'alert' AND alert_id IS NOT NULL AND channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alert_notification_deliveries_project_created
  ON alert_notification_deliveries (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_alert_notification_deliveries_ready
  ON alert_notification_deliveries (next_attempt_at, created_at, id)
  WHERE status IN ('queued', 'retrying', 'sending');
