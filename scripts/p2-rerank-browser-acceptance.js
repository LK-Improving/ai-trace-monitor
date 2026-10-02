// Display-only boundary checks using an explicit synthetic variant of a real API response.
// Adapter/storage/aggregation absence is separately checked by w15-metrics-acceptance.cjs.
async (page) => {
  const session = await (await page.request.get(new URL('/__w18_session__', page.url()).href)).json();
  await page.getByLabel('选择项目').selectOption(session.projectId);
  await page.getByLabel('选择环境').selectOption('dev');
  await page.getByLabel('选择时间范围').selectOption('24h');
  const response = await page.request.get(new URL(`/api/v1/metrics/ai?projectId=${session.projectId}&environment=dev&range=24h`, page.url()).href, { headers: { 'sec-fetch-site': 'same-origin' } });
  if (response.status() !== 200) throw new Error('Real metrics baseline unavailable');
  const payload = await response.json();
  let samples = 0;
  const handler = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ...payload, rag: { ...payload.rag, rerankSampleCount: samples, p95RerankMs: 0 },
  }) });
  await page.route('**/api/v1/metrics/ai?*', handler);
  try {
    await page.getByRole('button', { name: 'AI 链路', exact: true }).click();
    const metric = page.locator('.ai-data-metric').filter({ has: page.getByText('重排 P95', { exact: true }) });
    await metric.getByText('0 个有效样本', { exact: true }).waitFor();
    if (await metric.locator('strong').textContent() !== '—') throw new Error('Missing sample displayed as zero');
    samples = 1;
    await page.getByRole('button', { name: '接入文档', exact: true }).click();
    await page.getByRole('button', { name: 'AI 链路', exact: true }).click();
    await metric.getByText('1 个有效样本', { exact: true }).waitFor();
    if (await metric.locator('strong').textContent() !== '0ms') throw new Error('Measured zero displayed as missing');
    return { status: 'passed', responseMode: 'explicit display-only synthetic variants', checks: [
      'zero rerank samples display unavailable rather than measured zero', 'one valid zero-duration sample displays 0ms',
    ] };
  } finally { await page.unroute('**/api/v1/metrics/ai?*', handler); }
}
