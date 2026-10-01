const {createRequire}=require('node:module');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const net=require('node:net');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
createRequire(require.resolve('dotenv-cli/package.json'))('dotenv').config({path:path.join(root,'.env')});
const {Pool}=createRequire(path.join(root,'apps/api/package.json'))('pg');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=net.createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function main(){
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION,'1');
  assert(['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
  assert(process.env.PLATFORM_ADMIN_TOKEN);
  const apiPort=await freePort();let brokerPort=await freePort();while(brokerPort===apiPort)brokerPort=await freePort();
  const slug='phase1-outage-'+randomUUID();
  const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
  let child,project,result,cleanup='passed';
  async function request(route,body){return fetch('http://127.0.0.1:'+apiPort+'/api/v1'+route,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.PLATFORM_ADMIN_TOKEN},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});}
  try{
    child=spawn(process.execPath,[path.join(root,'apps/api/dist/main.js')],{cwd:path.join(root,'apps/api'),env:{...process.env,API_PORT:String(apiPort),KAFKA_BROKERS:'127.0.0.1:'+brokerPort,KAFKA_TOPIC:slug,SPAN_QUEUE_MAX_SPANS:'1',SPAN_QUEUE_MAX_RETRIES:'0'},windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{});
    let ready=false;
    for(let i=0;i<100;i++){try{if((await request('/health')).ok){ready=true;break;}}catch{}assert(child.exitCode===null&&child.signalCode===null);await delay(100);}
    assert(ready,'Isolated API not ready');
    assert.equal((await pool.query('SELECT id FROM projects WHERE slug=$1',[slug])).rowCount,0);
    const created=await request('/projects',{name:'Phase1 Kafka outage check',slug});assert.equal(created.status,201);project=await created.json();
    assert.equal((await request('/projects/'+project.id+'/services',{name:'outage-check',environment:'dev'})).status,201);
    const keyResponse=await request('/projects/'+project.id+'/keys',{name:'temporary outage check'});assert.equal(keyResponse.status,201);const key=await keyResponse.json();
    const now=Date.now();const span={traceId:'trace_phase1_'+randomUUID(),spanId:randomUUID(),service:'outage-check',operation:'http.server',startTime:now,endTime:now+1,status:'ok',attributes:{}};
    const oversized=await request('/spans',{projectKey:key.key,environment:'dev',spans:[span,{...span,spanId:randomUUID()}]});assert.equal(oversized.status,503);assert.equal((await oversized.json()).acceptedSpans,0);
    const started=Date.now();const accepted=await request('/spans',{projectKey:key.key,environment:'dev',spans:[span]});const elapsedMs=Date.now()-started;
    assert.equal(accepted.status,202);assert.equal((await accepted.json()).durability,'best_effort');assert(elapsedMs<1500,'Ingest blocked on Kafka');
    let metrics;
    for(let i=0;i<100;i++){metrics=await (await request('/spans/status')).json();if(metrics.droppedSpans===3&&metrics.queueDepth===0)break;await delay(100);}
    assert.equal(metrics.acceptedSpans,1);assert.equal(metrics.publishedSpans,0);assert.equal(metrics.droppedSpans,3);assert.equal(metrics.queueDepth,0);assert(metrics.publishErrorCount>0);assert.equal(metrics.rejectedBatchCount,1);
    result={status:'passed',unreachableBroker:true,ingestStatus:202,ingestElapsedMs:elapsedMs,overflowStatus:503,acceptedSpans:metrics.acceptedSpans,publishedSpans:metrics.publishedSpans,droppedSpans:metrics.droppedSpans,dropBreakdown:{capacityRejected:2,publishFailed:1},publishErrorCount:metrics.publishErrorCount,queueDepth:metrics.queueDepth,rejectedBatchCount:metrics.rejectedBatchCount};
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');for(let i=0;i<40&&child.exitCode===null&&child.signalCode===null;i++)await delay(100);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await delay(500);}if(child.exitCode===null&&child.signalCode===null)cleanup='failed';}
    if(project){assert.equal((await pool.query('DELETE FROM projects WHERE id=$1 AND slug=$2',[project.id,slug])).rowCount,1);assert.equal((await pool.query('SELECT id FROM projects WHERE id=$1',[project.id])).rowCount,0);}
    await pool.end();
  }
  const report={...result,cleanup};fs.writeFileSync(path.join(root,'output/playwright/phase1-outage-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(cleanup!=='passed')process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof assert.AssertionError?error.message:'Outage check failed; credentials withheld');process.exitCode=1;});
