// Browser acceptance for the isolated session created by
// scripts/w24-27-notifications-acceptance.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sessionPath = path.join(root, 'output', 'acceptance', 'w24-27-notifications-session.json');
const reportPath = path.join(root, 'output', 'acceptance', 'w24-27-notifications-browser-result.json');
const screenshotPath = path.join(root, 'output', 'playwright', 'w24-27-notifications.png');

function playwrightModule() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require('playwright'); } catch {}
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache', '_npx');
  const candidates = fs.readdirSync(cache, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(cache, entry.name, 'node_modules', 'playwright'))
    .filter(directory => fs.existsSync(path.join(directory, 'package.json')))
    .map(directory => ({ directory, version: JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version }))
    .filter(candidate => /^\d+\.\d+\.\d+$/.test(candidate.version))
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
  if (!candidates[0]) throw new Error('Playwright package is unavailable; run npx --yes playwright --version first');
  return require(candidates[0].directory);
}

async function main() {
  assert(fs.existsSync(sessionPath), 'Isolated browser session is missing');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(session.url), 'Browser session must be loopback-only');
  assert(/^[0-9a-f-]{36}$/i.test(session.projectId), 'Browser session project ID is invalid');
  assert(/^[0-9a-f-]{36}$/i.test(session.retryDeliveryId), 'Browser retry fixture ID is invalid');

  const { chromium } = playwrightModule();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const browserAuthHeaders = [];
  const failedAdminResponses = [];
  page.on('request', request => {
    if (request.headers().authorization) browserAuthHeaders.push(request.url());
  });
  page.on('response', response => {
    if (response.url().includes('/api/v1/alerts/') && response.status() >= 400) {
      failedAdminResponses.push(response.status());
    }
  });

  const checks = [];
  let failureStep = 'load application';
  try {
    await page.goto(session.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.getByLabel('选择项目').selectOption(session.projectId);
    await page.getByRole('button', { name: '项目设置' }).click();
    await page.getByRole('tab', { name: '告警通知' }).click();
    await page.getByRole('heading', { name: '告警通知' }).waitFor({ state: 'visible' });
    await page.locator('.top-actions .demo-label').getByText('API 查询', { exact: true }).waitFor({ state: 'visible' });
    await page.locator('.sidebar-foot').getByText('真实接口', { exact: true }).waitFor({ state: 'visible' });
    checks.push('settings navigation correctly labels notifications as live API data');

    failureStep = 'submit and observe a channel test delivery';
    const webhookCard = page.locator('.notification-channel-card').filter({ hasText: 'Acceptance webhook' });
    await webhookCard.waitFor({ state: 'visible', timeout: 15000 });
    const webhookRowsBefore = await page.locator('.notification-delivery-table tbody tr')
      .filter({ hasText: 'Acceptance webhook' }).count();
    await webhookCard.getByRole('button', { name: '测试投递' }).click();
    await page.locator('.notification-feedback.success[role="status"]')
      .filter({ hasText: '测试投递已提交' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('tab', { name: '投递历史' }).click();
    await page.locator('.notification-delivery-table tbody tr')
      .filter({ hasText: 'Acceptance webhook' }).first().waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(({ previous }) => {
      const rows = [...document.querySelectorAll('.notification-delivery-table tbody tr')]
        .filter(row => row.textContent.includes('Acceptance webhook'));
      return rows.length > previous && rows.some(row => row.textContent.includes('已送达'));
    }, { previous: webhookRowsBefore }, { timeout: 20000 });
    checks.push('project-scoped notification channels render and test delivery is visible');

    failureStep = 'manually retry a failed delivery and observe its sent status';
    const retryRow = page.locator('.notification-delivery-table tbody tr')
      .filter({ hasText: 'Acceptance UI retry' });
    await retryRow.getByText('失败', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    await retryRow.getByRole('button', { name: '重试' }).click();
    await page.locator('.notification-feedback.success[role="status"]')
      .filter({ hasText: '失败投递已加入重试队列' }).waitFor({ state: 'visible', timeout: 10000 });
    await retryRow.getByText('已送达', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
    checks.push('failed delivery can be retried from the browser and reaches sent');

    assert.deepEqual(browserAuthHeaders, [], 'Administrator authorization must never be sent by the browser');
    assert.deepEqual(failedAdminResponses, [], 'Notification admin API returned an error in the browser');
    checks.push('same-origin server proxy keeps administrator authorization server-side');

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'Notification history overflows the mobile viewport');
    checks.push('notification history fits the narrow mobile viewport');

    failureStep = 'write browser acceptance report';
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ status: 'passed', checks, screenshotPath }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks, screenshotPath }));
  } catch (error) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({
      status: 'failed', checks,
      failureStep,
      failure: 'Browser acceptance failed; private diagnostics withheld',
      failureCode: /^[A-Z0-9_]{2,32}$/.test(error?.code ?? '') ? error.code : undefined,
      failureLocation: String(error?.stack ?? '').split('\n')
        .find(line => line.includes('w24-27-notifications-browser-acceptance.cjs:'))?.trim(),
    }, null, 2));
    console.log(JSON.stringify({ status: 'failed', checks, failure: 'Browser acceptance failed; private diagnostics withheld' }));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  const failureCode = /^[A-Z0-9_]{2,32}$/.test(error?.code ?? '') ? error.code : undefined;
  const failureLocation = String(error?.stack ?? '').split('\n')
    .find(line => line.includes('w24-27-notifications-browser-acceptance.cjs:'))?.trim();
  const report = { status: 'failed', failure: 'Browser acceptance setup failed', failureCode, failureLocation };
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch {}
  console.log(JSON.stringify(report));
  process.exitCode = 1;
});
