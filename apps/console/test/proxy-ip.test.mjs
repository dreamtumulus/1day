import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'console-trusted-ip-'));
process.env.DATA_DIR=dir;delete process.env.DB_PATH;
process.env.TRUST_PROXY='127.0.0.1,::1';process.env.COOKIE_SECURE='1';
process.env.LOG_LEVEL='silent';process.env.CCR_WINDOW_POLL='0';
const {buildApp}=await import('../dist/app.js');
const core=await import('../../../packages/core/dist/index.js');
const app=await buildApp();

test('trusted proxy separates login buckets and ignores headers from other sockets',async()=>{
 try {
  const fail=(ip,remoteAddress='127.0.0.1')=>app.inject({method:'POST',url:'/auth/login',remoteAddress,headers:{'x-forwarded-for':ip},payload:{key:'invalid-fixture'}});
  for(let i=0;i<20;i++)await fail('192.0.2.11');
  assert.equal((await fail('192.0.2.11')).statusCode,429);
  assert.notEqual((await fail('192.0.2.12')).statusCode,429);
  for(let i=0;i<20;i++)await fail(`192.0.2.${i+30}`,'198.51.100.10');
  assert.equal((await fail('203.0.113.5','198.51.100.10')).statusCode,429);
 } finally {await app.close();core.db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
