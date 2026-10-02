// Supplemental read-only UI-state checks; successful reads remain real.
async (page) => {
  const session = await (await page.request.get(new URL('/__w18_session__', page.url()).href)).json();
  const checks = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  const fail = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  try {
    await page.getByLabel('选择项目').selectOption(session.projectId);
    await page.getByLabel('选择环境').selectOption('staging');
    await page.getByRole('button', { name: '总览', exact: true }).click();
    await page.getByText('该项目、环境与时间范围内暂无观测数据。', { exact: true }).waitFor();
    check(await page.locator('.metric-value').filter({ hasText: '—' }).count() === 1, 'Empty overview latency treated as measured zero');
    checks.push('real empty Overview with unavailable latency');
    await page.route('**/api/v1/metrics/overview?*', fail);
    await page.getByLabel('选择环境').selectOption('dev');
    await page.getByRole('alert').waitFor();
    check(await page.locator('.metric-value').filter({ hasText: '—' }).count() === 4, 'Failed overview retained old metrics');
    await page.unroute('**/api/v1/metrics/overview?*', fail);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('.traces-panel .trace-id').first().waitFor();
    checks.push('Overview failure clears old values and retry reads real data');
    await page.getByRole('button', { name: 'Trace 检索', exact: true }).click();
    await page.locator('.trace-results-table').waitFor();
    await page.getByLabel('精确 Trace ID').fill('missing-trace');
    await page.getByRole('button', { name: '查询 Trace', exact: true }).click();
    await page.getByText('当前项目、环境、时间范围和筛选条件内没有 Trace。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await page.getByRole('button', { name: `查看 Trace ${session.completeId}（dev）`, exact: true }).waitFor();
    checks.push('real empty Trace search and clear filters');
    await page.route('**/api/v1/traces?*', fail);
    await page.getByRole('button', { name: '查询 Trace', exact: true }).click();
    await page.getByRole('alert').waitFor();
    check(await page.locator('.trace-results-table').count() === 0, 'Failed Trace list retained rows');
    await page.unroute('**/api/v1/traces?*', fail);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('button', { name: `查看 Trace ${session.completeId}（dev）`, exact: true }).waitFor();
    checks.push('Trace list failure clears rows and retry reads real data');
    const detailPattern = `**/api/v1/traces/${session.completeId}?*`;
    await page.route(detailPattern, fail);
    await page.getByRole('button', { name: `查看 Trace ${session.completeId}（dev）`, exact: true }).click();
    await page.getByRole('alert').waitFor();
    check(await page.getByRole('treeitem').count() === 0, 'Failed detail retained old spans');
    check(await page.locator('.trace-window-note').count() === 1, 'Failed detail lost query scope');
    await page.unroute(detailPattern, fail);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('treeitem').first().waitFor();
    check(await page.getByRole('treeitem').count() === 5, 'Detail retry did not restore the real tree');
    checks.push('Trace detail failure retains scope only and retry restores real spans');
    return { status: 'passed', run: session.run, checks };
  } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); }
}
