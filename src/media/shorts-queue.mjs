import {createHash,randomUUID} from 'node:crypto';
import {del,put} from '@vercel/blob';
import {ffmpegShorts,validateShortTechnicalReport} from './montage-ffmpeg.mjs';
import {montageUrl,STORAGE_DAYS} from './montage-storage.mjs';
import {createShortAuditMedia,updateShortRender} from '../db/shorts.mjs';

export async function cleanupExpiredShorts(db){
  const {rows}=await db.query(`SELECT id,pathname FROM shorts_renders WHERE expires_at<=now()
    AND state<>'expired' ORDER BY expires_at LIMIT 3`);
  let removed=0;
  for(const row of rows){
    try{
      if(row.pathname) await del(row.pathname);
      await db.query("UPDATE shorts_renders SET state='expired',pathname=NULL WHERE id=$1 AND expires_at<=now()",[row.id]);
      removed++;
    }catch{ /* Keep the record and retry cleanup on the next cron run. */ }
  }
  return {removed};
}

export async function dispatchShorts(db,startRun){
  await cleanupExpiredShorts(db);
  const {rows}=await db.query(`SELECT id FROM shorts_renders WHERE state IN ('queued','rendering','technical_check')
    AND expires_at>now() AND (run_lease IS NULL OR run_lease<=now()) ORDER BY created_at LIMIT 1`);
  if(!rows[0]) return {started:false};
  const result=await startShortRender(db,rows[0].id,startRun);
  return result;
}

export async function startShortRender(db,id,startRun){
  const token=randomUUID();
  const {rows:[row]}=await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036599)');
    const {rows:[active]}=await tx.query(`SELECT id FROM shorts_renders WHERE state IN ('rendering','technical_check') AND run_lease>now() LIMIT 1`);
    if(active) return {rows:[]};
    const {rows:[selected]}=await tx.query(`SELECT id,state FROM shorts_renders WHERE id=$1 AND state IN ('queued','rendering','technical_check')
      AND expires_at>now() FOR UPDATE`,[id]);
    if(!selected) return {rows:[]};
    const nextState=selected.state==='queued'?'rendering':selected.state;
    const {rows:[locked]}=await tx.query(`UPDATE shorts_renders SET state=$3,run_token=$2,
      run_lease=now()+interval '3 minutes' WHERE id=$1 RETURNING id`,[id,token,nextState]);
    return {rows:[locked]};
  });
  if(!row) return {started:false};
  await startRun(id,token);
  return {started:true};
}

export async function shortsStep(db,id,token,{client=ffmpegShorts(),sign=montageUrl,save=put}={}){
  const {rows:[row]}=await db.query(`SELECT s.*,m.pathname AS source_path,m.expires_at AS source_expires_at
    FROM shorts_renders s JOIN episode_media_revisions m ON m.id=s.media_revision_id
    WHERE s.id=$1 AND s.run_token=$2 AND s.state IN ('rendering','technical_check') AND s.run_lease>now()`,[id,token]);
  if(!row) return {done:true};
  const complete=async(state,errorCode=null,extra={})=>{
    await updateShortRender(db,id,token,{state,errorCode,...extra,lease:null});
    return {done:true};
  };
  if(new Date(row.expires_at)<=new Date()||new Date(row.source_expires_at)<=new Date()) return complete('expired','SHORTS_SOURCE_EXPIRED');
  if(new Date(row.created_at)<new Date(Date.now()-60*60*1000)) return complete('failed','SHORTS_RENDER_TIMEOUT');
  try{
    if(row.state==='rendering'){
      const key='tin-shorts-'+id;
      let job=row.ffmpeg_id?await client.job(row.ffmpeg_id):await client.lookup(key);
      if(!job&&row.ffmpeg_id) return complete('failed','SHORTS_FFMPEG_JOB_EXPIRED');
      if(!job) job=await client.submit(key,await sign({pathname:row.source_path,expires_at:row.source_expires_at},'get',25),row.manifest);
      if(!job?.id) throw Error('SHORTS_RENDER_UNAVAILABLE');
      if(!await updateShortRender(db,id,token,{state:'rendering',ffmpegId:job.id,lease:new Date(Date.now()+180000)})) return {done:true};
      if(['failed','canceled'].includes(job.status)) return complete('failed','SHORTS_FFMPEG_FAILED');
      if(job.status!=='succeeded') return {done:false};
      const bytes=await client.shortFile(job);
      if(bytes.length<16||bytes.toString('ascii',4,8)!=='ftyp') return complete('failed','SHORTS_OUTPUT_INVALID');
      const sha256=createHash('sha256').update(bytes).digest('hex');
      const pathname=`shorts/${row.episode_id}/${id}.mp4`;
      await save(pathname,bytes,{access:'private',contentType:'video/mp4',addRandomSuffix:false,
        allowOverwrite:true,cacheControlMaxAge:STORAGE_DAYS*86400});
      await updateShortRender(db,id,token,{state:'technical_check',pathname,bytes,sha256,lease:new Date(Date.now()+180000)});
      return {done:false};
    }

    const key='tin-short-tech-'+id;
    let job=row.audit_ffmpeg_id?await client.job(row.audit_ffmpeg_id):await client.lookup(key);
    if(!job&&row.audit_ffmpeg_id) return complete('failed','SHORTS_TECH_CHECK_EXPIRED');
    if(!job) job=await client.submitAudit(key,await sign({pathname:row.pathname,expires_at:row.expires_at},'get',25));
    if(!job?.id) throw Error('SHORTS_RENDER_UNAVAILABLE');
    if(!await updateShortRender(db,id,token,{state:'technical_check',auditFfmpegId:job.id,lease:new Date(Date.now()+180000)})) return {done:true};
    if(['failed','canceled'].includes(job.status)) return complete('failed','SHORTS_TECH_CHECK_FAILED');
    if(job.status!=='succeeded') return {done:false};
    const report=validateShortTechnicalReport(job,await client.report(job),row.expected_bytes,row.sha256);
    const auditMediaRevisionId=await createShortAuditMedia(db,id,token,report);
    if(!auditMediaRevisionId) return {done:true};
    return complete('ready',null,{technicalReport:report,auditMediaRevisionId});
  }catch(error){
    const code=String(error?.message??'');
    if(['MONTAGE_DISABLED','MONTAGE_FFMPEG_REJECTED','SHORTS_RENDER_INVALID','SHORTS_INVALID_INPUT',
      'SHORTS_INVALID_CLIP','SHORTS_DURATION_INVALID','SHORTS_INVALID_SOURCE','SHORTS_OUTPUT_INVALID',
      'MONTAGE_INVALID_MEDIA','MONTAGE_REPORT_INVALID','MONTAGE_AUDIO_INCOMPLETE','MONTAGE_AUDIO_SILENT',
      'SHORTS_TECH_CHECK_REJECTED'].includes(code))
      return complete('failed',code.startsWith('MONTAGE_')?'SHORTS_TECH_CHECK_FAILED':code.startsWith('SHORTS_')?code:'SHORTS_RENDER_REJECTED');
    return {done:false};
  }
}

export async function yieldShortRender(db,id,token){
  await db.query(`UPDATE shorts_renders SET run_lease=NULL,run_token=NULL
    WHERE id=$1 AND run_token=$2 AND state IN ('rendering','technical_check')`,[id,token]);
}
