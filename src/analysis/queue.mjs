import {monthlyAnalysisBudget} from './monthly-budget.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { activeMember } from '../access/membership.mjs';
import { videoOutputLimit, videoPrompt, videoPromptVersion } from './video-input.mjs';
import { uuid } from '../editorial/workflow-input.mjs';
import { makePrompt, mergeDrafts, outputLimit, promptVersion, splitTranscript } from './input.mjs';
import { splitYouTubeVideo, youtubeDurationSec, youtubePromptVersion, youtubeReserve } from './youtube-full.mjs';

const attemptsLimit=3;
const transientLimit=2;
const active=['queued','running'];
const json = value=>JSON.stringify(value);

export function enqueueAnalysis(db,identity,videoId,input,config){
  const transcriptId=uuid(input.transcriptId);
  videoId=uuid(videoId);
  return enqueue(db,identity,input,config,async tx=>{
    const {rows:[transcript]}=await tx.query(
      'SELECT content_hash FROM transcripts WHERE id=$1 AND video_id=$2',[transcriptId,videoId],
    );
    if(!transcript) throw Error('NOT_FOUND');
    return {
      videoId,transcriptId,mediaId:null,mode:'transcript',hash:transcript.content_hash,prompt:promptVersion,
      async work(){
        const {rows}=await tx.query(
          'SELECT position,start_ms,end_ms,body FROM transcript_segments WHERE transcript_id=$1 ORDER BY position LIMIT 12001',[transcriptId],
        );
        if(rows.length>12000) throw Error('TRANSCRIPT_TOO_LARGE');
        const chunks=splitTranscript(rows);
        const reserve=chunks.reduce((sum,chunk)=>sum+(Buffer.byteLength(makePrompt(chunk))+1024)*config.inputRate
          +outputLimit*config.outputRate,0);
        return {chunks,reserve};
      },
    };
  });
}

// Whole public YouTube video: Gemini watches it window by window. Duration comes from the YouTube Data API,
// or from the author when the API is unavailable.
export function enqueueYouTubeAnalysis(db,identity,videoId,input,config,{duration=youtubeDurationSec}={}){
  videoId=uuid(videoId);
  const manual=input.durationSec;
  if(manual!==undefined&&(!Number.isSafeInteger(manual)||manual<10||manual>86400)) throw Error('INVALID_INPUT');
  return enqueue(db,identity,input,config,async tx=>{
    const {rows:[video]}=await tx.query('SELECT youtube_id FROM videos WHERE id=$1',[videoId]);
    if(!video) throw Error('NOT_FOUND');
    const durationSec=(await duration(video.youtube_id))??manual??null;
    if(!durationSec) throw Error('YOUTUBE_DURATION_REQUIRED');
    return {
      videoId,transcriptId:null,mediaId:null,mode:'youtube',hash:video.youtube_id+':'+durationSec,prompt:youtubePromptVersion,
      work(){
        const chunks=splitYouTubeVideo(video.youtube_id,durationSec);
        return {chunks,reserve:youtubeReserve(chunks,config)};
      },
    };
  });
}

export function enqueueVideoAudit(db,identity,episodeId,mediaId,input,config){
  return enqueue(db,identity,input,config,async tx=>{
    const {rows:[media]}=await tx.query(`SELECT m.id,m.episode_version,m.snapshot,m.sha256,m.expected_bytes,m.report,
      m.state,m.expires_at,c.video_id,c.status AS claim_status,c.version AS claim_version,
      e.version AS current_version,e.status AS episode_status,p.id AS publication
      FROM episode_media_revisions m JOIN episodes e ON e.id=m.episode_id JOIN claims c ON c.id=e.claim_id
      LEFT JOIN publications p ON p.episode_id=e.id WHERE m.id=$1 AND e.id=$2 FOR SHARE OF m,e,c`,[uuid(mediaId),uuid(episodeId)]);
    if(!media) throw Error('NOT_FOUND');
    const durationMs=media.report?.durationMs;
    if(media.state!=='passed'||!media.sha256||!Number.isInteger(durationMs)||durationMs<100||durationMs>600000
        ||!media.report?.audioCodec||new Date(media.expires_at).getTime()<=Date.now()) throw Error('MEDIA_NOT_READY');
    if(media.publication||media.episode_status!=='approved'||media.claim_status!=='approved'
        ||media.episode_version!==media.current_version||media.snapshot.claimVersion!==media.claim_version) throw Error('MEDIA_STALE');
    const chunk={scoreEditing:true,mediaId:media.id,durationMs,snapshot:media.snapshot,expectedBytes:media.expected_bytes,sha256:media.sha256};
    return {
      videoId:media.video_id,transcriptId:null,mediaId:media.id,mode:'video',hash:media.sha256,prompt:videoPromptVersion,
      work:()=>({chunks:[chunk],reserve:(Math.ceil(durationMs/1000)*320+Buffer.byteLength(videoPrompt(chunk))+2048)*config.inputRate
        +videoOutputLimit*config.outputRate}),
    };
  });
}

function enqueue(db,identity,input,config,resolveSource){
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036593)');
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('author')) throw Error('FORBIDDEN');
    const source=await resolveSource(tx);
    const {videoId,transcriptId,mediaId,mode,prompt,hash}=source;
    const fingerprint=createHash('sha256').update(json([videoId,mode,transcriptId??mediaId,hash,config.model,prompt])).digest('hex');
    const {rows:[existing]}=await tx.query('SELECT * FROM ai_jobs WHERE dedupe_key=$1 FOR UPDATE',[fingerprint]);
    if (input.retry===true) {
      if (!existing||existing.requested_by!==member.id) throw Error('FORBIDDEN');
      if (input.expectedAttempt!==existing.attempt) throw Error('ATTEMPT_CONFLICT');
      if (!(mode==='video'?['failed','unknown','succeeded']:['failed','unknown']).includes(existing.status)||existing.attempt>=attemptsLimit) throw Error('RETRY_NOT_AVAILABLE');
      if (existing.status==='unknown'&&input.acknowledgeUnknown!==true) throw Error('ACKNOWLEDGMENT_REQUIRED');
    } else if (existing) {
      return { id:existing.id, status:existing.status, attempt:existing.attempt, deduplicated:true };
    }
    const {rows:[counts]}=await tx.query(
      `SELECT count(*)::integer AS total, count(*) FILTER (WHERE requested_by=$1)::integer AS actor
       FROM ai_jobs WHERE status IN ('queued','running')`,[member.id],
    );
    if (counts.total>=2||counts.actor>=1) throw Error('CONCURRENCY_LIMIT');
    const {chunks,reserve}=await source.work();
    const budget=await monthlyAnalysisBudget(tx);
    if (Number(budget.used)+reserve>config.monthlyMicros) throw Error('BUDGET_EXHAUSTED');
    const attempt=existing?existing.attempt+1:1;
    let id=existing?.id;
    if(existing){
      await tx.query("UPDATE ai_jobs SET attempt=$2,status='queued',error_code=NULL,updated_at=now() WHERE id=$1",[id,attempt]);
    }else{
      const {rows:[created]}=await tx.query(
        `INSERT INTO ai_jobs (video_id,transcript_id,requested_by,dedupe_key,model,prompt_version,mode,media_revision_id,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING id`,
        [videoId,transcriptId,member.id,fingerprint,config.model,prompt,mode,mediaId],
      );
      id=created.id;
    }
    await tx.query("INSERT INTO ai_attempts (job_id,attempt,status) VALUES ($1,$2,'queued')",[id,attempt]);
    await tx.query("INSERT INTO budget_reservations (job_id,attempt,month,reserved_micros,status) VALUES ($1,$2,$3,$4,'held')",
      [id,attempt,budget.month,reserve]);
    for(const [position,chunk] of chunks.entries()){
      await tx.query(`INSERT INTO ai_chunks (job_id,attempt,position,input,input_rate,output_rate)
        VALUES ($1,$2,$3,$4::text::jsonb,$5,$6)`,[id,attempt,position,json(chunk),config.inputRate,config.outputRate]);
    }
    await tx.query('INSERT INTO job_outbox (job_id,attempt) VALUES ($1,$2)',[id,attempt]);
    return {id,status:'queued',attempt,deduplicated:false};
  });
}

export async function dispatchAnalysis(db, startRun) {
  await recoverAnalysis(db);
  const token=randomUUID();
  const {rows}=await db.query(
    `WITH lease AS (
       SELECT job_id,attempt FROM job_outbox WHERE finished_at IS NULL AND available_at<=now()
       AND (lease_until IS NULL OR lease_until<=now()) ORDER BY available_at LIMIT 4 FOR UPDATE SKIP LOCKED
     )
     UPDATE job_outbox o SET lease_token=$1,lease_until=now()+interval '90 seconds'
     FROM lease WHERE o.job_id=lease.job_id AND o.attempt=lease.attempt RETURNING o.job_id,o.attempt`,[token],
  );
  let started=0;
  for(const row of rows){
    try{
      const run=await startRun(row.job_id,row.attempt);
      await db.query(`UPDATE job_outbox SET workflow_run_id=$4,finished_at=now()
        WHERE job_id=$1 AND attempt=$2 AND lease_token=$3`,[row.job_id,row.attempt,token,run]);
      started++;
    }catch{
      // A run may already exist. The lease expires and the job itself fences duplicate sends.
    }
  }
  return {leased:rows.length,started};
}

async function finish(tx,id,attempt,status,code){
  await tx.query('UPDATE ai_jobs SET status=$3,error_code=$4,updated_at=now() WHERE id=$1 AND attempt=$2',[id,attempt,status,code]);
  await tx.query('UPDATE ai_attempts SET status=$3,lease_token=NULL,lease_until=NULL WHERE job_id=$1 AND attempt=$2',[id,attempt,status]);
  await tx.query('UPDATE budget_reservations SET status=$3 WHERE job_id=$1 AND attempt=$2',[id,attempt,status==='unknown'?'unknown':'settled']);
  await tx.query('UPDATE job_outbox SET finished_at=now() WHERE job_id=$1 AND attempt=$2 AND finished_at IS NULL',[id,attempt]);
}

async function lockedJob(tx,id,attempt){
  const {rows:[job]}=await tx.query('SELECT * FROM ai_jobs WHERE id=$1 FOR UPDATE',[id]);
  return job?.attempt===attempt&&active.includes(job.status)?job:null;
}

export async function recoverAnalysis(db){
  const {rows}=await db.query(
    `SELECT j.id,j.attempt FROM ai_jobs j JOIN ai_attempts a ON a.job_id=j.id AND a.attempt=j.attempt
     JOIN job_outbox o ON o.job_id=j.id AND o.attempt=j.attempt
     WHERE j.status IN ('queued','running') AND
       ((a.lease_until IS NOT NULL AND a.lease_until<=now()) OR
         (a.lease_until IS NULL AND GREATEST(o.finished_at,o.available_at)<=now()-interval '3 minutes')) LIMIT 8`,
  );
  for(const item of rows){
    await db.transaction(async tx=>{
      if(!await lockedJob(tx,item.id,item.attempt)) return;
      const {rows:[expired]}=await tx.query(
        `SELECT a.lease_token, EXISTS(SELECT 1 FROM ai_chunks c
           WHERE c.job_id=a.job_id AND c.attempt=a.attempt AND c.status='sending' AND NOT (COALESCE(c.provider_state,'{}'::jsonb) ? 'interactionId')) AS sending
         FROM ai_attempts a JOIN job_outbox o USING (job_id,attempt)
         WHERE a.job_id=$1 AND a.attempt=$2 AND ((a.lease_until<=now()) OR
           (a.lease_until IS NULL AND GREATEST(o.finished_at,o.available_at)<=now()-interval '3 minutes'))`,[item.id,item.attempt],
      );
      if(!expired) return;
      if(expired.sending) await finish(tx,item.id,item.attempt,'unknown','PROVIDER_OUTCOME_UNKNOWN');
      else{
        await tx.query("UPDATE ai_chunks SET status='pending' WHERE job_id=$1 AND attempt=$2 AND status='sending' AND provider_state ? 'interactionId'",[item.id,item.attempt]);
        await tx.query('UPDATE ai_attempts SET lease_token=NULL,lease_until=NULL WHERE job_id=$1 AND attempt=$2',[item.id,item.attempt]);
        await tx.query(`UPDATE job_outbox SET finished_at=NULL,lease_token=NULL,lease_until=NULL,available_at=now()
          WHERE job_id=$1 AND attempt=$2`,[item.id,item.attempt]);
      }
    });
  }
}

export async function processAnalysisStep(db,id,attempt,provider){
  const work=await db.transaction(async tx=>{
    const job=await lockedJob(tx,id,attempt);
    if(!job) return {done:true};
    const {rows:[state]}=await tx.query(
      'SELECT lease_until>now() AS leased FROM ai_attempts WHERE job_id=$1 AND attempt=$2',[id,attempt],
    );
    if(state.leased) return {done:true};
    const {rows:[chunk]}=await tx.query(
      `SELECT *, GREATEST(0,ceil(extract(epoch FROM next_at-now())))::integer AS delay
       FROM ai_chunks WHERE job_id=$1 AND attempt=$2 AND status<>'complete' ORDER BY position LIMIT 1`,[id,attempt],
    );
    if(!chunk){
      const {rows}=await tx.query('SELECT result FROM ai_chunks WHERE job_id=$1 AND attempt=$2 ORDER BY position',[id,attempt]);
      if(job.mode==='video'){
        const report=rows[0].result;
        if(report.editingQuality) await tx.query(`INSERT INTO prepublication_audits (job_id,attempt,media_revision_id,coverage,summary,editing_score,editing_rationale)
          VALUES ($1,$2,$3,$4::text::jsonb,$5,$6,$7)`,[id,attempt,job.media_revision_id,json(report.coverage),report.summary,
          report.editingQuality?.score??null,report.editingQuality.rationale]);
        else await tx.query(`INSERT INTO prepublication_audits (job_id,attempt,media_revision_id,coverage,summary)
          VALUES ($1,$2,$3,$4::text::jsonb,$5)`,[id,attempt,job.media_revision_id,json(report.coverage),report.summary]);
        for(const [position,finding] of report.findings.entries()){
          await tx.query('INSERT INTO audit_findings (job_id,attempt,position,finding) VALUES ($1,$2,$3,$4::text::jsonb)',
            [id,attempt,position,json(finding)]);
        }
      }else{
        const drafts=mergeDrafts(rows.flatMap(row=>row.result));
        for(const [position,draft] of drafts.entries()){
          await tx.query('INSERT INTO ai_claim_drafts (job_id,position,draft) VALUES ($1,$2,$3::text::jsonb)',[id,position,json(draft)]);
        }
      }
      await finish(tx,id,attempt,'succeeded',null);
      return {done:true};
    }
    if(chunk.status==='sending'&&!chunk.provider_state?.interactionId){
      await finish(tx,id,attempt,'unknown','PROVIDER_OUTCOME_UNKNOWN');
      return {done:true};
    }
    if(chunk.delay>0) return {delay:chunk.delay};
    const token=randomUUID();
    await tx.query("UPDATE ai_jobs SET status='running',updated_at=now() WHERE id=$1",[id]);
    await tx.query(`UPDATE ai_attempts SET status='running',lease_token=$3,lease_until=now()+interval '120 seconds'
      WHERE job_id=$1 AND attempt=$2`,[id,attempt,token]);
    await tx.query("UPDATE ai_chunks SET status='sending' WHERE job_id=$1 AND attempt=$2 AND position=$3",[id,attempt,chunk.position]);
    return {job,chunk,token};
  });
  if(!work.chunk) return work;
  const {job,chunk,token}=work;
  let outcome;
  try{outcome=await provider(job.model,chunk.input,{mode:job.mode,state:chunk.provider_state});}
  catch{outcome={type:'unknown',code:'PROVIDER_OUTCOME_UNKNOWN'};}
  return db.transaction(async tx=>{
    if(!await lockedJob(tx,id,attempt)) return {done:true};
    const {rows:[state]}=await tx.query('SELECT lease_token FROM ai_attempts WHERE job_id=$1 AND attempt=$2',[id,attempt]);
    if(state.lease_token!==token) return {done:true};
    if(outcome.usage){
      const cost=outcome.usage.input*chunk.input_rate+outcome.usage.output*chunk.output_rate;
      await tx.query('UPDATE budget_reservations SET spent_micros=spent_micros+$3 WHERE job_id=$1 AND attempt=$2',[id,attempt,cost]);
    }
    if(outcome.type==='waiting'){
      await tx.query(`UPDATE ai_chunks SET status='pending',provider_state=$4::text::jsonb,
        next_at=now()+$5::integer*interval '1 second' WHERE job_id=$1 AND attempt=$2 AND position=$3`,
        [id,attempt,chunk.position,json(outcome.state),outcome.delay]);
      await tx.query(`UPDATE job_outbox SET available_at=now()+$3::integer*interval '1 second'
        WHERE job_id=$1 AND attempt=$2`,[id,attempt,outcome.delay]);
      await tx.query('UPDATE ai_attempts SET lease_token=NULL,lease_until=NULL WHERE job_id=$1 AND attempt=$2',[id,attempt]);
      return {delay:outcome.delay};
    }
    if(outcome.type==='success'){
      await tx.query(`UPDATE ai_chunks SET status='complete',result=$4::text::jsonb,usage=$5::text::jsonb
        WHERE job_id=$1 AND attempt=$2 AND position=$3`,[id,attempt,chunk.position,json(outcome.drafts),json(outcome.usage)]);
    }else if(outcome.type==='transient'&&chunk.retries<transientLimit&&outcome.delay<=3600){
      const delay=Math.max(2**(chunk.retries+2),outcome.delay);
      await tx.query(`UPDATE ai_chunks SET status='pending',retries=retries+1,next_at=now()+$4::integer*interval '1 second'
        WHERE job_id=$1 AND attempt=$2 AND position=$3`,[id,attempt,chunk.position,delay]);
      await tx.query(`UPDATE job_outbox SET available_at=now()+$3::integer*interval '1 second'
        WHERE job_id=$1 AND attempt=$2`,[id,attempt,delay]);
      await tx.query('UPDATE ai_attempts SET lease_token=NULL,lease_until=NULL WHERE job_id=$1 AND attempt=$2',[id,attempt]);
      return {delay};
    }else{
      await finish(tx,id,attempt,outcome.type==='unknown'?'unknown':'failed',outcome.code);
      return {done:true};
    }
    await tx.query('UPDATE ai_attempts SET lease_token=NULL,lease_until=NULL WHERE job_id=$1 AND attempt=$2',[id,attempt]);
    return {delay:0};
  });
}

/** @param {{id?: string|null, videoId?: string|null}} selection */
export async function analysisStatus(db,identity,selection){
  const {id,videoId}=selection;
  const member=await activeMember(db,identity);
  if(!member) throw Error('FORBIDDEN');
  const where=id?'j.id=$1':'j.video_id=$1';
  const {rows}=await db.query(`SELECT j.id,j.video_id,j.transcript_id,j.mode,j.status,j.attempt,j.model,j.error_code,
    j.requested_by=$2 AS owned,j.created_at,j.updated_at,r.reserved_micros,r.spent_micros,r.status AS budget_status,
    (SELECT count(*)::integer FROM ai_chunks c WHERE c.job_id=j.id AND c.attempt=j.attempt AND c.status='complete') AS completed_chunks,
    (SELECT count(*)::integer FROM ai_chunks c WHERE c.job_id=j.id AND c.attempt=j.attempt) AS total_chunks,
    (SELECT (c.input->>'durationSec')::integer FROM ai_chunks c WHERE c.job_id=j.id AND c.attempt=j.attempt AND j.mode='youtube'
      ORDER BY c.position LIMIT 1) AS duration_sec
    FROM ai_jobs j JOIN budget_reservations r ON r.job_id=j.id AND r.attempt=j.attempt
    WHERE j.mode IN ('transcript','youtube') AND ${where} ORDER BY j.created_at DESC LIMIT 20`,[uuid(id??videoId),member.id]);
  if(!id) return rows;
  if(!rows.length) throw Error('NOT_FOUND');
  const {rows:drafts}=await db.query('SELECT position,draft,claim_id FROM ai_claim_drafts WHERE job_id=$1 ORDER BY position',[id]);
  return {...rows[0],drafts:drafts.map(row=>({...row.draft,position:row.position,claimId:row.claim_id}))};
}
