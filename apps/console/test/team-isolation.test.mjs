import assert from "node:assert/strict";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { after,test } from "node:test";

const dir=mkdtempSync(join(tmpdir(),"1dayapi-isolation-"));
process.env.DATA_DIR=dir;
process.env.CCR_WINDOW_POLL="0";
process.env.ALLOW_UNTRUSTED_EXECUTION="1";
process.env.ONBOARD_MOCK="1";
process.env.ONBOARD_MOCK_DELAY_MS="40";
process.env.ONBOARD_PROFILE_FETCH="0";
const A="11111111-1111-4111-8111-111111111111";
const B="22222222-2222-4222-8222-222222222222";
process.env.ONBOARD_MOCK_ORG_UUID=A;
const core=await import("@1dayapi/core");
const {buildApp}=await import("../dist/app.js");
const {createUser}=await import("../dist/session.js");
const {addNodeProxies,recordNodeProxyExit,resolveTeamProxy,proxyOccupancy,nodeProxyConfig,canonicalProxyResourceKey}=await import("../dist/node/proxies.js");
const {sweepStaleJobs}=await import("../dist/onboard/jobs.js");
const app=await buildApp();
after(async()=>{await app.close();core.db.close();rmSync(dir,{recursive:true,force:true});});
async function login(key){
  const r=await app.inject({method:"POST",url:"/auth/login",payload:{key}});
  const cookie=r.headers["set-cookie"].split(";")[0];
  return async(method,url,payload)=>{
    const res=await app.inject({method,url,payload,headers:{cookie}});
    return {status:res.statusCode,...res.json()};
  };
}
const admin=await login(readFileSync(join(dir,"admin-key.txt"),"utf8").trim());
const adminId=core.one("SELECT id FROM users WHERE role='admin'").id;
const ops=await login(createUser("ops","ops").loginKey);
function node(id,ips,ownerId=adminId){
  core.run("INSERT INTO nodes(node_id,provider_id,secret_hash,online) VALUES (?,?,?,1)",id,ownerId,"h");
  const urls=ips.map((ip,i)=>`http://u${i}:p@${ip}:8080`);
  core.tx(()=>addNodeProxies(id,urls.map(url=>({url}))));
  return urls.map((url,i)=>{
    const pid=core.sha256Hex(url).slice(0,12);
    core.run("UPDATE node_proxies SET status='live' WHERE id=?",pid);
    assert.equal(recordNodeProxyExit(id,pid,ips[i]),true);
    return pid;
  });
}
async function start(nodeId,orgUuid=A,extra={}){
  return admin("POST","/api/admin/accounts/onboard",{method:"session_key",nodeId,sessionKey:"fixture",...(orgUuid?{orgUuid}:{}),...extra});
}
async function done(jobId){
  for(let i=0;i<100;i++){
    const r=await admin("GET",`/api/admin/accounts/onboard/${jobId}`);
    if(["done","failed"].includes(r.data?.status))return r.data;
    await new Promise(r=>setTimeout(r,10));
  }
  throw new Error("job timed out");
}

test("normal two slots, emergency third, alias IP global cap, permanent organization claim",async()=>{
  const [p1,p2,pAlias]=node("capacity",["192.0.2.1","192.0.2.2","192.0.2.1"]);
  const jobs=[];
  // Concurrent reservations must count before either authorization finishes.
  const first=await Promise.all([start("capacity",A,{teamName:"Private Team"}),start("capacity",A)]);
  for(const r of first){assert.equal(r.status,200);jobs.push(await done(r.data.jobId));}
  assert.equal(proxyOccupancy("ip:192.0.2.1").total+proxyOccupancy("ip:192.0.2.2").total,2);
  for(let i=0;i<4;i++){const r=await start("capacity");assert.equal(r.status,200);jobs.push(await done(r.data.jobId));}
  assert.ok(jobs.every(j=>j.status==="done"),JSON.stringify(jobs));
  assert.equal(proxyOccupancy("ip:192.0.2.1").total,3);
  assert.equal(proxyOccupancy("ip:192.0.2.2").total,3);
  assert.equal((await start("capacity")).error.code,"proxy_pool_empty");
  // A URL alias is not three additional account slots.
  assert.throws(()=>resolveTeamProxy("capacity",A,pAlias));
  assert.throws(()=>resolveTeamProxy("capacity",B));
  const victim=jobs[0].accountId;
  assert.equal((await admin("DELETE",`/api/admin/accounts/${victim}`)).status,200);
  assert.equal(core.one("SELECT team_id FROM proxy_team_claims WHERE resource_key='ip:192.0.2.1'").team_id,A);
  assert.throws(()=>resolveTeamProxy("capacity",B));
  assert.ok(resolveTeamProxy("capacity",A).id);
  const event=core.one("SELECT * FROM proxy_team_events WHERE event='account_bound' LIMIT 1");
  assert.throws(()=>core.run("UPDATE proxy_team_events SET event='changed' WHERE id=?",event.id),/append-only/);
  assert.throws(()=>core.run("DELETE FROM proxy_team_claims WHERE resource_key='ip:192.0.2.1'"),/append-only/);
  assert.ok(nodeProxyConfig("capacity").proxyTeams[p1] || nodeProxyConfig("capacity").proxyTeams[pAlias]);
  assert.ok(nodeProxyConfig("capacity").proxyTeams[p2]);
});

test("unknown organization discovery permanently claims its exit, then fills an existing one-account exit",async()=>{
  const proxies=node("discovery",["192.0.2.10","192.0.2.11"]);
  const initial=await done((await start("discovery",A)).data.jobId);
  assert.equal(initial.status,"done");
  const first=core.one("SELECT bound_proxy_id FROM accounts WHERE id=?",initial.accountId).bound_proxy_id;
  const bootstrap=proxies.find(id=>id!==first);
  const firstKey=core.one("SELECT resource_key FROM node_proxies WHERE id=?",first).resource_key;
  const bootstrapKey=core.one("SELECT resource_key FROM node_proxies WHERE id=?",bootstrap).resource_key;
  const second=await done((await start("discovery",null)).data.jobId);
  assert.equal(second.status,"done",second.error);
  assert.equal(core.one("SELECT bound_proxy_id FROM accounts WHERE id=?",second.accountId).bound_proxy_id,first);
  assert.equal(core.one("SELECT team_id FROM node_proxies WHERE id=?",bootstrap).team_id,A);
  assert.equal(proxyOccupancy(firstKey).bound,2);
  assert.equal(proxyOccupancy(bootstrapKey).bound,0);
  assert.ok(core.one("SELECT 1 FROM proxy_team_events WHERE proxy_id=? AND event='organization_discovered'",bootstrap));
});

test("only actual admins receive team names, UUIDs, and history; ops and provider bodies omit metadata",async()=>{
  const admins=await admin("GET","/api/admin/accounts");
  assert.ok(admins.data.items.some(a=>a.teamId===A && a.teamName==="Private Team"));
  const operators=await ops("GET","/api/admin/accounts");
  assert.ok(operators.data.items.every(a=>!("teamId" in a) && !("teamName" in a)));
  assert.equal((await ops("GET","/api/admin/teams")).status,403);
  assert.equal((await ops("GET","/api/admin/teams/events")).status,403);
  const events=await admin("GET","/api/admin/teams/events");
  assert.equal(events.status,200);
  assert.ok(events.data.some(e=>e.teamId===A && e.reason));
});

test("legacy proxies and credentials are not inferred or assigned; non-OAuth scheduling survives",()=>{
  core.run("INSERT INTO node_proxies(id,node_id,url_enc,status,exit_ip,resource_key) VALUES ('legacy','discovery',?,'live','192.0.2.99','ip:192.0.2.99')",core.encryptString("http://192.0.2.99:80"));
  assert.equal(recordNodeProxyExit("discovery","legacy","192.0.2.100"),false);
  assert.equal(core.one("SELECT exit_ip FROM node_proxies WHERE id='legacy'").exit_ip,"192.0.2.99");
  assert.throws(()=>resolveTeamProxy("discovery",A,"legacy"));
  for(const [id,type] of [["legacy-account","oauth"],["relay","apikey"]]){
    core.run("INSERT INTO accounts(id,name,platform,type,protocol,credential_enc) VALUES (?,?,'anthropic',?,'anthropic',?)",id,id,type,core.encryptJson({orgUuid:A,apiKey:"k"}));
    core.run("INSERT INTO account_groups(account_id,group_id) VALUES (?,'default')",id);
  }
  const candidates=core.listCandidates("default","claude-sonnet-5");
  assert.ok(!candidates.some(a=>a.id==="legacy-account"));
  assert.ok(candidates.some(a=>a.id==="relay"));
  assert.equal(core.one("SELECT team_id FROM accounts WHERE id='legacy-account'").team_id,null);
});

test("manual OAuth payload organization is only an expectation and cannot override validation",async()=>{
  node("manual",["192.0.2.30"]);
  const r=await admin("POST","/api/admin/accounts",{name:"manual",platform:"anthropic",type:"oauth",nodeId:"manual",route:"node",
    accessToken:"token",orgUuid:B,teamId:B,teamName:"Forged"});
  assert.equal(r.status,400,JSON.stringify(r));
  assert.equal(core.one("SELECT COUNT(*) n FROM accounts WHERE name='manual'").n,0);
  assert.equal(core.one("SELECT COUNT(*) n FROM upstream_teams WHERE id=?",B).n,0);
});

test("same IP on different nodes shares the cap; a failed reservation frees its slot",async()=>{
  node("shared-a",["192.0.2.40"]);
  // Different URL/port and node, identical measured public exit.
  core.run("INSERT INTO nodes(node_id,provider_id,secret_hash,online) VALUES ('shared-b',?,'h',1)",adminId);
  const url="http://other:credential@192.0.2.140:9000";
  core.tx(()=>addNodeProxies("shared-b",[{url}]));
  const p=core.sha256Hex(url).slice(0,12);
  core.run("UPDATE node_proxies SET status='live' WHERE id=?",p);
  assert.equal(recordNodeProxyExit("shared-b",p,"192.0.2.40"),true);
  for(const id of ["shared-a","shared-a","shared-b"]){const j=await done((await start(id,A)).data.jobId);assert.equal(j.status,"done",j.error);}
  assert.equal(proxyOccupancy("ip:192.0.2.40").total,3);
  assert.equal((await start("shared-b",A)).error.code,"proxy_pool_empty");
  assert.equal((await start("shared-b",B)).error.code,"proxy_pool_empty");
  node("release",["192.0.2.41"]);
  const failed=await done((await start("release",B)).data.jobId);
  assert.equal(failed.status,"failed");
  assert.equal(proxyOccupancy("ip:192.0.2.41").total,0);
  const retry=await done((await start("release",A)).data.jobId);
  assert.equal(retry.status,"done",retry.error);
});

test("three concurrent reservations fill one IP and the fourth is refused atomically",async()=>{
  node("reservation",["192.0.2.50"]);
  const requests=await Promise.all(Array.from({length:4},()=>start("reservation",A)));
  assert.equal(requests.filter(r=>r.status===200).length,3);
  assert.equal(requests.filter(r=>r.error?.code==="proxy_pool_empty").length,1);
  for(const r of requests.filter(r=>r.status===200))assert.equal((await done(r.data.jobId)).status,"done");
  assert.equal(proxyOccupancy("ip:192.0.2.50").total,3);
});

test("provider and consumer cannot enumerate organizations, including raw job errors; ops probes redact upstream errors",async()=>{
  const provider=createUser("provider","provider");
  const prov=await login(provider.loginKey);
  node("provider-private",["192.0.2.60"],provider.id);
  const started=await prov("POST","/api/provider/accounts/onboard",{nodeId:"provider-private",method:"session_key",sessionKey:"fixture",orgUuid:A});
  let job;
  for(let i=0;i<100;i++){
    job=(await prov("GET",`/api/provider/accounts/onboard/${started.data.jobId}`)).data;
    if(job.status==="done")break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(job.status,"done");
  core.run("UPDATE accounts SET error_message=? WHERE id=?",`${A} Private Team`,job.accountId);
  const accounts=await prov("GET","/api/provider/accounts");
  assert.equal(JSON.stringify(accounts).includes(A),false);
  assert.equal(JSON.stringify(accounts).includes("Private Team"),false);
  for(const endpoint of ["/api/admin/teams","/api/admin/teams/events","/api/admin/accounts"])
    assert.equal((await prov("GET",endpoint)).status,403);
  core.run("UPDATE onboarding_jobs SET status='failed',error=? WHERE id=?",`${A} Private Team upstream response`,started.data.jobId);
  const hidden=await prov("GET",`/api/provider/accounts/onboard/${started.data.jobId}`);
  assert.equal(JSON.stringify(hidden).includes(A),false);
  const opJob=await ops("GET",`/api/admin/accounts/onboard/${started.data.jobId}`);
  assert.equal(JSON.stringify(opJob).includes(A),false);
  const consumer=await login(createUser("consumer","consumer").loginKey);
  for(const endpoint of ["/api/admin/teams","/api/admin/teams/events","/api/admin/accounts"])
    assert.equal((await consumer("GET",endpoint)).status,403);
  assert.equal(JSON.stringify(await consumer("GET","/api/user/overview")).includes(A),false);
  const server=createServer((req,res)=>{res.writeHead(403,{"content-type":"application/json"});res.end(JSON.stringify({error:{message:`${A} Private Team`}}));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    core.run("UPDATE accounts SET route='direct',base_url=?,status='active',temp_unschedulable_until=NULL WHERE id=?",
      `http://127.0.0.1:${server.address().port}`,job.accountId);
    for(const suffix of ["profile","window","test"]){
      const r=await ops("POST",`/api/admin/accounts/${job.accountId}/${suffix}`,{});
      assert.equal(JSON.stringify(r).includes(A),false);
      assert.equal(JSON.stringify(r).includes("Private Team"),false);
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test("expired authorization cannot revive a job or recycle a touched unverified exit",async()=>{
  const [p]=node("expired",["192.0.2.70"]);
  const r=await start("expired",A);
  core.run("UPDATE onboarding_jobs SET egress_started_at=?,updated_at=?,expires_at=? WHERE id=?",core.nowIso(),"2000-01-01T00:00:00Z","2000-01-01T00:00:00Z",r.data.jobId);
  assert.ok(sweepStaleJobs()>0);
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(core.one("SELECT status FROM onboarding_jobs WHERE id=?",r.data.jobId).status,"failed");
  assert.equal(core.one("SELECT COUNT(*) n FROM accounts WHERE node_id='expired'").n,0);
  assert.equal(proxyOccupancy("ip:192.0.2.70").total,0);
  assert.ok(core.one("SELECT 1 FROM proxy_quarantine WHERE resource_key=?",`proxy:${p}`));
  assert.throws(()=>resolveTeamProxy("expired",B));
  assert.deepEqual(nodeProxyConfig("expired").proxyAccounts[p],[]);
  assert.match(nodeProxyConfig("expired").proxyTeams[p],/^unassigned:/);
});

test("observed provider exit changes cannot enter another organization's resource",async()=>{
  const [a]=node("drift-a",["192.0.2.80"]);
  assert.equal((await done((await start("drift-a",A)).data.jobId)).status,"done");
  const [b]=node("drift-b",["192.0.2.81"]);
  process.env.ONBOARD_MOCK_ORG_UUID=B;
  try{assert.equal((await done((await start("drift-b",B)).data.jobId)).status,"done");}
  finally{process.env.ONBOARD_MOCK_ORG_UUID=A;}
  assert.equal(recordNodeProxyExit("drift-a",a,"192.0.2.81"),false);
  assert.equal(core.one("SELECT team_id FROM proxy_team_claims WHERE resource_key='ip:192.0.2.81'").team_id,B);
  assert.equal(core.one("SELECT team_id FROM proxy_team_claims WHERE resource_key='ip:192.0.2.80'").team_id,A);
  assert.deepEqual(nodeProxyConfig("drift-a").proxyAccounts[a],[]);
  assert.ok(nodeProxyConfig("drift-b").proxyAccounts[b].length);
});

test("a legacy row with the same upstream UUID is preserved while a new managed row is created",async()=>{
  const uuid="legacy-upstream-identity";
  const encrypted=core.encryptJson({accessToken:"legacy-token",accountId:uuid,orgUuid:A});
  core.run("INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,status,account_email) VALUES ('old-same-uuid','old','anthropic','oauth','anthropic',?,'error','old@example.test')",encrypted);
  const before=core.one("SELECT * FROM accounts WHERE id='old-same-uuid'");
  node("legacy-duplicate",["192.0.2.90"]);
  process.env.ONBOARD_MOCK_ACCOUNT_UUID=uuid;
  let result;
  try{result=await done((await start("legacy-duplicate",A)).data.jobId);}
  finally{delete process.env.ONBOARD_MOCK_ACCOUNT_UUID;}
  assert.equal(result.status,"done",result.error);
  assert.notEqual(result.accountId,"old-same-uuid");
  assert.deepEqual(core.one("SELECT * FROM accounts WHERE id='old-same-uuid'"),before);
  assert.equal(core.one("SELECT team_id FROM accounts WHERE id=?",result.accountId).team_id,A);
});

test("IPv6 spelling aliases share one canonical exit resource",()=>{
  assert.equal(canonicalProxyResourceKey("2001:0db8:0000:0000:0000:0000:0000:0001"),"ip:2001:db8::1");
  assert.equal(canonicalProxyResourceKey("2001:db8::1"),canonicalProxyResourceKey("2001:0DB8::0001"));
  assert.equal(canonicalProxyResourceKey("not-an-ip"),null);
});

test("unchanged heartbeat observations do not acquire a write transaction",()=>{
  const [p]=node("unchanged-exit",["192.0.2.95"]);
  const observer=new DatabaseSync(core.dbPath);
  try{
    const before=observer.prepare("PRAGMA data_version").get().data_version;
    for(let i=0;i<10;i++)assert.equal(recordNodeProxyExit("unchanged-exit",p,"192.0.2.95"),true);
    assert.equal(observer.prepare("PRAGMA data_version").get().data_version,before);
  }finally{observer.close();}
});
