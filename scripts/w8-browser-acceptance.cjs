// Fallback for unstable CLI sessions; uses an explicitly supplied installed Playwright package.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  assert(process.env.W8_PLAYWRIGHT_MODULE, 'Set W8_PLAYWRIGHT_MODULE to the installed Playwright package');
  const {chromium} = require(process.env.W8_PLAYWRIGHT_MODULE);
  const session = JSON.parse(fs.readFileSync(path.join(root,'output/playwright/w8-session.json'),'utf8'));
  assert.equal(session.webUrl,'http://127.0.0.1:5188');
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1050}});
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(session.webUrl+'/sdk-test.html');
    const run = filename => Function('return ('+fs.readFileSync(path.join(__dirname,filename),'utf8')+')')()(page);
    await run('w8-browser-default.js');
    const relay = await run('w8-browser-relay.js');
    const requests = [];
    const errors = [];
    page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')) requests.push(r);});
    page.on('pageerror',()=>errors.push('pageerror'));
    await page.goto(session.webUrl+'/');
    await page.getByRole('combobox',{name:'选择项目'}).selectOption(session.projectId);
    await page.getByRole('combobox',{name:'选择环境'}).selectOption('dev');
    await page.getByText('browser.unhandled_rejection',{exact:false}).first().waitFor();
    assert((await page.locator('.metric-grid').innerText()).includes('100%'));
    assert((await page.locator('.service-name').innerText()).includes('web-sdk-demo'));
    await page.screenshot({path:path.join(root,'output/playwright/w8-real-overview.png'),fullPage:true});
    await page.getByRole('combobox',{name:'选择环境'}).selectOption('prod');
    await page.getByText('此时间范围内暂无错误',{exact:true}).waitFor();
    await page.getByRole('combobox',{name:'选择环境'}).selectOption('dev');
    await page.getByText('browser.unhandled_rejection',{exact:false}).first().waitFor();
    await page.getByRole('combobox',{name:'选择时间范围'}).selectOption('1h');
    await page.getByText('browser.unhandled_rejection',{exact:false}).first().waitFor();
    assert(requests.length && requests.every(r=>!r.headers().authorization));
    assert.equal(errors.length,0);
    const result = {status:'passed',defaultOff:'passed',relay,overview:'passed',environmentSwitch:'passed',rangeSwitch:'passed',browserAuthorization:'absent'};
    fs.writeFileSync(path.join(root,'output/playwright/w8-browser-result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
