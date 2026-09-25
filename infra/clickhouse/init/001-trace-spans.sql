CREATE DATABASE IF NOT EXISTS observability;

CREATE TABLE IF NOT EXISTS observability.trace_spans
(
  event_time DateTime64(3, 'UTC'),
  project_id String,
  environment LowCardinality(String),
  trace_id String,
  span_id String,
  parent_span_id String,
  service LowCardinality(String),
  operation LowCardinality(String),
  status LowCardinality(String),
  start_time DateTime64(3, 'UTC'),
  end_time DateTime64(3, 'UTC'),
  duration_ms Float64,
  input_tokens UInt64,
  output_tokens UInt64,
  total_tokens UInt64,
  model LowCardinality(String),
  attributes String,
  error String
)
ENGINE = MergeTree
PARTITION BY toDate(event_time)
ORDER BY (project_id, environment, service, operation, event_time, trace_id, span_id)
TTL event_time + INTERVAL 30 DAY;
