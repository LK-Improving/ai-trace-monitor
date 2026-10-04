import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const apiFetchStub = `data:text/javascript;base64,${Buffer.from(
  'export function apiFetch(input, init) { return globalThis.fetch(input, init); }',
).toString('base64')}`;
const overviewSource = await readFile(new URL('../src/overview-api.ts', import.meta.url), 'utf8');
const overviewOutput = ts.transpileModule(overviewSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll("'./api'", `'${apiFetchStub}'`);
const overviewStub = `data:text/javascript;base64,${Buffer.from(overviewOutput).toString('base64')}`;
const source = await readFile(new URL('../src/project-create-api.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll("'./api'", `'${apiFetchStub}'`)
  .replaceAll("'./overview-api'", `'${overviewStub}'`);
const { createProject } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('project creation sends the exact body and returns a selectable project', async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (input, init) => {
    call = { input, init };
    return new Response(JSON.stringify({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', name: '智能客服', slug: 'assistant-demo' }), { status: 201 });
  };
  try {
    const project = await createProject({ name: ' 智能客服 ', slug: 'assistant-demo', retentionDays: 30 });
    assert.deepEqual(project, { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', name: '智能客服', slug: 'assistant-demo' });
    assert.equal(call.input, '/api/v1/projects');
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(JSON.parse(call.init.body), { name: '智能客服', slug: 'assistant-demo', retentionDays: 30 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid fields and duplicate project slug remain actionable', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 409 }); };
  try {
    await assert.rejects(createProject({ name: '项目', slug: 'Bad Slug', retentionDays: 30 }), /请检查/);
    assert.equal(calls, 0);
    await assert.rejects(createProject({ name: '项目', slug: 'demo', retentionDays: 30 }), /已存在/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
