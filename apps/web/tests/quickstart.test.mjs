import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(testDirectory, '..');
const workspaceDirectory = resolve(webDirectory, '../..');
const [quickstartSource, webReadme, contractSource, ingestService, apiMain, apiReadme, projectsController] = await Promise.all([
  readFile(resolve(webDirectory, 'src/quickstart.ts'), 'utf8'),
  readFile(resolve(webDirectory, 'README.md'), 'utf8'),
  readFile(resolve(workspaceDirectory, 'packages/contracts/src/index.ts'), 'utf8'),
  readFile(resolve(workspaceDirectory, 'apps/api/src/spans/span-ingest.service.ts'), 'utf8'),
  readFile(resolve(workspaceDirectory, 'apps/api/src/main.ts'), 'utf8'),
  readFile(resolve(workspaceDirectory, 'apps/api/README.md'), 'utf8'),
  readFile(resolve(workspaceDirectory, 'apps/api/src/projects/projects.controller.ts'), 'utf8'),
]);

const compiled = ts.transpileModule(quickstartSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const quickstart = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

function parseSource(name, source) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.deepEqual(file.parseDiagnostics, [], `${name} must parse as JavaScript`);
  return file;
}

function findVariable(file, name) {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find((item) => item.name.getText(file) === name);
    if (declaration) return declaration;
  }
  assert.fail(`Missing variable ${name}`);
}

function literalProperties(object, file, constants = {}) {
  assert.ok(ts.isObjectLiteralExpression(object));
  return object.properties.map((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    if (!ts.isPropertyAssignment(property)) return undefined;
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
    if (ts.isComputedPropertyName(property.name) && ts.isIdentifier(property.name.expression)) {
      return constants[property.name.expression.text];
    }
    return undefined;
  }).filter(Boolean);
}

function snippetFence(source, index) {
  const fences = [...source.matchAll(/```js\r?\n([\s\S]*?)\r?\n```/g)];
  assert.ok(fences[index], `Missing README JavaScript example ${index + 1}`);
  return fences[index][1].trim();
}

test('Node and browser quickstarts are exported once and match the README', () => {
  const nodeCode = quickstart.NODE_QUICKSTART;
  const browserCode = quickstart.BROWSER_QUICKSTART;
  assert.equal(quickstart.getQuickstartSnippet('node'), nodeCode);
  assert.equal(quickstart.getQuickstartSnippet('browser'), browserCode);
  assert.equal(snippetFence(webReadme, 0), nodeCode.trim());
  assert.equal(snippetFence(webReadme, 1), browserCode.trim());
  assert.doesNotMatch(nodeCode, /@trace-ops\/(?:sdk|web-sdk)|TraceRecorder/);
  assert.match(nodeCode, /process\.env\.TRACE_OPS_PROJECT_KEY/);
  assert.match(nodeCode, /process\.env\.TRACE_OPS_SERVICE \?\? 'customer-api'/);
  assert.match(nodeCode, /process\.env\.TRACE_OPS_ENVIRONMENT \?\? 'dev'/);
  assert.match(nodeCode, /http:\/\/localhost:3001\/api\/v1\/spans/);
  assert.match(nodeCode, /AbortSignal\.timeout\(5000\)/);
  assert.match(nodeCode, /console\.log\('Trace ' \+ traceId/);
});

test('Node quickstart payload matches the live ingest and Span schema shape', () => {
  const nodeFile = parseSource('node-quickstart.mjs', quickstart.NODE_QUICKSTART);
  const payload = findVariable(nodeFile, 'payload').initializer;
  const contractFile = ts.createSourceFile('contracts.ts', contractSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ingestSchema = contractSource.match(/export const SpanIngestRequestSchema = z\s*\.object\(\{([\s\S]*?)\}\)\s*\.strict\(\)/);
  assert.ok(ingestSchema, 'ingest schema is present');
  assert.match(ingestSchema[1], /\[PROJECT_KEY_FIELD\]: ProjectKeySchema/);
  assert.match(ingestSchema[1], /environment: EnvironmentSchema/);
  assert.match(ingestSchema[1], /spans: z\.array\(TraceSpanSchema\)\.min\(1\)\.max\(500\)/);
  assert.deepEqual(literalProperties(payload, nodeFile).sort(), ['environment', 'projectKey', 'spans']);

  const spanFields = literalProperties(findVariable(contractFile, 'traceSpanFields').initializer, contractFile);
  const spans = payload.properties.find((property) => property.name?.getText(nodeFile) === 'spans').initializer;
  assert.ok(ts.isArrayLiteralExpression(spans));
  const rootSpan = spans.elements[0];
  const childSpan = spans.elements[1];
  const rootFields = literalProperties(rootSpan, nodeFile);
  const childFields = literalProperties(childSpan, nodeFile);
  assert.deepEqual(rootFields.sort(), ['attributes', 'endTime', 'operation', 'service', 'spanId', 'startTime', 'status', 'traceId']);
  assert.deepEqual(childFields.sort(), [...rootFields, 'parentSpanId'].sort());
  assert.ok([...rootFields, ...childFields].every((field) => spanFields.includes(field)));
  assert.match(nodeFile.text, /parentSpanId: rootSpanId/);
  assert.doesNotMatch(nodeFile.text, /projectId|x-project-key/);

  assert.match(contractSource, /z\.enum\(\['dev', 'staging', 'prod'\]\)/);
  assert.match(ingestService, /WHERE project_id = \$1 AND environment = \$2 AND name = ANY/);
  assert.match(apiMain, /setGlobalPrefix\('api\/v1'\)/);
  assert.match(apiMain, /process\.env\.API_PORT \?\? 3001/);
  assert.match(apiReadme, /queued_in_memory/);
});

test('browser quickstart only propagates a Trace ID and keeps project keys server-side', () => {
  const browserCode = quickstart.BROWSER_QUICKSTART;
  parseSource('browser-quickstart.js', browserCode);
  assert.match(browserCode, /crypto\.randomUUID\(\)/);
  assert.match(browserCode, /'x-trace-id': traceId/);
  assert.match(browserCode, /fetch\('\/api\/chat'/);
  assert.match(browserCode, /does not create or upload Span or frontend monitoring events/i);
  assert.doesNotMatch(browserCode, /projectKey|api\/v1\/spans|initBrowserMonitoring/);
});

test('README points project setup to the existing admin API without implementing writes or RBAC', () => {
  assert.match(webReadme, /\.\.\/api\/README\.md/);
  assert.match(apiReadme, /POST.*\/api\/v1\/projects\/:projectId\/services/);
  assert.match(apiReadme, /POST.*\/api\/v1\/projects\/:projectId\/keys/);
  assert.match(apiReadme, /管理员令牌/);
  assert.match(projectsController, /@UseGuards\(AdminTokenGuard\)/);
  assert.match(projectsController, /@Post\('\:projectId\/keys'\)/);
  assert.match(projectsController, /@Post\('\:projectId\/services'\)/);
});
