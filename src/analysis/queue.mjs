import { createHash, randomUUID } from 'node:crypto';
import { activeMember } from '../access/membership.mjs';
import { uuid } from '../editorial/workflow-input.mjs';
import { makePrompt, mergeDrafts, outputLimit, promptVersion, splitTranscript } from './input.mjs';

const attemptsLimit=3;
const transientLimit=2;
const active=['queued','running'];
const json = value=>JSON.stringify(value);

export async function enqueueAnalysis(db, identity, videoId, input, config) {
  videoId=uuid(videoId);
  const transcriptId=uuid(input.transcriptId);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036593)');
    const member=await activeMember(tx,identity);
    if (!member?.roles.includes('author')) throw Error('FORBIDDEN');
    const {rows:[transcript]}=await tx.query(
      'SELECT content_hash FROM transcripts WHERE id=$1 AND video_id=$2',[transcriptId,videoId],
    );
    if (!transcript) throw Error('NOT_FOUND');
    const fingerprint=createHash('sha256').update(json([videoId,'transcript',transcriptId,transcript.content_hash,
      config.model,promptVersion])).digest('hex');
    const {rows:[existing]}=await tx.query('SELECT * FROM ai_jobs WHERE dedupe_key=$1 FOR UPDATE',[fingerprint]);
    if (input.retry===true) {
      if (!existing||existing.requested_by!==member.id) throw Error('FORBIDDEN');
      if (input.expectedAttempt!==existing.attempt) throw Error('ATTEMPT_CONFLICT');
      if (!['failed','unknown'].includes(existing.status)||existing.attempt>=attemptsLimit) throw Error('RETRY_NOT_AVAILABLE');
      if (existing.status==='unknown'&&input.acknowledgeUnknown!==true) throw Error('ACKNOWLEDGMENT_REQUIRED');
    } else if (existing) {
      return { id:existing.id, status:existing.status, attempt:existing.attempt, deduplicated:true };
    }
    const {rows:[counts]}=await tx.query(
      `SELECT count(*)::integer AS total, count(*) FILTER (WHERE requested_by=$1)::integer AS actor
       FROM ai_jobs WHERE status IN ('queued','running')`,[member.id],
    );
    if (counts.total>=2||counts.actor>=1) throw Error('CONCURRENCY_LIMIT');
    const {rows}=await tx.query(
      `SELECT position,start_ms,end_ms,body FROM transcript_segments
       WHERE transcript_id=$1 ORDER BY position LIMIT 12001`,[transcriptId],
    );
    if(rows.length>12000) throw Error('TRANSCRIPT_TOO_LARGE');
    const chunks=splitTranscript(rows);
    const reserve=chunks.reduce((sum,chunk)=>sum+(Buffer.byteLength(makePrompt(chunk))+1024)*config.inputRate
      + outputLimit*config.outputRate,0);
    const {rows:[budget]}=await tx.query(
      `SELECT date_trunc('month',now() AT TIME ZONE 'UTC')::date AS month,
       COALESCE(sum(CASE WHEN status='settled' THEN spent_micros ELSE GREATEST(reserved_micros,spent_micros) END),0) AS used
       FROM budget_reservations WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date`,
    );
    if (Number(budget.used)+reserve>config.monthlyMicros) throw Error('BUDGET_EXHAUSTED');
    const attempt=existing?existing.attempt+1:1;
    let id=existing?.id;
    if(existing){
      await tx.query("UPDATE ai_jobs SET attempt=$2,status='queued',error_code=NULL,updated_at=now() WHERE id=$1",[id,attempt]);
    }else{
      const {rows:[created]}=await tx.query(
        `INSERT INTO ai_jobs (video_id,transcript_id,requested_by,dedupe_key,model,prompt_version,status)
         VALUES ($1,$2,$3,$4,$5,$6,'queued') RETURNING id`,
        [videoId,transcriptId,member.id,fingerprint,config.model,promptVersion],
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
           WHERE c.job_id=a.job_id AND c.attempt=a.attempt AND c.status='sending') AS sending
         FROM ai_attempts a JOIN job_outbox o USING (job_id,attempt)
         WHERE a.job_id=$1 AND a.attempt=$2 AND ((a.lease_until<=now()) OR
           (a.lease_until IS NULL AND GREATEST(o.finished_at,o.available_at)<=now()-interval '3 minutes'))`,[item.id,item.attempt],
      );
      if(!expired) return;
      if(expired.sending) await finish(tx,item.id,item.attempt,'unknown','PROVIDER_OUTCOME_UNKNOWN');
      else{
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
      const drafts=mergeDrafts(rows.flatMap(row=>row.result));
      for(const [position,draft] of drafts.entries()){
        await tx.query('INSERT INTO ai_claim_drafts (job_id,position,draft) VALUES ($1,$2,$3::text::jsonb)',[id,position,json(draft)]);
      }
      await finish(tx,id,attempt,'succeeded',null);
      return {done:true};
    }
    if(chunk.status==='sending'){
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
  try{outcome=await provider(job.model,chunk.input);}
  catch{outcome={type:'unknown',code:'PROVIDER_OUTCOME_UNKNOWN'};}
  return db.transaction(async tx=>{
    if(!await lockedJob(tx,id,attempt)) return {done:true};
    const {rows:[state]}=await tx.query('SELECT lease_token FROM ai_attempts WHERE job_id=$1 AND attempt=$2',[id,attempt]);
    if(state.lease_token!==token) return {done:true};
    if(outcome.usage){
      const cost=outcome.usage.input*chunk.input_rate+outcome.usage.output*chunk.output_rate;
      await tx.query('UPDATE budget_reservations SET spent_micros=spent_micros+$3 WHERE job_id=$1 AND attempt=$2',[id,attempt,cost]);
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
  const {rows}=await db.query(`SELECT j.id,j.video_id,j.transcript_id,j.status,j.attempt,j.model,j.error_code,
    j.requested_by=$2 AS owned,j.created_at,j.updated_at,r.reserved_micros,r.spent_micros,r.status AS budget_status,
    (SELECT count(*)::integer FROM ai_chunks c WHERE c.job_id=j.id AND c.attempt=j.attempt AND c.status='complete') AS completed_chunks,
    (SELECT count(*)::integer FROM ai_chunks c WHERE c.job_id=j.id AND c.attempt=j.attempt) AS total_chunks
    FROM ai_jobs j JOIN budget_reservations r ON r.job_id=j.id AND r.attempt=j.attempt
    WHERE ${where} ORDER BY j.created_at DESC LIMIT 20`,[uuid(id??videoId),member.id]);
  if(!id) return rows;
  if(!rows.length) throw Error('NOT_FOUND');
  const {rows:drafts}=await db.query('SELECT position,draft FROM ai_claim_drafts WHERE job_id=$1 ORDER BY position',[id]);
  return {...rows[0],drafts:drafts.map(row=>row.draft)};
}
