-- W26-W29 project API-key scopes, privacy policy, and append-only audit metadata.

CREATE OR REPLACE FUNCTION trace_ops_valid_project_key_scopes(scopes text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT scopes IS NOT NULL
    AND cardinality(scopes) = 1
    AND scopes <@ ARRAY['spans:write', 'trace:read']::text[]
    AND cardinality(scopes) = (
      SELECT count(DISTINCT scope) FROM unnest(scopes) AS values(scope)
    )
$$;

ALTER TABLE project_keys DROP CONSTRAINT IF EXISTS project_keys_w26_scopes_check;

-- Revoke any credentials created while combined scopes were accepted. A revoked
-- key is normalized to one valid scope so the single-scope check can be added.
WITH revoked_keys AS (
  UPDATE project_keys
  SET scopes = ARRAY[CASE WHEN scopes @> ARRAY['spans:write']::text[] THEN 'spans:write' ELSE 'trace:read' END],
      revoked_at = COALESCE(revoked_at, now())
  WHERE NOT trace_ops_valid_project_key_scopes(scopes)
  RETURNING id, project_id
)
INSERT INTO audit_logs (project_id, actor_id, action, resource, details)
SELECT project_id, 'system', 'project_key.revoked', 'project_key:' || id::text,
       jsonb_build_object('reason', 'single_scope_migration')
FROM revoked_keys;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_keys'::regclass
      AND conname = 'project_keys_w26_single_scope_check'
  ) THEN
    ALTER TABLE project_keys
      ADD CONSTRAINT project_keys_w26_single_scope_check
      CHECK (trace_ops_valid_project_key_scopes(scopes));
  END IF;
END
$$;

ALTER TABLE project_keys ALTER COLUMN scopes SET DEFAULT ARRAY['spans:write']::text[];
CREATE INDEX IF NOT EXISTS idx_project_keys_prefix ON project_keys (key_prefix);

-- Keep the original audit retention contract. This also repairs databases that
-- briefly ran an earlier draft of this migration with ON DELETE RESTRICT.
DO $$
DECLARE
  project_id_attnum smallint;
  fk_name text;
  delete_action text;
BEGIN
  SELECT attnum INTO project_id_attnum
  FROM pg_attribute
  WHERE attrelid = 'audit_logs'::regclass AND attname = 'project_id' AND NOT attisdropped;

  SELECT conname, confdeltype::text INTO fk_name, delete_action
  FROM pg_constraint
  WHERE conrelid = 'audit_logs'::regclass
    AND confrelid = 'projects'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[project_id_attnum]::smallint[];

  IF fk_name IS NULL THEN
    ALTER TABLE audit_logs
      ADD CONSTRAINT audit_logs_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
  ELSIF delete_action <> 'n' THEN
    EXECUTE format('ALTER TABLE audit_logs DROP CONSTRAINT %I', fk_name);
    ALTER TABLE audit_logs
      ADD CONSTRAINT audit_logs_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION trace_ops_valid_redacted_fields(fields text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT fields IS NOT NULL
    AND cardinality(fields) <= 64
    AND cardinality(fields) = (
      SELECT count(DISTINCT lower(field)) FROM unnest(fields) AS values(field)
    )
    AND NOT EXISTS (
      SELECT 1 FROM unnest(fields) AS values(field)
      WHERE length(field) NOT BETWEEN 1 AND 64
         OR field !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
    )
$$;

CREATE TABLE IF NOT EXISTS project_privacy_policies (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  additional_redacted_fields TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  capture_prompt_response BOOLEAN NOT NULL DEFAULT FALSE CHECK (capture_prompt_response = FALSE),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_privacy_policies_redacted_fields_check
    CHECK (trace_ops_valid_redacted_fields(additional_redacted_fields))
);

INSERT INTO project_privacy_policies (project_id)
SELECT id FROM projects
ON CONFLICT (project_id) DO NOTHING;

CREATE OR REPLACE FUNCTION trace_ops_create_default_privacy_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO project_privacy_policies (project_id)
  VALUES (NEW.id)
  ON CONFLICT (project_id) DO NOTHING;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'projects'::regclass
      AND tgname = 'projects_default_privacy_policy'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER projects_default_privacy_policy
      AFTER INSERT ON projects
      FOR EACH ROW EXECUTE FUNCTION trace_ops_create_default_privacy_policy();
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION trace_ops_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND TG_LEVEL = 'ROW'
     AND pg_trigger_depth() > 1
     AND OLD.project_id IS NOT NULL
     AND NEW.project_id IS NULL
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    -- The only allowed update is the existing FK's ON DELETE SET NULL action.
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit logs are append-only' USING ERRCODE = '55000';
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'audit_logs'::regclass
      AND tgname = 'audit_logs_append_only'
      AND NOT tgisinternal
  ) THEN
    DROP TRIGGER audit_logs_append_only ON audit_logs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'audit_logs'::regclass
      AND tgname = 'audit_logs_append_only_update'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER audit_logs_append_only_update
      BEFORE UPDATE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION trace_ops_reject_audit_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'audit_logs'::regclass
      AND tgname = 'audit_logs_append_only_delete'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER audit_logs_append_only_delete
      BEFORE DELETE OR TRUNCATE ON audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION trace_ops_reject_audit_mutation();
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created_id
  ON audit_logs (project_id, created_at DESC, id DESC);
