import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeConfigStore } from '../dist/config.js';
import { buildApp } from '../dist/server.js';
import { managementToken } from '../dist/management-auth.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'node-admin-auth-'));
const store=new NodeConfigStore(path.join(dir,'config.json'));
const app=buildApp({store,bridge:{status:()=>({state:'disabled',officialExitActiveSessions:0,httpEgressActiveSessions:0}),reconnectNow(){}},pool:{summary:()=>[]}});
const headers={host:'localhost'};
const address=await app.listen({host:'127.0.0.1',port:0});
async function request(opts) {
 const r=await fetch(address+opts.url,{method:opts.method??'GET',headers:{...opts.headers,...(opts.payload?{'content-type':'application/json'}:{})},body:opts.payload?JSON.stringify(opts.payload):undefined});
 const body=await r.text();
 return {statusCode:r.status,body,headers:Object.fromEntries(r.headers),json:()=>JSON.parse(body)};
}
try {
  assert.equal((await request({url:'/api/status',headers})).statusCode,401);
  const token=managementToken(store.configPath);
  assert.equal(fs.statSync(path.join(dir,'management.token')).mode&0o777,0o600);
  assert.equal((await request({url:'/api/status',headers:{...headers,authorization:'Bearer incorrect'}})).statusCode,401);
  const status=await request({url:'/api/status',headers:{...headers,authorization:`Bearer ${token}`}});
  assert.equal(status.statusCode,200);
  assert.equal(status.body.includes(token),false);
  const bind=await request({method:'POST',url:'/api/platform/bind',remoteAddress:'127.0.0.1',headers:{...headers,authorization:`Bearer ${token}`,'x-1dayapi-csrf':status.headers['x-csrf-token']},payload:{bindingCode:'bind_fixture',platformBindUrl:'https://different.invalid'}});
  assert.equal(bind.statusCode,403);
  assert.equal(bind.json().error.code,'platform_address_pinned');
} finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
console.log('management-auth: ALL PASSED');
