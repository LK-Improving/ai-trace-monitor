const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
async function main(){
  assert(process.env.W8_PLAYWRIGHT_MODULE);
  const {chromium}=require(process.env.W8_PLAYWRIGHT_MODULE);
  const session=JSON.parse(fs.readFileSync(path.join(root,'output/playwright/w8-session.json'),'utf8'));
  assert.equal(session.webUrl,'http://127.0.0.1:5188');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1050}});
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',()=>errors.push('pageerror'));
    await page.goto(session.webUrl);await page.waitForLoadState('networkidle');
    const buttons=await page.locator('nav[aria-label="主导航"] button').allTextContents();
    await page.getByRole('combobox',{name:'选择项目'}).selectOption(session.projectId);
    await page.getByRole('combobox',{name:'选择环境'}).selectOption('dev');
    await page.getByText('browser.unhandled_rejection',{exact:false}).first().waitFor();
    const responsePromise=page.waitForResponse(r=>r.url().includes('/overview?')&&r.url().includes('range=7d'));
    await page.getByRole('combobox',{name:'选择时间范围'}).selectOption('7d');
    assert.equal((await responsePromise).status(),200);
    await page.waitForLoadState('networkidle');
    await page.getByRole('combobox',{name:'选择环境'}).selectOption('prod');
    await page.getByText('此时间范围内暂无错误',{exact:true}).waitFor();
    await context.setOffline(true);
    await page.getByRole('combobox',{name:'选择环境'}).selectOption('dev');
    await page.getByRole('alert').waitFor();
    assert((await page.getByRole('alert').innerText()).includes('无法连接 API'));
    const values=await page.locator('.metric-grid').innerText();
    assert(!values.includes('100%')&&values.includes('—'),'Offline view must not fallback to fake metrics');
    await page.screenshot({path:path.join(root,'output/playwright/phase1-offline.png'),fullPage:true});
    await context.setOffline(false);
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.getByText('browser.unhandled_rejection',{exact:false}).first().waitFor();
    const navigation=[];
    for(let i=1;i<buttons.length;i++){
      const button=page.locator('nav[aria-label="主导航"] button').nth(i);
      await button.click();
      assert((await page.locator('.topbar').innerText()).includes('演示数据'));
      navigation.push(buttons[i].trim());
    }
    await page.locator('nav[aria-label="主导航"] button').first().click();
    await page.getByText('browser.unhandled_rejection',{exact:false}).first().waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(root,'output/playwright/phase1-narrow.png'),fullPage:true});
    const horizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
    assert.equal(errors.length,0);
    const report={status:'passed',range7d:'passed',emptyEnvironment:'passed',offlineError:'passed',noFakeFallback:'passed',retryRecovery:'passed',navigationDemoLabels:navigation,pageErrors:errors.length,narrowViewport:{width:390,horizontalOverflow}};
    fs.writeFileSync(path.join(root,'output/playwright/phase1-ui-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
