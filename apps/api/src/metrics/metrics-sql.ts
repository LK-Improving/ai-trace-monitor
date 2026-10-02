// Fixed SQL only. Project/environment/time are bound parameters. Service is
// applied after deduplication by each consumer, never to partial raw traces.
// At-least-once Collector delivery requires read-time deduplication BEFORE sums.
// Widen UInt64 before SUM: otherwise it can wrap before safe-integer validation.
// A million UInt64 rows still fits UInt128 under the shared query budget.
export const REQUEST_ROOT = "parent_span_id = '' AND operation NOT IN ('browser.web_vital', 'browser.javascript_error', 'browser.unhandled_rejection')";

export function metricsSpansSql(): string {
  return `WITH deduplicated_spans AS (
    SELECT project_id, environment, trace_id, span_id,
      argMax(
        tuple(parent_span_id, service, operation, status, start_time, end_time,
          duration_ms, total_tokens, input_tokens, output_tokens, model, attributes, event_time),
        tuple(event_time, end_time, start_time, parent_span_id, service, operation,
          status, total_tokens, model, duration_ms, input_tokens, output_tokens, attributes)
      ) AS span
    FROM trace_spans
    WHERE project_id = {projectId:String}
      AND ({environment:String} = 'all' OR environment = {environment:String})
      AND event_time >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
      AND event_time < fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
    GROUP BY project_id, environment, trace_id, span_id
  ), normalized_spans AS (
    SELECT project_id, environment, trace_id, span_id,
      tupleElement(span, 1) AS parent_span_id, tupleElement(span, 2) AS service,
      tupleElement(span, 3) AS operation, tupleElement(span, 4) AS status,
      tupleElement(span, 5) AS start_time, tupleElement(span, 6) AS end_time,
      tupleElement(span, 7) AS duration_ms,
      toUInt128(tupleElement(span, 8)) AS total_tokens,
      toUInt128(tupleElement(span, 9)) AS input_tokens,
      toUInt128(tupleElement(span, 10)) AS output_tokens,
      tupleElement(span, 11) AS model, tupleElement(span, 12) AS attributes,
      tupleElement(span, 13) AS event_time
    FROM deduplicated_spans
  )`;
}
