// Isolated diagnostic only: never changes Collector code or shared Kafka resources.
const {createRequire}=require('node:module');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const rootRequire=createRequire(path.join(root,'package.json'));
createRequire(rootRequire.resolve('dotenv-cli/package.json'))('dotenv').config({path:path.join(root,'.env')});
const collectorRequire=createRequire(path.join(root,'apps/collector/package.json'));
const {Kafka,logLevel}=collectorRequire('kafkajs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  assert.equal(process.env.TRACE_OPS_RUN_INTEGRATION,'1');
  const brokers=(process.env.KAFKA_BROKERS??'localhost:9092').split(',').map(s=>s.trim());
  assert(brokers.every(s=>/^(localhost|127\.0\.0\.1):\d+$/.test(s)));
  const id='phase1-dev-'+randomUUID();
  const admin=new Kafka({clientId:id,brokers,logLevel:logLevel.NOTHING,retry:{retries:1}}).admin();
  let connected=false,created=false,child,output='',spawnFailed=false,result,cleanup='passed';
  try{
    await admin.connect();connected=true;
    assert(!(await admin.listTopics()).includes(id));
    assert(!(await admin.listGroups()).groups.some(g=>g.groupId===id));
    assert(await admin.createTopics({waitForLeaders:true,topics:[{topic:id,numPartitions:1,replicationFactor:1}]}));created=true;
    child=spawn(process.execPath,[collectorRequire.resolve('tsx/cli'),'watch','src/main.ts'],{
      cwd:path.join(root,'apps/collector'),env:{...process.env,KAFKA_TOPIC:id,KAFKA_GROUP_ID:id},windowsHide:true,stdio:['ignore','pipe','pipe']
    });
    const remember=data=>{output=(output+data.toString()).slice(-32768);};
    child.stdout.on('data',remember);child.stderr.on('data',remember);child.on('error',()=>{spawnFailed=true;});
    const started=Date.now();
    while(Date.now()-started<30000&&!spawnFailed&&child.exitCode===null&&child.signalCode===null&&!output.includes('Collector subscribed to '+id)) await delay(250);
    result={status:output.includes('Collector subscribed to '+id)?'passed':'failed',command:'tsx watch src/main.ts',node:process.version,tsx:collectorRequire('tsx/package.json').version,subscribed:output.includes('Collector subscribed to '+id),elapsedMs:Date.now()-started,spawnFailed,outputPresent:output.length>0,moduleError:/ERR_MODULE|Cannot find module/.test(output),loaderError:/must be loaded with|register is not a function/.test(output)};
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){
      // This exact PID was created above and is still active; terminate only its owned tree.
      await new Promise(resolve=>{const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',resolve);killer.once('exit',resolve);});
      for(let i=0;i<20&&child.exitCode===null&&child.signalCode===null;i++) await delay(100);
      if(child.exitCode===null&&child.signalCode===null) cleanup='failed';
    }
    if(connected&&created){
      let removed=false;
      for(let i=0;i<90;i++){
        if(!(await admin.listGroups()).groups.some(g=>g.groupId===id)){removed=true;break;}
        try{await admin.deleteGroups([id]);}catch{}
        await delay(500);
      }
      if(!removed) cleanup='failed';
      await admin.deleteTopics({topics:[id]});
      for(let i=0;i<30&&(await admin.listTopics()).includes(id);i++) await delay(300);
      if((await admin.listTopics()).includes(id)) cleanup='failed';
    }
    if(connected)await admin.disconnect();
  }
  const report={...result,cleanup};
  fs.mkdirSync(path.join(root,'output/playwright'),{recursive:true});
  fs.writeFileSync(path.join(root,'output/playwright/phase1-dev-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if(report.status!=='passed'||cleanup!=='passed')process.exitCode=1;
}
main().catch(()=>{console.error('Isolated development check failed; credentials withheld');process.exitCode=1;});
