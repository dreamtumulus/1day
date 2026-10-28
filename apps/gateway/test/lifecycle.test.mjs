import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { wait, StreamDemand, responseBytes } from '../dist/lifecycle.js';
import { postRaw } from '../dist/rawhttp.js';

test('abortable wait cancels without holding its deadline',async()=>{
 const abort=new AbortController();const start=Date.now();const pending=wait(60_000,abort.signal);
 abort.abort();await assert.rejects(pending,{name:'AbortError'});assert.ok(Date.now()-start<500);
});
test('producer pauses when consumer does not read and cancellation unblocks it',async()=>{
 const demand=new StreamDemand();let writes=0;let settled=false;
 const stream=new ReadableStream({start(controller){void(async()=>{try{for(let i=0;i<100;i++){await demand.write(controller,new Uint8Array([i]));writes++;}}catch{}finally{settled=true;demand.close(controller);}})();},pull(){demand.pull();},cancel(){demand.cancel();}});
 await new Promise(r=>setTimeout(r,20));assert.equal(writes,1);
 const reader=stream.getReader();assert.deepEqual((await reader.read()).value,new Uint8Array([0]));
 await new Promise(r=>setTimeout(r,20));assert.equal(writes,2);
 await reader.cancel();await new Promise(r=>setTimeout(r,5));assert.ok(settled);assert.equal(writes,2);
});
test('nonstream body budgets cancel overlarge response and support bounded excerpts',async()=>{
 let cancelled=0;
 const response=()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(8));},cancel(){cancelled++;}}));
 await assert.rejects(responseBytes(response(),12),/exceeds/);
 assert.equal(cancelled,1);
 const bytes=await responseBytes(response(),12,undefined,true);assert.equal(bytes.length,12);assert.equal(cancelled,2);
});
test('raw direct request cancellation before headers closes the upstream socket',async()=>{
 let closed=false;let arrived;
 const ready=new Promise(r=>arrived=r);
 const server=http.createServer((req,res)=>{req.on('close',()=>{closed=true;});arrived();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const abort=new AbortController();
 const pending=postRaw(new URL(`http://127.0.0.1:${server.address().port}`),{},'{}',60_000,abort.signal);
 await ready;abort.abort();await assert.rejects(pending,{name:'AbortError'});
 for(let n=0;!closed&&n<20;n++)await new Promise(r=>setTimeout(r,5));assert.ok(closed);
 server.closeAllConnections();await new Promise(r=>server.close(r));
});
