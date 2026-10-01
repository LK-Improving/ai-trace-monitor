import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), Module = require('node:module');
const calls = []; let options, fail = false, closed = false;
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === '@clickhouse/client') return { ClickHouseLogLevel: { OFF: 'OFF' }, createClient: value => {
    options = value;
    return { query: async query => { calls.push(query); if (fail) throw new Error('private-budget-canary');
      return { json: async () => [{ count: 1 }] }; }, close: async () => { closed = true; } };
  } };
  return load.call(this, name, ...args);
};
let ClickHouseService;
try { ({ ClickHouseService } = require('../dist/overview/clickhouse.service.js')); }
finally { Module._load = load; }

test('analytics reads use finite execution/read/result/memory budgets with throw overflow', async () => {
  const service = new ClickHouseService({ get: () => undefined });
  assert.equal(options.request_timeout, 10000); assert.equal(options.log.level, 'OFF');
  assert.deepEqual(await service.query('SELECT {id:String}', { id: 'safe-id' }), [{ count: 1 }]);
  assert.deepEqual(calls[0].query_params, { id: 'safe-id' });
  assert.deepEqual(calls[0].clickhouse_settings, { max_execution_time: 5, max_rows_to_read: '1000000',
    max_bytes_to_read: '67108864', max_result_rows: '2001', max_result_bytes: '8388608', max_memory_usage: '134217728',
    read_overflow_mode: 'throw', result_overflow_mode: 'throw' });
  fail = true;
  await assert.rejects(service.query('SELECT 1', {}), error => error.message === 'Analytics query failed' && error.cause === undefined);
  await service.onModuleDestroy(); assert.equal(closed, true);
});
