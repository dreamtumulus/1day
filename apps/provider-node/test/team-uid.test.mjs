import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CcWorkerManager,resolveRunAs } from '../dist/cc-worker.js';
import { ProxyPool,proxyId } from '../dist/proxy-pool.js';

// Tests real kernel ownership with synthetic credentials, never platform data.
if(process.getuid?.()===0 && spawnSync('which',['useradd']).status===0) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'team-uid-'));
  fs.chmodSync(dir,0o711);
  const fixture=path.join(dir,'fake.mjs');
  fs.copyFileSync(new URL('./fake-claude.mjs',import.meta.url),fixture);fs.chmodSync(fixture,0o644);
  const teams=[randomUUID(),randomUUID()];
  const urls=['http://127.0.0.1:9021','http://127.0.0.1:9022'];
  const pool=new ProxyPool({data:{},save(){}},{autoCheck:false});
  pool.replaceAll(urls,{proxyTeams:Object.fromEntries(urls.map((u,i)=>[proxyId(u),teams[i]])),proxyAccounts:Object.fromEntries(urls.map((u,i)=>[proxyId(u),[`account${i}`]]))});
  const frames=[];
  const previous=process.env.CC_WORKER_TEAM_UIDS;process.env.CC_WORKER_TEAM_UIDS='1';
  const manager=new CcWorkerManager({send:m=>(frames.push(m),true),identity:()=>({nodeId:'n',providerId:'p'}),isDraining:()=>false,pool,dataDir:dir,workerRoot:dir,runAsUser:null,claudeBin:process.execPath,claudeArgsPrefix:[fixture]});
  try {
    for(const [i,teamId] of teams.entries())manager.handleOpen({type:'cc_worker.open',sessionId:`s${i}`,providerId:'p',nodeId:'n',accountId:`account${i}`,credentialBindingId:`account${i}`,proxyId:proxyId(urls[i]),deviceId:String(i+1).repeat(64),isolation:{teamId,conversationId:`c${i}`,generation:1},model:'claude-sonnet-5-5',prompt:'fixture',stream:true,cred:{accessToken:'synthetic-test-token'}});
    const deadline=Date.now()+10_000;
    while(Date.now()<deadline&&!teams.every((_,i)=>frames.some(f=>f.sessionId===`s${i}`&&f.reasonCode==='complete')))await new Promise(r=>setTimeout(r,20));
    assert.ok(teams.every((_,i)=>frames.some(f=>f.sessionId===`s${i}`&&f.reasonCode==='complete')));
    const stats=teams.map((t,i)=>fs.statSync(path.join(dir,'teams',createHash('sha256').update(t).digest('hex'),'cc-accounts',`account${i}`)));
    assert.notEqual(stats[0].uid,stats[1].uid);assert.notEqual(stats[0].uid,0);
    for(const s of stats)assert.equal(s.mode&0o777,0o700);
  } finally {
    manager.closeAll();pool.stopHealthChecks();fs.rmSync(dir,{recursive:true,force:true});
    for(const t of teams)spawnSync('userdel',[`cc-t-${createHash('sha256').update(t).digest('hex').slice(0,24)}`]);
    if(previous===undefined)delete process.env.CC_WORKER_TEAM_UIDS;else process.env.CC_WORKER_TEAM_UIDS=previous;
  }
}
console.log('team-uid: ALL PASSED');
