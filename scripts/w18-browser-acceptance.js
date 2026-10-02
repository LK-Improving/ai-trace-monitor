// Playwright CLI run-code function. Normal API responses are never mocked.
async (page) => {
  const session = await (await page.request.get(new URL('/__w18_session__', page.url()).href)).json();
  const checks = [];
  const browserTraceIds = [];
  const failures = [];
  const pendingResponses = [];
  const uncaught = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  const until = async (predicate, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await page.waitForTimeout(60);
    }
    throw new Error(label);
  };
  const onError = () => uncaught.push('uncaught browser exception');
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      const headers = request.headers();
      if (headers.authorization || headers['x-project-key']) failures.push('browser credential header');
      if (url.searchParams.has('token') || url.searchParams.has('projectKey')) failures.push('browser credential query');
    }
  };
  const onFinished = (request) => {
    if (!new URL(request.url()).pathname.startsWith('/api/')) return;
    // Audit completed responses, not headers for requests later cancelled by a
    // scope switch. Chromium may never resolve body() on those cancelled reads.
    pendingResponses.push(Promise.race([
      request.response().then(response => response.text()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('audit deadline')), 5000)),
    ]).then(body => {
      if (/w(?:11|18)-private-content-canary|w11-protocol-fixture-key-not-a-real-credential/.test(body)) failures.push('private canary in HTTP response');
    }).catch(() => failures.push('completed response privacy audit failed')));
  };
  page.on('pageerror', onError); page.on('request', onRequest); page.on('requestfinished', onFinished);
  const project = page.getByLabel('选择项目');
  const environment = page.getByLabel('选择环境');
  const range = page.getByLabel('选择时间范围');
  const navTrace = () => page.getByRole('button', { name: /^(Trace 检索|Traces)$/ });
  const waitList = () => until(async () => await page.locator('.trace-results-table').count() === 1, 'Trace list did not become ready');
  const waitTree = (count) => until(async () => await page.getByRole('treeitem').count() === count, 'Span tree count mismatch');
  const selectTrace = async (traceId, env = 'dev') => {
    await navTrace().click(); await waitList();
    await page.getByLabel('精确 Trace ID').fill(traceId);
    await page.getByRole('button', { name: '查询 Trace', exact: true }).click();
    const button = page.getByRole('button', { name: `查看 Trace ${traceId}（${env}）`, exact: true });
    await button.waitFor({ state: 'visible' }); await button.click();
  };
  const chooseSpan = async (operation) => {
    await page.getByRole('treeitem', { name: new RegExp(`^Span ${operation.replaceAll('.', '\\.')}`) }).first().click();
  };
  try {
    await project.selectOption(session.projectId); await environment.selectOption('dev');
    await page.getByRole('button', { name: '总览', exact: true }).click();
    await until(async () => (await page.locator('.traces-panel').innerText()).includes('trace-'), 'Overview latest traces missing');
    check(!(await page.locator('.page-root').innerText()).includes('演示数据'), 'Mock data leaked into overview');
    checks.push('real overview and latest traces');

    await selectTrace(session.completeId); await waitTree(5);
    await chooseSpan('rag.retrieve');
    const ragDetails = await page.locator('.span-panel').innerText();
    check(ragDetails.includes('来源 SHA-256') && ragDetails.includes('重排前') && ragDetails.includes('重排后'), 'RAG safe detail missing');
    check(await page.locator('.hash-snapshot code').count() >= 3, 'RAG source hashes missing');
    checks.push('complete five-span tree and safe RAG snapshots');
    await chooseSpan('llm.generate');
    const model = await page.locator('.span-panel').innerText();
    check(model.includes('fixture-complete'), 'Model metadata missing');
    check((await page.locator('.usage-panel').innerText()).includes('30'), 'Model token usage missing');
    check(await page.locator('.span-row-badges i.slow').count() > 0, 'Slow-span marker missing');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'output/playwright/w18-trace-detail.png', fullPage: true });
    checks.push('model metadata, token usage and slow-span display');

    await selectTrace(session.cases.find(item => item.mode === 'noUsage').traceId); await waitTree(5);
    await chooseSpan('llm.generate');
    check(await page.locator('.usage-panel strong').filter({ hasText: '—' }).count() >= 3, 'Unknown usage shown as measured zero');
    checks.push('unknown usage remains unavailable');
    await selectTrace(session.cases.find(item => item.mode === 'rateLimit').traceId); await waitTree(5);
    await chooseSpan('llm.generate');
    check((await page.locator('.span-panel').innerText()).includes('rate_limit'), 'Rate-limit category missing');
    checks.push('model error correlated with original Trace');

    await environment.selectOption('all'); await selectTrace(session.completeId, 'prod'); await waitTree(1);
    check((await page.locator('.span-panel').innerText()).includes('prod-root'), 'All-environment detail selected wrong environment');
    await environment.selectOption('dev'); await project.selectOption(session.otherProjectId);
    await selectTrace(session.completeId); await waitTree(1);
    check((await page.locator('.span-panel').innerText()).includes('other-root'), 'Detail crossed project boundary');
    checks.push('same Trace ID remains isolated by project and concrete environment');

    await navTrace().click(); await waitList();
    check(await page.locator('.trace-results-table tbody tr').count() === 20, 'First page size mismatch');
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await waitList();
    await until(async () => (await page.locator('.table-footer').innerText()).includes('第 2'), 'Pagination did not change');
    check(await page.locator('.trace-results-table tbody tr').count() === 8, 'Second page size mismatch');
    checks.push('real server pagination');
    await selectTrace(session.largeTraceId); await waitTree(2000);
    check((await page.locator('.chain-warning').innerText()).includes('截断'), 'Large trace lacks truncation warning');
    check(await page.getByRole('treeitem').last().getAttribute('aria-level') === '2000', 'Deep tree traversal lost depth');
    check(uncaught.length === 0, 'Deep tree caused browser exception');
    checks.push('2001-layer fixture renders 2000 spans without recursion crash');
    await project.selectOption(session.projectId); await selectTrace(session.anomalies); await waitTree(3);
    const integrity = await page.locator('.tree-integrity-note').innerText();
    check(integrity.includes('1 个孤儿') && integrity.includes('2 个环内'), 'Orphan/cycle warning missing');
    checks.push('orphan and cycle markers');

    await navTrace().click(); await waitList();
    await page.getByLabel('按服务筛选').fill('tool-only');
    await page.getByRole('button', { name: '查询 Trace', exact: true }).click(); await waitList();
    await until(async () => await page.locator('.trace-results-table tbody tr').count() === 1, 'Whole-trace service filter failed');
    check((await page.locator('.trace-results-table tbody').innerText()).includes('tool-only, w18-api'), 'Child service filter lost root service');
    await page.getByLabel('按服务筛选').fill(''); await page.getByLabel('按状态筛选').selectOption('error');
    await page.getByRole('button', { name: '查询 Trace', exact: true }).click(); await waitList();
    await until(async () => await page.locator('.trace-results-table tbody tr').count() === 4, 'Error status filter failed');
    checks.push('whole-trace service and error-status filters');

    await page.getByRole('button', { name: 'AI 链路', exact: true }).click();
    await page.getByRole('heading', { name: '模型用量', exact: true }).waitFor();
    check((await page.locator('.ai-page').innerText()).includes('fixture-stream'), 'Real model groups missing');
    check((await page.locator('.live-rag-panel').innerText()).includes('6'), 'Real RAG metrics missing');
    await page.screenshot({ path: 'output/playwright/w18-ai-metrics.png', fullPage: true });
    checks.push('real model usage, TTFT and RAG aggregates');
    await environment.selectOption('staging');
    await page.getByText('当前项目、环境与时间范围内没有模型或 RAG 调用。', { exact: true }).waitFor();
    check(await page.locator('.ai-summary-grid .metric-value').filter({ hasText: '—' }).count() === 2, 'Unobserved TTFT/recall displayed as zero');
    checks.push('empty environment and unobserved samples');
    await range.selectOption('1h'); await environment.selectOption('dev');
    await page.getByRole('heading', { name: '模型用量', exact: true }).waitFor();
    checks.push('global time-range selection');

    // Intentional fault injection covers UI states; successful reads stay real.
    const aiPattern = '**/api/v1/metrics/ai?*';
    const failRoute = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    await page.route(aiPattern, failRoute); await environment.selectOption('prod');
    await page.getByRole('alert').waitFor();
    check(await page.getByRole('heading', { name: '模型用量', exact: true }).count() === 0, 'Failure retained stale model data');
    await page.unroute(aiPattern, failRoute); await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('heading', { name: '模型用量', exact: true }).waitFor();
    checks.push('explicit API failure and successful retry without mock fallback');

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const slowRoute = async route => { await gate; try { await route.continue(); } catch {} };
    await page.route(aiPattern, slowRoute); await environment.selectOption('dev');
    await page.getByLabel('AI 指标加载中').waitFor();
    check(await page.getByRole('heading', { name: '模型用量', exact: true }).count() === 0, 'Loading retained stale model data');
    await project.selectOption(session.otherProjectId); release(); await page.unroute(aiPattern, slowRoute);
    await page.getByText('当前项目、环境与时间范围内没有模型或 RAG 调用。', { exact: true }).waitFor();
    check(!(await page.locator('.ai-page').innerText()).includes('fixture-stream'), 'Old project response replaced selected project');
    checks.push('loading, cancellation and project-switch stale-response isolation');

    await project.selectOption(session.projectId); await environment.selectOption('dev');
    for (const mode of ['complete', 'rateLimit']) {
      const generated = await page.evaluate(async mode => {
        const { apiFetch } = await import('/src/api.ts');
        const response = await apiFetch(`/__w18_fixture__/${mode}`);
        return { traceId: response.headers.get('x-trace-id'), status: response.status };
      }, mode);
      check(generated.status === (mode === 'complete' ? 200 : 500), 'Browser fixture result mismatch');
      check(/^trace_web_[0-9a-f-]{36}$/.test(generated.traceId), 'Browser Trace ID was not propagated');
      browserTraceIds.push(generated.traceId);
      await navTrace().click(); await waitList();
      // Collector is asynchronous; refresh actual queries until the row is stored.
      await page.getByLabel('精确 Trace ID').fill(generated.traceId);
      await until(async () => {
        await page.getByRole('button', { name: '查询 Trace', exact: true }).click(); await waitList();
        return await page.getByRole('button', { name: `查看 Trace ${generated.traceId}（dev）`, exact: true }).count() === 1;
      }, 'Browser-generated Trace not stored');
      await page.getByRole('button', { name: `查看 Trace ${generated.traceId}（dev）`, exact: true }).click(); await waitTree(5);
    }
    checks.push('browser apiFetch through instrumented API, Kafka, Collector and ClickHouse');

    const protectedReads = await page.evaluate(async ({ projectId, traceId }) => {
      const scope = `projectId=${projectId}&environment=dev`;
      return Promise.all([
        fetch(`/api/v1/traces/${traceId}?${scope}&includeContent=true`),
        fetch('/api/v1/projects', { method: 'POST' }),
        fetch(`/api/v1/projects/${projectId}/keys`),
      ]).then(responses => responses.map(response => response.status));
    }, { projectId: session.projectId, traceId: session.completeId });
    check(protectedReads.join(',') === '403,405,404', 'Read proxy privilege boundary failed');
    checks.push('same-origin proxy denies content, writes and key reads');
    const body = await page.locator('body').innerText();
    check(!/w(?:11|18)-private-content-canary/.test(body), 'Private content in DOM');
    const storedKeys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
    check(storedKeys.length === 0, 'Isolated browser origin unexpectedly stores client data');
    await page.setViewportSize({ width: 480, height: 900 });
    const rowBounds = await page.getByRole('treeitem').first().boundingBox();
    const durationBounds = await page.getByRole('treeitem').first().locator('.tree-duration').boundingBox();
    check(durationBounds && durationBounds.x + durationBounds.width <= rowBounds.x + rowBounds.width + 1, 'Narrow tree duration clipped');
    await page.screenshot({ path: 'output/playwright/w18-mobile-detail.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await Promise.all(pendingResponses);
    check(failures.length === 0 && uncaught.length === 0, `Browser audit failed: ${JSON.stringify({ failures, uncaught })}`);
    checks.push('no browser credentials, private content or uncaught exceptions');
    checks.push('desktop and narrow-viewport screenshots');
    return { status: 'passed', run: session.run, checks, browserTraceIds };
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    page.off('pageerror', onError); page.off('request', onRequest); page.off('requestfinished', onFinished);
  }
}
