import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after,test} from "node:test";
import WebSocket from "ws";
const dir=mkdtempSync(join(tmpdir(),"console-audit-fixes-"));
process.env.DATA_DIR=dir;
process.env.CCR_WINDOW_POLL="0";
process.env.NODE_WAIT_MS="0";
process.env.ALLOW_UNTRUSTED_EXECUTION="1";
process.env.ONBOARD_MOCK="1";
process.env.ONBOARD_MOCK_DELAY_MS="60";
process.env.ONBOARD_PROFILE_FETCH="0";
const core=await import("@1dayapi/core");
const {buildApp}=await import("../dist/app.js");
const {createUser}=await import("../dist/session.js");
const proxies=await import("../dist/node/proxies.js");
const {sweepStaleJobs}=await import("../dist/onboard/jobs.js");
const {enqueueArchive,retryArchiveCleanup}=await import("../dist/node/archive-cleanup.js");
const {pollAllWindows,refreshExpiringTokens}=await import("../dist/ccr/window-poll.js");
const app=await buildApp();
// app.close() stops the archive-cleanup loop, but a pass already in flight still writes once more: let it settle
// before the database goes away (was: "database is not open" after the last test, flaky since 2026-10-28).
after(async()=>{await app.close();await new Promise(r=>setTimeout(r,400));core.db.close();rmSync(dir,{recursive:true,force:true});});
async function login(key){
 const r=await app.inject({method:"POST",url:"/auth/login",payload:{key}});
 const cookie=r.headers["set-cookie"].split(";")[0];
 return async(method,url,payload)=>{const r=await app.inject({method,url,payload,headers:{cookie}});return {status:r.statusCode,...r.json()};};
}
const admin=await login(readFileSync(join(dir,"admin-key.txt"),"utf8").trim());
const adminId=core.one("SELECT id FROM users WHERE role='admin'").id;
const ops=await login(createUser("ops","ops").loginKey);
const providerUser=createUser("provider","provider");
const provider=await login(providerUser.loginKey);
const team="11111111-1111-4111-8111-111111111111";
function node(id,capacity,owner=adminId){
 core.run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,capacity) VALUES (?,?,?,1,?)",id,owner,"h",capacity);
 const url=`http://user:pass@192.0.2.${node.next++}:8080`;
 core.tx(()=>proxies.addNodeProxies(id,[{url}]));
 const pid=core.sha256Hex(url).slice(0,12);
 core.run("UPDATE node_proxies SET status='live' WHERE id=?",pid);
 assert.ok(proxies.recordNodeProxyExit(id,pid,new URL(url).hostname));
 return pid;
}
node.next=90;
const start=(id,method="session_key")=>admin("POST","/api/admin/accounts/onboard",{method,nodeId:id,orgUuid:team,sessionKey:"fixture"});
async function done(id){for(let i=0;i<100;i++){const r=await admin("GET",`/api/admin/accounts/onboard/${id}`);if(["done","failed"].includes(r.data.status))return r.data;await new Promise(r=>setTimeout(r,10));}throw new Error("job timeout");}

test("ops cannot create accounts through onboarding while admin can",async()=>{
 node("roles",2);
 assert.equal((await ops("POST","/api/admin/accounts/onboard",{method:"session_key",nodeId:"roles",sessionKey:"fixture",orgUuid:team})).status,403);
 const created=await start("roles");assert.equal(created.status,200);assert.equal((await done(created.data.jobId)).status,"done");
});
test("all managed imports share atomic node capacity including outstanding reservations",async()=>{
 node("reserved",1);
 const started=await start("reserved","auth_url");assert.equal(started.status,200);
 assert.equal((await start("reserved")).error.code,"node_at_capacity");
 const imported=await admin("POST","/api/admin/accounts",{name:"blocked",platform:"anthropic",type:"oauth",route:"node",nodeId:"reserved",accessToken:"tok",orgUuid:team});
 assert.equal(imported.error.code,"node_at_capacity");
 const cancelled=await admin("POST",`/api/admin/accounts/onboard/${started.data.jobId}/cancel`,{});
 assert.equal(cancelled.data.status,"failed");
 assert.match(cancelled.data.error,/job_cancelled/);
 assert.equal((await done((await start("reserved")).data.jobId)).status,"done");
 assert.equal((await start("reserved")).error.code,"node_at_capacity");
 node("provider-cap",1,providerUser.id);
 const payload={name:"provider",platform:"anthropic",type:"oauth",route:"node",nodeId:"provider-cap",accessToken:"tok",orgUuid:team};
 assert.equal((await provider("POST","/api/provider/accounts",payload)).status,201);
 assert.equal((await provider("POST","/api/provider/accounts",payload)).error.code,"node_at_capacity");
});
test("cancel is idempotent, scoped, aborts late success and releases reservation",async()=>{
 node("cancel",2);
 const started=await start("cancel");assert.equal(started.status,200);
 const url=`/api/admin/accounts/onboard/${started.data.jobId}/cancel`;
 assert.equal((await ops("POST",url,{})).status,403);
 assert.equal((await provider("POST",url.replace("/admin/","/provider/"),{})).status,404);
 assert.equal((await admin("POST",url,{})).data.status,"failed");
 assert.equal((await admin("POST",url,{})).data.status,"failed");
 await new Promise(r=>setTimeout(r,100));
 assert.equal(core.one("SELECT COUNT(*) n FROM accounts WHERE node_id='cancel'").n,0);
 assert.equal(core.one("SELECT COUNT(*) n FROM proxy_team_events WHERE job_id=? AND event='slot_released'",started.data.jobId).n,1);
});
test("reservation deadlines checked at allocation and commit without waiting for upkeep",async()=>{
 const pid=node("expires",1);
 const started=await start("expires","auth_url");
 core.run("UPDATE onboarding_jobs SET expires_at='2000-01-01T00:00:00Z' WHERE id=?",started.data.jobId);
 // Allocation itself expires the reservation and reuses the untouched exit.
 const replacement=await start("expires","auth_url");assert.equal(replacement.status,200);
 assert.equal(core.one("SELECT status FROM onboarding_jobs WHERE id=?",started.data.jobId).status,"failed");
 assert.equal(core.one("SELECT COUNT(*) n FROM proxy_quarantine WHERE resource_key=?",`proxy:${pid}`).n,0);
 const resumed=await admin("POST","/api/admin/accounts/onboard",{method:"auth_url",jobId:started.data.jobId,callbackUrl:"abcdefghijklmnopqrst"});assert.equal(resumed.status,400);
});
test("legacy maintenance never updates old accounts or jobs",async()=>{
 const credential=core.encryptJson({accessToken:"old",refreshToken:"old",expiresAt:"2000-01-01T00:00:00Z"});
 core.run("INSERT INTO accounts(id,name,platform,type,protocol,credential_enc) VALUES ('legacy-audit','legacy','anthropic','oauth','anthropic',?)",credential);
 core.run("INSERT INTO onboarding_jobs(id,requester_id,scope,method,node_id,status,payload_enc,created_at,updated_at) VALUES ('legacy-job',?,'admin','session_key','roles','working','old','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')",adminId);
 const accountBefore=core.one("SELECT * FROM accounts WHERE id='legacy-audit'");
 const jobBefore=core.one("SELECT * FROM onboarding_jobs WHERE id='legacy-job'");
 // Other managed mock accounts have no expiring credentials/window probes.
 core.run("UPDATE accounts SET window_checked_at=? WHERE team_id IS NOT NULL",core.nowIso());
 assert.equal(await pollAllWindows(),0);
 await refreshExpiringTokens();sweepStaleJobs();
 assert.deepEqual(core.one("SELECT * FROM accounts WHERE id='legacy-audit'"),accountBefore);
 assert.deepEqual(core.one("SELECT * FROM onboarding_jobs WHERE id='legacy-job'"),jobBefore);
 const visible=await app.inject({method:"GET",url:"/api/pool/accounts?pageSize=200"});
 assert.ok(visible.json().data.items.some(a=>a.state==="unmanaged"));
});

test("archive snapshot survives account deletion and node outage, then retries on the same team exit",async()=>{
 const pid=node("archive",1);
 const job=await done((await start("archive")).data.jobId);
 assert.equal(job.status,"done");
 const snapshot={accountId:job.accountId,nodeId:"archive",teamId:team,proxyId:pid,baseUrl:"https://api.anthropic.com",sessionId:"session-audit-archive",cred:{accessToken:"archive-token"}};
 // Explicit delete leaves immutable account_bound evidence and team/IP ownership.
 assert.equal((await admin("DELETE",`/api/admin/accounts/${job.accountId}`)).status,200);
 const result=await enqueueArchive(snapshot);assert.equal(result.status,202);
 const queued=core.one("SELECT * FROM ccr_archive_jobs WHERE status='pending'");
 assert.ok(queued);assert.ok(!queued.payload_enc.includes("archive-token"));assert.equal(queued.attempts,1);
 assert.equal(core.decryptJson(queued.payload_enc).accountId,job.accountId);
 await assert.rejects(()=>enqueueArchive({...snapshot,teamId:"22222222-2222-4222-8222-222222222222"}),/invalid/);
 assert.equal(core.one("SELECT COUNT(*) n FROM ccr_archive_jobs").n,1);
 core.run("UPDATE nodes SET secret_hash=? WHERE node_id='archive'",core.sha256Hex("archive-secret"));
 await app.listen({host:"127.0.0.1",port:0});
 const socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/internal/provider/connect`,{headers:{"x-provider-node-id":"archive","x-provider-node-secret":"archive-secret"}});
 const frames=[];
 socket.on("message",raw=>{
  const m=JSON.parse(raw.toString());frames.push(m);
  if(m.type==="http_egress.open")socket.send(JSON.stringify({type:"http_egress.open_response",sessionId:m.sessionId,accepted:true}));
  if(m.type==="http_egress.data"){
   const spec=JSON.parse(Buffer.from(m.payloadBase64,"base64").toString());
   assert.equal(spec.url,"https://api.anthropic.com/v1/code/sessions/session-audit-archive/archive");
   socket.send(JSON.stringify({type:"http_egress.data",sessionId:m.sessionId,seq:0,payloadBase64:Buffer.from(JSON.stringify({status:200,headers:{}})+"\n{}").toString("base64")}));
   socket.send(JSON.stringify({type:"http_egress.close",sessionId:m.sessionId,reasonCode:"complete"}));
  }
 });
 await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
 socket.send(JSON.stringify({type:"provider.hello",nodeId:"archive",providerId:adminId,nodeVersion:"fixture",acceptingSessions:true,capabilities:["http_egress","team_isolation_v1"]}));
 for(let i=0;i<100 && !frames.some(m=>m.type==="platform.ready");i++)await new Promise(r=>setTimeout(r,10));
 try{
  core.run("UPDATE ccr_archive_jobs SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=?",queued.id);
  await retryArchiveCleanup();
  assert.equal(core.one("SELECT status FROM ccr_archive_jobs WHERE id=?",queued.id).status,"done");
  const opened=frames.find(m=>m.type==="http_egress.open");
  assert.equal(opened.teamId,team);assert.equal(opened.proxyId,pid);assert.equal(opened.archiveSessionId,snapshot.sessionId);
  assert.equal((await enqueueArchive(snapshot)).status,200);
  assert.equal(core.one("SELECT COUNT(*) n FROM ccr_archive_jobs").n,1);
 }finally{socket.close();await new Promise(r=>socket.once("close",r));}
});
