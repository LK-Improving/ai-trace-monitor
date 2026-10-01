const {createRequire}=require('node:module');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
createRequire(require.resolve('dotenv-cli/package.json'))('dotenv').config({path:path.join(root,'.env')});
async function main(){
  const session=JSON.parse(fs.readFileSync(path.join(root,'output/playwright/w8-session.json'),'utf8'));
  assert(Number.isInteger(session.apiPort)&&session.apiPort>0&&session.apiPort<65536);
  assert(process.env.PLATFORM_ADMIN_TOKEN);
  const checks=[];
  async function call(route,{body,auth=false,headers={},method}={}){
    return fetch('http://127.0.0.1:'+session.apiPort+'/api/v1'+route,{method:method??(body?'POST':'GET'),headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+process.env.PLATFORM_ADMIN_TOKEN}:{}),...headers},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  }
  async function expect(name,route,options,status){const response=await call(route,options);assert.equal(response.status,status,name);checks.push({name,status});return response;}
  await expect('projects require admin','/projects',{},401);
  await expect('overview requires admin','/overview?projectId='+session.projectId,{},401);
  await expect('ingest status requires admin','/spans/status',{},401);
  await expect('wrong admin rejected','/projects',{headers:{authorization:'Bearer synthetic-invalid'}},401);
  await expect('invalid overview project rejected','/overview?projectId=invalid',{auth:true},400);
  await expect('unknown project is not found','/overview?projectId='+randomUUID(),{auth:true},404);
  await expect('invalid ingest rejected','/spans',{body:{}},400);
  const now=Date.now();
  const span={traceId:'trace_phase1_negative_'+randomUUID(),spanId:randomUUID(),service:'web-sdk-demo',operation:'browser.javascript_error',startTime:now,endTime:now,status:'error',attributes:{eventType:'javascript_error',errorName:'Error'}};
  await expect('unknown project key rejected','/spans',{body:{projectKey:'tr_'+'B'.repeat(43),environment:'dev',spans:[span]}},401);
  let key;
  try{
    key=await (await expect('temporary key created','/projects/'+session.projectId+'/keys',{auth:true,body:{name:'Phase1 negative checks'}},201)).json();
    await expect('unregistered service rejected','/spans',{body:{projectKey:key.key,environment:'dev',spans:[{...span,service:'unregistered-phase1'}]}},400);
    await expect('unregistered environment rejected','/spans',{body:{projectKey:key.key,environment:'prod',spans:[span]}},400);
    await expect('temporary key revoked','/projects/'+session.projectId+'/keys/'+key.id,{auth:true,method:'DELETE'},200);
    await expect('revoked key rejected','/spans',{body:{projectKey:key.key,environment:'dev',spans:[span]}},401);
  }finally{if(key)await call('/projects/'+session.projectId+'/keys/'+key.id,{auth:true,method:'DELETE'});}
  const response=await expect('health accepts invalid trace header safely','/health',{headers:{'x-trace-id':'invalid trace value'}},200);
  assert.match(response.headers.get('x-trace-id')??'',/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  const report={status:'passed',count:checks.length,checks,negativeChecks:'no valid span enqueued'};
  fs.writeFileSync(path.join(root,'output/playwright/phase1-api-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
main().catch(error=>{console.error(error instanceof assert.AssertionError?error.message:'API negative check failed; credentials withheld');process.exitCode=1;});
