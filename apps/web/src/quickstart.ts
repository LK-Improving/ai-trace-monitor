export type QuickstartLanguage = 'node' | 'browser';

export const NODE_QUICKSTART = String.raw`import { randomUUID } from 'node:crypto';

const endpoint = process.env.TRACE_OPS_ENDPOINT ?? 'http://localhost:3001/api/v1/spans';
const projectKey = process.env.TRACE_OPS_PROJECT_KEY;
const environment = process.env.TRACE_OPS_ENVIRONMENT ?? 'dev';
const service = process.env.TRACE_OPS_SERVICE ?? 'customer-api';

if (!projectKey) throw new Error('Set TRACE_OPS_PROJECT_KEY in the server environment.');
if (!['dev', 'staging', 'prod'].includes(environment)) {
  throw new Error('TRACE_OPS_ENVIRONMENT must be dev, staging, or prod.');
}

const traceId = 'trace_v1_' + randomUUID();
const rootSpanId = randomUUID();
const childSpanId = randomUUID();
const startTime = Date.now();
const childStartTime = Math.max(startTime, Date.now());
const childEndTime = Math.max(childStartTime, Date.now());
const endTime = Math.max(childEndTime, startTime);

const payload = {
  projectKey,
  environment,
  spans: [
    {
      traceId,
      spanId: rootSpanId,
      service,
      operation: 'http.server',
      startTime,
      endTime,
      status: 'ok',
      attributes: { source: 'quickstart' },
    },
    {
      traceId,
      spanId: childSpanId,
      parentSpanId: rootSpanId,
      service,
      operation: 'quickstart.work',
      startTime: childStartTime,
      endTime: childEndTime,
      status: 'ok',
      attributes: { source: 'quickstart' },
    },
  ],
};

const response = await fetch(endpoint, {
  method: 'POST',
  signal: AbortSignal.timeout(5000),
  headers: {
    'content-type': 'application/json',
    'x-trace-id': traceId,
  },
  body: JSON.stringify(payload),
});

if (response.status !== 202) {
  throw new Error('Span ingest expected HTTP 202, received ' + response.status);
}

console.log('Trace ' + traceId + ' accepted; HTTP 202 means queued in API process memory only, not durable storage.');`;

export const BROWSER_QUICKSTART = String.raw`const traceId = 'trace_v1_' + crypto.randomUUID();

await fetch('/api/chat', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-trace-id': traceId,
  },
  body: JSON.stringify({ question }),
});

// This only propagates a correlation ID to your application API.
// It does not create or upload Span or frontend monitoring events.`;

export function getQuickstartSnippet(language: QuickstartLanguage): string {
  return language === 'node' ? NODE_QUICKSTART : BROWSER_QUICKSTART;
}
