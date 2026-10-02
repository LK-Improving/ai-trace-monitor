// Run against an isolated W18 browser session after the core page acceptance.
async (page) => {
  const checks = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  await page.getByRole('button', { name: '接入文档', exact: true }).click();
  await page.locator('.docs-code').waitFor();
  const snippets = await page.evaluate(async () => {
    const module = await import('/src/quickstart.ts');
    return { node: module.NODE_QUICKSTART, browser: module.BROWSER_QUICKSTART };
  });
  check(await page.locator('.docs-code code').textContent() === snippets.node, 'Displayed Node snippet differs from executed export');
  check((await page.locator('.docs-security-note').textContent()).includes('node quickstart.mjs'), 'Execution command missing');
  checks.push('displayed Node snippet matches the exact real-ingest tested export');
  const hadOwnClipboard = await page.evaluate(() => Object.hasOwn(navigator, 'clipboard'));
  check(!hadOwnClipboard, 'Unexpected clipboard test state');
  try {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (text) => { window.__p2CopiedText = text; } },
    }));
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    await page.getByText('接入示例已复制', { exact: true }).waitFor();
    check(await page.evaluate(() => window.__p2CopiedText) === snippets.node, 'Clipboard did not receive current Node example');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('Synthetic permission denial'); } },
    }));
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    await page.getByText('复制失败，请检查浏览器剪贴板权限。', { exact: true }).waitFor();
    checks.push('copy reports success only after completion and reports permission failure');
    await page.getByRole('button', { name: '浏览器', exact: true }).click();
    check(await page.locator('.docs-code code').textContent() === snippets.browser, 'Browser snippet mismatch');
    check(!/projectKey|process\.env|@trace-ops\/(sdk|web-sdk)/.test(snippets.browser), 'Browser example contains server credentials or nonexistent SDK');
    checks.push('browser quickstart only propagates a Trace ID without server credentials');
  } finally {
    await page.evaluate(() => { delete navigator.clipboard; delete window.__p2CopiedText; });
  }
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await page.getByRole('tab', { name: '接入凭证', exact: true }).click();
  const endpoints = await page.locator('.endpoint-row code').allTextContents();
  check(JSON.stringify(endpoints) === JSON.stringify(['http://localhost:3001/api/v1/spans', 'http://localhost:3001/api/v1/traces']), 'Settings endpoints mismatch');
  check(await page.locator('.credential-value').textContent() === 'tr_••••••••', 'Settings credential is not a masked placeholder');
  check(await page.locator('.credentials-card').getByRole('button', { name: /复制|重新生成/ }).count() === 0, 'Demo credentials provide invalid key actions');
  checks.push('settings uses actual API endpoints and no fake key-copy or rotation action');
  await page.screenshot({ path: 'output/playwright/p2-access-settings.png', fullPage: true });
  return { status: 'passed', checks };
}
