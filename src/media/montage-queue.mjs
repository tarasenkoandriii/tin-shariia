import {randomUUID} from 'node:crypto';
import {del} from '@vercel/blob';
import {ffmpegMontage,montageReport} from './montage-ffmpeg.mjs';
import {montageEnabled,montageUrl} from './montage-storage.mjs';

export async function dispatchMontage(db,startRun){
  if(!montageEnabled()) return {started:false};
  const {rows:expired}=await db.query(`SELECT id,pathname FROM episode_media_revisions
    WHERE state='uploading' AND upload_until<=now()-interval '5 minutes' ORDER BY upload_until LIMIT 3`);
  for(const row of expired){
    try{
      await del(row.pathname);
      await db.query("UPDATE episode_media_revisions SET state='expired' WHERE id=$1 AND state='uploading'",[row.id]);
    }catch{ /* The next dispatch retries deletion; reserved storage stays charged. */ }
  }
  const token=randomUUID();
  const row=await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036597)');
    const {rows:[active]}=await tx.query(`SELECT id FROM episode_media_revisions
      WHERE state='checking' AND run_lease>now() LIMIT 1`);
    if(active) return null;
    const {rows:[job]}=await tx.query(`SELECT id FROM episode_media_revisions
      WHERE state IN ('queued','checking') ORDER BY (state='checking') DESC,created_at LIMIT 1 FOR UPDATE`);
    if(!job) return null;
    await tx.query(`UPDATE episode_media_revisions SET state='checking',run_token=$2,
      run_lease=now()+interval '3 minutes' WHERE id=$1`,[job.id,token]);
    return job;
  });
  if(!row) return {started:false};
  await startRun(row.id,token);
  return {started:true};
}

const terminalErrors=new Set(['MONTAGE_DISABLED','MONTAGE_FFMPEG_REJECTED','MONTAGE_INVALID_MEDIA',
  'MONTAGE_REPORT_INVALID','MONTAGE_AUDIO_INCOMPLETE','MONTAGE_AUDIO_SILENT']);

export async function montageStep(db,id,token,{client=ffmpegMontage(),sign=montageUrl}={}){
  const {rows:[row]}=await db.query(`SELECT * FROM episode_media_revisions
    WHERE id=$1 AND run_token=$2 AND state='checking' AND run_lease>now()`,[id,token]);
  if(!row) return {done:true};
  const complete=async(state,code,sha=null,report=null)=>{
    await db.query(`UPDATE episode_media_revisions SET state=$3,error_code=$4,sha256=$5,report=$6::text::jsonb,
      run_lease=NULL,run_token=NULL WHERE id=$1 AND run_token=$2`,[id,token,state,code,sha,report&&JSON.stringify(report)]);
    return {done:true};
  };
  if(new Date(row.expires_at).getTime()<=Date.now()) return complete('expired',null);
  if(new Date(row.created_at).getTime()<Date.now()-3600000) return complete('failed','MONTAGE_CHECK_TIMEOUT');
  try{
    const key='tin-montage-'+id;
    let job=row.ffmpeg_id?await client.job(row.ffmpeg_id):await client.lookup(key);
    if(!job&&row.ffmpeg_id) return complete('failed','MONTAGE_JOB_EXPIRED');
    if(!job) job=await client.submit(key,await sign(row,'get'));
    if(!job?.id) throw Error('MONTAGE_FFMPEG_UNAVAILABLE');
    await db.query(`UPDATE episode_media_revisions SET ffmpeg_id=$3,run_lease=now()+interval '3 minutes'
      WHERE id=$1 AND run_token=$2`,[id,token,job.id]);
    if(job.status==='succeeded'){
      const result=montageReport(job,await client.report(job),row.expected_bytes);
      return complete('passed',null,result.sha256,result.report);
    }
    if(['failed','canceled'].includes(job.status)) return complete('failed','MONTAGE_DECODE_FAILED');
    return {done:false};
  }catch(error){
    if(terminalErrors.has(error.message)) return complete('failed',error.message);
    return {done:false};
  }
}

export async function yieldMontage(db,id,token){
  await db.query(`UPDATE episode_media_revisions SET run_lease=NULL,run_token=NULL
    WHERE id=$1 AND run_token=$2 AND state='checking'`,[id,token]);
}
