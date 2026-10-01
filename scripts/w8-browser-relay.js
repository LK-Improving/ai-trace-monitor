async (page) => {
  await page.reload();
  const requests = [];
  const responses = [];
  const pageErrors = [];
  const onRequest = request => { if (new URL(request.url()).pathname === '/__sdk_test__/spans') requests.push(request); };
  const onResponse = response => { if (new URL(response.url()).pathname === '/__sdk_test__/spans') responses.push(response.status()); };
  const onError = () => pageErrors.push('pageerror');
  page.on('request', onRequest); page.on('response', onResponse); page.on('pageerror', onError);
  try {
    await page.locator('#server-relay').check();
    await page.locator('#start-sdk').click();
    const networkResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/__sdk_test__/http-error');
    await page.locator('#trigger-fetch').click();
    const response = await networkResponse;
    if (response.status() !== 503 || !/^trace_web_/.test(response.request().headers()['x-trace-id'] ?? '')) throw new Error('HTTP Trace fixture failed');
    await page.locator('#trigger-js-error').click();
    await page.locator('#trigger-rejection').click();
    await page.waitForFunction(() => document.querySelector('#transport-state').textContent === 'API内存排队', null, {timeout:10000});
    await page.waitForTimeout(1500);
    const spans = requests.flatMap(request => {
      const headers = request.headers();
      const raw = request.postData();
      if (headers.authorization || headers.cookie || /projectKey|PLATFORM_ADMIN_TOKEN|sdk_local_fixture_not_collected|"message"|"metricId"/.test(raw)) throw new Error('Private data exposed');
      return JSON.parse(raw).spans;
    });
    const operations = [...new Set(spans.map(s => s.operation))];
    for (const op of ['browser.javascript_error','browser.unhandled_rejection','browser.network_error','browser.web_vital']) if (!operations.includes(op)) throw new Error('Missing SDK operation: '+op);
    if (!responses.length || responses.some(status => status !== 202) || pageErrors.length) throw new Error('Relay responses/page errors failed');
    if (await page.evaluate(() => localStorage.length || sessionStorage.length)) throw new Error('Unexpected browser storage');
    await page.screenshot({path:'output/playwright/w8-sdk.png',fullPage:true});
    await page.locator('#stop-sdk').click();
    if ((await page.locator('#transport-state').innerText()) !== '已停止') throw new Error('Disposal status failed');
    return {browser:'passed',operations,relayRequests:requests.length,privacy:'passed',status202:'API memory queue only'};
  } finally {
    page.off('request',onRequest); page.off('response',onResponse); page.off('pageerror',onError);
  }
}
