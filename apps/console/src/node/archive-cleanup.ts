import {all,decryptJson,encryptJson,nowIso,one,run,sha256Hex} from "@1dayapi/core";
import { HttpError } from "../http.js";
import { archiveViaNodeSnapshot, validateArchiveSnapshot } from "./egress-request.js";

export type ArchiveSnapshot=Parameters<typeof archiveViaNodeSnapshot>[0];
interface ArchiveJob {id:string;payload_enc:string;attempts:number;next_attempt_at:string;status:string}
const active=new Map<string,Promise<{status:number;text:string;nodeId:string}>>();

async function attempt(job:ArchiveJob):Promise<{status:number;text:string;nodeId:string}> {
  let snapshot:ArchiveSnapshot;
  try {snapshot=decryptJson<ArchiveSnapshot>(job.payload_enc);} catch {
    run("UPDATE ccr_archive_jobs SET status='failed',last_error='cleanup_payload_unreadable' WHERE id=?",job.id);
    return {status:202,text:"archive queued for operator recovery",nodeId:""};
  }
  try {
    const result=await archiveViaNodeSnapshot(snapshot);
    // Already absent counts as archived. Never retry authentication/permission failures
    // aggressively; retain the encrypted intention for operator recovery instead.
    if(!('nodeError' in result) && ((result.status>=200 && result.status<300) || result.status===404 || result.status===410)){
      run("UPDATE ccr_archive_jobs SET status='done',attempts=attempts+1,last_error=NULL WHERE id=?",job.id);
      return {status:200,text:"archived",nodeId:snapshot.nodeId};
    }
    const error='nodeError' in result?result.nodeError:`upstream_http_${result.status}`;
    const permanent=/^cleanup_(identity|target|binding)_invalid$/.test(error) || (!('nodeError' in result) && [400,401,403].includes(result.status));
    const delay=Math.min(30*60_000,15_000*2**Math.min(job.attempts,7));
    run("UPDATE ccr_archive_jobs SET status=?,attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=?",permanent?"failed":"pending",error,new Date(Date.now()+delay).toISOString().slice(0,19)+"Z",job.id);
  } catch(error) {
    const delay=Math.min(30*60_000,15_000*2**Math.min(job.attempts,7));
    // No upstream body, credentials, or exception message is persisted as an error.
    run("UPDATE ccr_archive_jobs SET status='pending',attempts=attempts+1,last_error='cleanup_transport_failed',next_attempt_at=? WHERE id=?",new Date(Date.now()+delay).toISOString().slice(0,19)+"Z",job.id);
  }
  return {status:202,text:"archive accepted for retry",nodeId:snapshot.nodeId};
}
function runOnce(job:ArchiveJob):Promise<{status:number;text:string;nodeId:string}> {
  const existing=active.get(job.id);
  if(existing)return existing;
  const running=attempt(job).finally(()=>active.delete(job.id));
  active.set(job.id,running);
  return running;
}

/** Durable before network: gateway can drop its in-memory credential snapshot afterwards. */
export async function enqueueArchive(snapshot:ArchiveSnapshot):Promise<{status:number;text:string;nodeId:string}> {
  const invalid=validateArchiveSnapshot(snapshot);
  if(invalid)throw new HttpError(400,invalid,"Archive identity or fixed binding is invalid");
  const id=sha256Hex(JSON.stringify([snapshot.accountId,snapshot.nodeId,snapshot.teamId,snapshot.proxyId,snapshot.sessionId]));
  const now=nowIso();
  run("INSERT INTO ccr_archive_jobs(id,payload_enc,next_attempt_at,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",id,encryptJson(snapshot),now,now);
  const job=one<ArchiveJob>("SELECT * FROM ccr_archive_jobs WHERE id=?",id)!;
  if(job.status==='done')return {status:200,text:"archived",nodeId:snapshot.nodeId};
  if(job.status==='failed')return {status:202,text:"archive retained for operator recovery",nodeId:snapshot.nodeId};
  return runOnce(job);
}

export async function retryArchiveCleanup():Promise<void> {
  const jobs=all<ArchiveJob>("SELECT * FROM ccr_archive_jobs WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 20",nowIso());
  // Bound parallel work; a disconnected node must not delay every other cleanup.
  for(let offset=0;offset<jobs.length;offset+=4)await Promise.allSettled(jobs.slice(offset,offset+4).map(runOnce));
}
export function startArchiveCleanup():()=>Promise<void> {
  let inflight:Promise<void>|null=null;
  let stopped=false;
  const tick=()=>{
    if(inflight||stopped)return;
    inflight=retryArchiveCleanup().catch(()=>console.error("[archive] durable cleanup tick failed")).finally(()=>{inflight=null;});
  };
  const start=setTimeout(tick,1000);start.unref();
  const timer=setInterval(tick,15_000);timer.unref();
  // Stop = no new ticks AND wait for the one in flight: a tick finishing after app.close()
  // touched a closed database (test teardown flake, 2026-10-28).
  return async()=>{stopped=true;clearTimeout(start);clearInterval(timer);if(inflight)await inflight;};
}
