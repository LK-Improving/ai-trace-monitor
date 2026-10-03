import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection, isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { Kafka, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import test from 'node:test';

const integrationEnabled = process.env.TRACE_OPS_RUN_INTEGRATION === '1';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const collectorEntry = path.resolve(scriptDirectory, '../dist/main.js');
const requestTimeoutMs = 8_000;
const totalTimeoutMs = 150_000;
const waitTimeoutMs = 30_000;
// If Windows terminates the child before KafkaJS can leave the group cleanly,
// allow the broker's default 30-second session timeout to expire.
const cleanupRetryCount = 90;
const cleanupRetryDelayMs = 500;

function summarizeFailure(error, secrets) {
  if (!(error instanceof Error)) return 'UnknownError: unexpected non-Error failure';
  const safeMessage = secrets.filter(Boolean).reduce(
    (message, secret) => message.replaceAll(secret, '[redacted]'),
    error.message,
  );
  return `${error.name}: ${safeMessage}`;
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipVersion = isIP(host);
  return host === 'localhost'
    || (ipVersion === 4 && host.startsWith('127.'))
    || host === '::1';
}

function parseLocalBrokers(value) {
  const brokers = value.split(',').map((broker) => broker.trim()).filter(Boolean);
  if (brokers.length === 0) throw new Error('KAFKA_BROKERS must contain at least one broker');

  for (const broker of brokers) {
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(broker);
    const port = Number(match?.[3]);
    const hostname = match?.[1] ?? match?.[2];
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535 || !isLoopback(hostname)) {
      throw new Error('Integration acceptance only allows loopback Kafka brokers');
    }
  }

  return brokers;
}

function parseLocalClickHouseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CLICKHOUSE_URL must be a valid local HTTP(S) URL');
  }

  if (!['http:', 'https:'].includes(url.protocol) || !isLoopback(url.hostname)) {
    throw new Error('Integration acceptance only allows a loopback ClickHouse URL');
  }
  return url.toString();
}

function parseLocalPostgresUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid local PostgreSQL URL');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !isLoopback(url.hostname)) {
    throw new Error('Integration acceptance only allows a loopback PostgreSQL URL');
  }
  return value;
}

async function assertCollectorOpsPortFree() {
  const occupied = await new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: '127.0.0.1', port: 3011 });
    const finish = (isOccupied) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(isOccupied);
    };
    const timer = setTimeout(() => finish(true), 500);
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
  });
  if (occupied) {
    throw new Error('Collector health port 3011 is already in use; refusing to disturb another process');
  }
}

async function readIsolatedCollectorHealth(topic, consumerGroup) {
  try {
    const response = await fetch('http://127.0.0.1:3011/internal/ops/health', {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return undefined;
    const value = await response.json();
    if (value?.topic !== topic || value?.consumerGroup !== consumerGroup) return undefined;
    if (!Number.isSafeInteger(value.processedMessages) || !Number.isSafeInteger(value.failedBatches)
      || !Number.isSafeInteger(value.insertedSpans) || !Number.isSafeInteger(value.committedBatches)
      || !Number.isSafeInteger(value.invalidMessages)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('CLICKHOUSE_DATABASE must be a simple ClickHouse identifier');
  }
  return `\`${identifier}\``;
}

async function waitFor(label, predicate, { timeoutMs = waitTimeoutMs, child, childSpawnFailed } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childSpawnFailed?.()) throw new Error('Collector failed to start');
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Collector exited before ${label}`);
    }
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createClickHouseTableQuery(qualifiedTable) {
  return `CREATE TABLE ${qualifiedTable}
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
  ORDER BY (project_id, trace_id, span_id)`;
}

test('W6B real Kafka → Collector → ClickHouse persistence, retry, and poison-message acceptance', {
  skip: integrationEnabled ? false : 'Set TRACE_OPS_RUN_INTEGRATION=1 to enable local service integration',
  timeout: totalTimeoutMs,
}, async () => {
  if (!existsSync(collectorEntry)) {
    throw new Error('Collector build is missing; build contracts and Collector before enabling this test');
  }

  const brokers = parseLocalBrokers(process.env.KAFKA_BROKERS ?? 'localhost:9092');
  const clickhouseUrl = parseLocalClickHouseUrl(process.env.CLICKHOUSE_URL ?? 'http://localhost:8123');
  const databaseUrl = parseLocalPostgresUrl(process.env.DATABASE_URL ?? '');
  const database = process.env.CLICKHOUSE_DATABASE ?? 'observability';
  const quotedDatabase = quoteIdentifier(database);
  const username = process.env.CLICKHOUSE_USER ?? 'trace_ops';
  const password = process.env.CLICKHOUSE_PASSWORD ?? 'trace_ops_dev_only';

  const runId = randomBytes(12).toString('hex');
  const topic = `trace-ops-w6b-${runId}`;
  const groupId = `trace-ops-w6b-${runId}`;
  const table = `trace_spans_w6b_${runId}`;
  const qualifiedTable = `${quotedDatabase}.\`${table}\``;
  const failureCanary = `W6B_FAILURE_CANARY_${randomUUID()}`;
  const poisonCanary = `W6B_POISON_CANARY_${randomUUID()}`;
  const projectId = randomUUID();
  const projectSlug = `w6b-${runId}`;
  const canaries = [failureCanary, poisonCanary];

  const kafka = new Kafka({
    clientId: `trace-ops-w6b-${runId}`,
    brokers,
    connectionTimeout: requestTimeoutMs,
    requestTimeout: requestTimeoutMs,
    retry: { retries: 2, initialRetryTime: 250, maxRetryTime: 1_000 },
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  const producer = kafka.producer();
  const postgres = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: requestTimeoutMs });
  postgres.on('error', () => undefined);
  const clickhouse = createClient({
    url: clickhouseUrl,
    username,
    password,
    database,
    request_timeout: requestTimeoutMs,
    log: { level: ClickHouseLogLevel.OFF },
  });

  let adminConnected = false;
  let producerConnected = false;
  let projectCreationAttempted = false;
  let topicCreationMayHaveCompleted = false;
  let tableCreationMayHaveCompleted = false;
  let collectorSpawnFailed = false;
  let collector;
  let output = '';
  let scanTail = '';
  let canaryLeaked = false;
  let primaryFailure;

  const rememberCollectorOutput = (chunk) => {
    const text = chunk.toString('utf8');
    const scanWindow = scanTail + text;
    if (canaries.some((canary) => scanWindow.includes(canary))) canaryLeaked = true;
    scanTail = scanWindow.slice(-Math.max(...canaries.map((canary) => canary.length)));
    output += text;
    if (output.length > 512 * 1024) output = output.slice(-512 * 1024);
  };

  const readCommittedOffset = async () => {
    try {
      const offsets = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false });
      const partition = offsets.find((entry) => entry.topic === topic)
        ?.partitions.find((entry) => entry.partition === 0);
      if (!partition || partition.offset === '-1') return undefined;
      return BigInt(partition.offset);
    } catch {
      // A newly joined group may not have committed metadata yet. The later
      // post-recovery assertion still requires a concrete expected offset.
      return undefined;
    }
  };

  const tableExists = async () => {
    const result = await clickhouse.query({
      query: 'SELECT count() AS count FROM system.tables WHERE database = {database:String} AND name = {table:String}',
      query_params: { database, table },
      format: 'JSONEachRow',
    });
    const [row] = await result.json();
    return Number(row?.count ?? 0) > 0;
  };

  try {
    // This test's child owns the Collector's fixed loopback health port. Do
    // not create Kafka/Postgres/ClickHouse fixtures if another process uses it.
    await assertCollectorOpsPortFree();

    const existingProject = await postgres.query(
      'SELECT id FROM projects WHERE id = $1 OR slug = $2 LIMIT 1',
      [projectId, projectSlug],
    );
    if (existingProject.rows.length > 0) {
      throw new Error('A randomly generated W6B PostgreSQL project already exists; refusing to reuse it');
    }
    projectCreationAttempted = true;
    await postgres.query(
      'INSERT INTO projects (id, name, slug) VALUES ($1, $2, $3)',
      [projectId, `W6B integration ${runId.slice(0, 8)}`, projectSlug],
    );

    await admin.connect();
    adminConnected = true;

    const existingTopics = await admin.listTopics();
    const existingGroups = await admin.listGroups();
    if (existingTopics.includes(topic)
      || existingGroups.groups.some((group) => group.groupId === groupId)
      || await tableExists()) {
      throw new Error('A randomly generated W6B resource name already exists; refusing to reuse it');
    }

    topicCreationMayHaveCompleted = true;
    const topicCreated = await admin.createTopics({
      waitForLeaders: true,
      timeout: requestTimeoutMs,
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    });
    if (!topicCreated) {
      topicCreationMayHaveCompleted = false;
      throw new Error('Kafka refused to create the isolated W6B topic');
    }

    await producer.connect();
    producerConnected = true;

    const baseTime = Date.now();
    const expectedSpans = Array.from({ length: 3 }, (_, index) => ({
      schemaVersion: 1,
      projectId,
      environment: 'dev',
      traceId: `trace_w6b_${runId}_${index}`,
      spanId: `w6b-${runId}-${index}`,
      service: 'w6b-integration',
      operation: 'llm.generate',
      startTime: baseTime + index * 10,
      endTime: baseTime + index * 10 + 5,
      status: 'error',
      attributes: { model: 'synthetic-model', prompt: failureCanary },
      tokenUsage: { input: 2, output: 3, total: 5 },
      error: failureCanary,
    }));

    const produced = await producer.send({
      topic,
      acks: -1,
      timeout: requestTimeoutMs,
      messages: expectedSpans.map((span) => ({
        key: `w6b-${runId}`,
        partition: 0,
        value: JSON.stringify(span),
      })),
    });
    if (produced.length !== 1 || produced[0].partition !== 0 || produced[0].baseOffset !== '0') {
      throw new Error('Kafka did not place the synthetic batch at the expected initial partition offset');
    }

    collector = spawn(process.execPath, [collectorEntry], {
      cwd: path.resolve(scriptDirectory, '..'),
      env: {
        ...process.env,
        KAFKA_BROKERS: brokers.join(','),
        KAFKA_TOPIC: topic,
        KAFKA_GROUP_ID: groupId,
        CLICKHOUSE_URL: clickhouseUrl,
        CLICKHOUSE_DATABASE: database,
        CLICKHOUSE_TABLE: table,
        CLICKHOUSE_USER: username,
        CLICKHOUSE_PASSWORD: password,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    collector.on('error', () => {
      collectorSpawnFailed = true;
    });
    collector.stdout.on('data', rememberCollectorOutput);
    collector.stderr.on('data', rememberCollectorOutput);

    await waitFor('Collector subscription to the isolated topic', () => (
      output.includes(`Collector subscribed to ${topic}; ClickHouse table: ${table}`)
    ), { timeoutMs: 15_000, child: collector, childSpawnFailed: () => collectorSpawnFailed });

    let failedAttempt;
    await waitFor('the isolated Collector to classify the unavailable target as a failed batch', async () => {
      failedAttempt = await readIsolatedCollectorHealth(topic, groupId);
      return failedAttempt !== undefined
        && failedAttempt.processedMessages >= expectedSpans.length
        && failedAttempt.failedBatches >= 1;
    }, { timeoutMs: 20_000, child: collector, childSpawnFailed: () => collectorSpawnFailed });
    assert.equal(failedAttempt.status, 'degraded');
    assert.equal(failedAttempt.insertedSpans, 0);
    assert.equal(failedAttempt.committedBatches, 0);
    assert.equal(failedAttempt.lastCommitAt, null);
    if (canaryLeaked) throw new Error('Collector failure logs unexpectedly contained synthetic canary data');

    const failedOffset = await readCommittedOffset();
    if (failedOffset !== undefined && failedOffset > 0n) {
      throw new Error('Kafka offset advanced before ClickHouse accepted the batch');
    }

    tableCreationMayHaveCompleted = true;
    await clickhouse.command({ query: createClickHouseTableQuery(qualifiedTable) });

    await waitFor('all valid Spans to be inserted after ClickHouse recovery', async () => {
      const result = await clickhouse.query({
        query: `SELECT count() AS count FROM ${qualifiedTable}`,
        format: 'JSONEachRow',
      });
      const [row] = await result.json();
      return Number(row?.count ?? 0) === expectedSpans.length;
    }, { timeoutMs: waitTimeoutMs, child: collector, childSpawnFailed: () => collectorSpawnFailed });

    let recoveredAttempt;
    await waitFor('Collector success counters and the committed offset to recover', async () => {
      recoveredAttempt = await readIsolatedCollectorHealth(topic, groupId);
      return recoveredAttempt !== undefined
        && recoveredAttempt.failedBatches >= 1
        && recoveredAttempt.insertedSpans === expectedSpans.length
        && recoveredAttempt.committedBatches >= 1
        && recoveredAttempt.lastCommitAt !== null;
    }, { timeoutMs: waitTimeoutMs, child: collector, childSpawnFailed: () => collectorSpawnFailed });
    assert.equal(recoveredAttempt.status, 'running');

    const insertedResult = await clickhouse.query({
      query: `SELECT span_id, error, attributes, total_tokens FROM ${qualifiedTable} ORDER BY span_id`,
      format: 'JSONEachRow',
    });
    const insertedRows = await insertedResult.json();
    assert.equal(insertedRows.length, expectedSpans.length, 'Every synthetic Span should be persisted');
    assert.deepEqual(
      insertedRows.map((row) => row.span_id).sort(),
      expectedSpans.map((span) => span.spanId).sort(),
      'The complete same-partition batch should be present',
    );
    if (insertedRows.some((row) => row.error !== '' || row.attributes.includes(failureCanary))) {
      throw new Error('Persisted rows unexpectedly contained the synthetic privacy canary');
    }
    assert.ok(insertedRows.every((row) => Number(row.total_tokens) === 5));

    await waitFor('the batch commit to advance the partition offset to 3', async () => (
      await readCommittedOffset() === 3n
    ), { timeoutMs: waitTimeoutMs, child: collector, childSpawnFailed: () => collectorSpawnFailed });

    const poisonValue = JSON.stringify({ marker: poisonCanary }).slice(0, -1);
    const poisonProduced = await producer.send({
      topic,
      acks: -1,
      timeout: requestTimeoutMs,
      messages: [{ key: `w6b-${runId}`, partition: 0, value: poisonValue }],
    });
    if (poisonProduced.length !== 1 || poisonProduced[0].baseOffset !== '3') {
      throw new Error('The synthetic poison message was not written at the expected next offset');
    }

    await waitFor('safe poison-message classification', () => (
      output.includes(`Collector discarded 1 invalid message(s) from ${topic}[0]`)
      && output.includes('invalid_json: 1')
    ), { timeoutMs: waitTimeoutMs, child: collector, childSpawnFailed: () => collectorSpawnFailed });
    await waitFor('the poison-message offset to advance to 4', async () => (
      await readCommittedOffset() === 4n
    ), { timeoutMs: waitTimeoutMs, child: collector, childSpawnFailed: () => collectorSpawnFailed });
    let poisonSnapshot;
    await waitFor('health counters to reflect poison-message classification and commit', async () => {
      poisonSnapshot = await readIsolatedCollectorHealth(topic, groupId);
      return poisonSnapshot !== undefined
        && poisonSnapshot.invalidMessages === 1
        && poisonSnapshot.committedBatches >= 2;
    }, { timeoutMs: waitTimeoutMs, child: collector, childSpawnFailed: () => collectorSpawnFailed });

    if (canaryLeaked) throw new Error('Collector logs unexpectedly contained synthetic canary data');
    assert.equal(await tableExists(), true, 'The target table should exist only after explicit recovery');
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanupFailures = [];
    const attemptCleanup = async (label, operation) => {
      try {
        await operation();
      } catch {
        cleanupFailures.push(label);
      }
    };

    if (collector && collector.exitCode === null && collector.signalCode === null) {
      await attemptCleanup('Collector shutdown', async () => {
        const waitForExit = async (timeoutMs) => {
          if (collector.exitCode !== null || collector.signalCode !== null) return true;
          let timer;
          try {
            return await Promise.race([
              new Promise((resolve) => collector.once('exit', () => resolve(true))),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };

        const gracefulExit = waitForExit(10_000);
        collector.kill('SIGTERM');
        if (await gracefulExit) return;

        const forcedExit = waitForExit(3_000);
        collector.kill('SIGKILL');
        if (!await forcedExit) throw new Error('Collector did not exit after forced termination');
      });
    }

    if (producerConnected) await attemptCleanup('Kafka producer disconnect', () => producer.disconnect());

    if (adminConnected && topicCreationMayHaveCompleted) {
      await attemptCleanup('temporary Kafka group cleanup', async () => {
        for (let attempt = 0; attempt < cleanupRetryCount; attempt += 1) {
          const groups = await admin.listGroups();
          const offsets = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false }).catch(() => []);
          const groupExists = groups.groups.some((group) => group.groupId === groupId);
          const groupHasCommittedOffset = offsets.some((entry) => entry.topic === topic
            && entry.partitions.some((partition) => partition.offset !== '-1'));
          if (!groupExists && !groupHasCommittedOffset) return;

          try {
            const results = await admin.deleteGroups([groupId]);
            const refused = results.some((result) => result.errorCode && result.errorCode !== 0);
            const remainingGroups = await admin.listGroups();
            const remainingOffsets = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false }).catch(() => []);
            const groupStillExists = remainingGroups.groups.some((group) => group.groupId === groupId);
            const offsetsStillExist = remainingOffsets.some((entry) => entry.topic === topic
              && entry.partitions.some((partition) => partition.offset !== '-1'));
            if (!refused && !groupStillExists && !offsetsStillExist) return;
          } catch {
            // Kafka may briefly retain group state after the last member disconnects.
          }

          if (attempt + 1 < cleanupRetryCount) {
            await new Promise((resolve) => setTimeout(resolve, cleanupRetryDelayMs));
          }
        }
        throw new Error('Kafka did not remove the isolated W6B group after bounded retries');
      });
      await attemptCleanup('temporary Kafka topic cleanup', async () => {
        const topics = await admin.listTopics();
        if (topics.includes(topic)) await admin.deleteTopics({ topics: [topic], timeout: requestTimeoutMs });
      });
    }

    if (tableCreationMayHaveCompleted) {
      await attemptCleanup('temporary ClickHouse table cleanup', async () => {
        if (await tableExists()) await clickhouse.command({ query: `DROP TABLE ${qualifiedTable}` });
      });
    }

    if (adminConnected) await attemptCleanup('Kafka admin disconnect', () => admin.disconnect());
    await attemptCleanup('ClickHouse client close', () => clickhouse.close());
    if (projectCreationAttempted) {
      await attemptCleanup('temporary PostgreSQL project and alert cleanup', async () => {
        await postgres.query('DELETE FROM projects WHERE id = $1 AND slug = $2', [projectId, projectSlug]);
        const remaining = await postgres.query(
          'SELECT id FROM projects WHERE id = $1 AND slug = $2 LIMIT 1',
          [projectId, projectSlug],
        );
        if (remaining.rows.length !== 0) throw new Error('Temporary W6B project cleanup verification failed');
      });
    }
    await attemptCleanup('PostgreSQL pool close', () => postgres.end());

    if (cleanupFailures.length > 0) {
      const failureSummary = primaryFailure
        ? ` Original acceptance failure: ${summarizeFailure(primaryFailure, [...canaries, password, clickhouseUrl, databaseUrl])}.`
        : '';
      const message = `W6B integration cleanup failed for: ${cleanupFailures.join(', ')}.${failureSummary}`;
      throw new Error(message);
    }
  }

  if (primaryFailure) throw new Error(summarizeFailure(primaryFailure, [...canaries, password, clickhouseUrl, databaseUrl]));
});
