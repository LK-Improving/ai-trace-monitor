async (page) => {
  const requests = [];
  const listener = request => { if (new URL(request.url()).pathname === '/__sdk_test__/spans') requests.push(request); };
  page.on('request', listener);
  if (await page.locator('#server-relay').isChecked()) throw new Error('Relay must default off');
  await page.locator('#start-sdk').click();
  await page.locator('#trigger-js-error').click();
  await page.locator('#trigger-rejection').click();
  await page.waitForTimeout(1500);
  if (requests.length) throw new Error('Default mode uploaded spans');
  if (!(await page.locator('#event-list').innerText()).includes('PROMISE')) throw new Error('Local events missing');
  await page.locator('#stop-sdk').click();
  page.off('request', listener);
  console.log(JSON.stringify({defaultOff:'passed',localSink:'passed'}));
}
