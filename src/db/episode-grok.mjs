import {randomUUID} from 'node:crypto';
import {activeMember} from '../access/membership.mjs';
import {uuid} from '../editorial/workflow-input.mjs';
import {packageFor} from './publications.mjs';

const json=value=>JSON.stringify(value),RESERVE_MICROS=50_000,MONTHLY_CAP_MICROS=5_000_000;
async function allowed(db,identity){
  if(!identity)throw Error('AUTH_REQUIRED');
  const member=await activeMember(db,identity);
  if(!member||!member.roles.some(role=>['author','editor','publisher'].includes(role)))throw Error('FORBIDDEN');
  return member;
}

export async function queueEpisodeGrokReview(db,identity,episodeId){
  episodeId=uuid(episodeId);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036599)');
    await allowed(tx,identity);
    const {rows:[episode]}=await tx.query(`SELECT e.*,c.status AS claim_status,c.version AS claim_version,v.id AS video_id
      FROM episodes e JOIN claims c ON c.id=e.claim_id JOIN videos v ON v.id=c.video_id WHERE e.id=$1 FOR UPDATE OF e,c`,[episodeId]);
    if(!episode)throw Error('NOT_FOUND');
    if(episode.status!=='approved'||episode.claim_status!=='approved')throw Error('APPROVAL_REQUIRED');
    const {rows:[existing]}=await tx.query(`SELECT id FROM episode_grok_reviews WHERE episode_id=$1 AND episode_version=$2
      AND state IN ('queued','submitting','submitted','unknown') LIMIT 1`,[episode.id,episode.version]);
    if(existing)throw Error('GROK_REVIEW_PENDING');
    const {rows:[budget]}=await tx.query(`SELECT
      (SELECT COALESCE(sum(reserved_micros),0) FROM episode_grok_reviews
        WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+
      (SELECT COALESCE(sum(reserved_micros),0) FROM youtube_short_comments
        WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS used`);
    if(Number(budget.used)+RESERVE_MICROS>MONTHLY_CAP_MICROS)throw Error('GROK_MONTHLY_LIMIT');
    const pkg=await packageFor(tx,episode,episode.version);
    const {rows:history}=await tx.query(`WITH historical AS (
      SELECT p.youtube_id,p.published_at,ev.content,latest.views,latest.likes,latest.comments
      FROM publications p JOIN episode_versions ev ON ev.episode_id=p.episode_id AND ev.version=p.episode_version
      LEFT JOIN LATERAL(SELECT views,likes,comments FROM publication_youtube_stats s WHERE s.publication_id=p.id
        ORDER BY fetched_at DESC LIMIT 1) latest ON true WHERE p.episode_id<>$1
      UNION ALL
      SELECT u.youtube_id,u.created_at,ev.content,latest.views,latest.likes,latest.comments
      FROM youtube_short_uploads u JOIN episode_media_revisions m ON m.id=u.media_revision_id
      JOIN episode_versions ev ON ev.episode_id=u.episode_id AND ev.version=m.episode_version
      LEFT JOIN LATERAL(SELECT views,likes,comments FROM publication_youtube_stats s WHERE s.upload_id=u.id
        ORDER BY fetched_at DESC LIMIT 1) latest ON true WHERE u.state='published' AND u.episode_id<>$1
    ) SELECT youtube_id,published_at,content,views,likes,comments FROM historical ORDER BY published_at DESC LIMIT 10`,[episodeId]);
    const snapshot={videoId:episode.video_id,episodeId:episode.id,version:episode.version,
      draft:pkg.episode,claim:pkg.claim,sources:pkg.sources,priorChannelPerformance:history.map(row=>({
        publishedAt:row.published_at,title:row.content?.title??'',script:row.content?.script??'',
        views:row.views===null?null:Number(row.views),likes:row.likes===null?null:Number(row.likes),
        comments:row.comments===null?null:Number(row.comments),
      }))};
    const serialized=json(snapshot);
    if(Buffer.byteLength(serialized)>48_000)throw Error('GROK_REVIEW_INPUT_TOO_LARGE');
    const {rows:[previous]}=await tx.query(`SELECT COALESCE(max(round),0)::integer AS round FROM episode_grok_reviews
      WHERE episode_id=$1 AND episode_version=$2`,[episode.id,episode.version]);
    const {rows:[settings]}=await tx.query('SELECT grok_mode FROM editorial_ai_settings WHERE id=1');
    const mode=settings?.grok_mode==='batch'?'batch':'direct';
    const {rows:[review]}=await tx.query(`INSERT INTO episode_grok_reviews
      (episode_id,episode_version,round,batch_request_id,input_snapshot,reserved_micros,mode)
      VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7) RETURNING id,episode_id,episode_version,round,state,mode,created_at`,
    [episode.id,episode.version,previous.round+1,randomUUID(),serialized,RESERVE_MICROS,mode]);
    return review;
  });
}

export async function listEpisodeGrokReviews(db,identity,episodeId){
  await allowed(db,identity);
  const {rows}=await db.query(`SELECT id,episode_id,episode_version,round,state,result,error_code,
    accepted_by,accepted_at,auto_accepted,auto_accept_threshold,mode,created_at,completed_at,reserved_micros FROM episode_grok_reviews
    WHERE episode_id=$1 ORDER BY episode_version DESC,round DESC LIMIT 20`,[uuid(episodeId)]);
  return rows;
}

export async function listEpisodeGrokReviewsForEpisodes(db,identity,episodeIds){
  await allowed(db,identity);
  if(!episodeIds.length)return [];
  const {rows}=await db.query(`SELECT id,episode_id,episode_version,round,state,result,error_code,
    accepted_by,accepted_at,auto_accepted,auto_accept_threshold,mode,created_at,completed_at,reserved_micros
    FROM episode_grok_reviews WHERE episode_id=ANY($1::uuid[]) ORDER BY episode_id,episode_version DESC,round DESC`,[episodeIds]);
  return rows;
}

export const GROK_MODES=['direct','batch'];

export async function readGrokSettings(db,identity){
  const member=await activeMember(db,identity);
  if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
  const {rows:[row]}=await db.query('SELECT auto_accept_score,grok_mode FROM editorial_ai_settings WHERE id=1');
  return {autoAcceptScore:row?.auto_accept_score??80,grokMode:row?.grok_mode==='batch'?'batch':'direct'};
}

export async function readGrokAutoAcceptScore(db,identity){
  return (await readGrokSettings(db,identity)).autoAcceptScore;
}

// Either field may be omitted; every change is journaled with old and new values.
export async function updateGrokSettings(db,identity,{autoAcceptScore,grokMode}={}){
  return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
    if(autoAcceptScore===undefined&&grokMode===undefined)throw Error('INVALID_INPUT');
    if(autoAcceptScore!==undefined&&(!Number.isSafeInteger(autoAcceptScore)||autoAcceptScore<0||autoAcceptScore>100))throw Error('INVALID_INPUT');
    if(grokMode!==undefined&&!GROK_MODES.includes(grokMode))throw Error('INVALID_INPUT');
    const {rows:[before]}=await tx.query('SELECT auto_accept_score,grok_mode FROM editorial_ai_settings WHERE id=1 FOR UPDATE');
    const {rows:[row]}=await tx.query(`UPDATE editorial_ai_settings SET auto_accept_score=$1,grok_mode=$2,updated_by=$3,updated_at=now()
      WHERE id=1 RETURNING auto_accept_score,grok_mode`,
    [autoAcceptScore??before.auto_accept_score,grokMode??before.grok_mode,member.id]);
    await tx.query(`INSERT INTO editorial_ai_setting_events(actor_id,old_auto_accept_score,new_auto_accept_score,old_grok_mode,new_grok_mode)
      VALUES($1,$2,$3,$4,$5)`,[member.id,before.auto_accept_score,row.auto_accept_score,before.grok_mode,row.grok_mode]);
    return {autoAcceptScore:row.auto_accept_score,grokMode:row.grok_mode};
  });
}

export async function updateGrokAutoAcceptScore(db,identity,value){
  if(value===undefined)throw Error('INVALID_INPUT');
  return (await updateGrokSettings(db,identity,{autoAcceptScore:value})).autoAcceptScore;
}

export async function acceptEpisodeGrokReview(db,identity,episodeId,reviewId,version){
  return db.transaction(async tx=>{
    const member=await allowed(tx,identity);
    if(!Number.isSafeInteger(version)||version<1)throw Error('INVALID_INPUT');
    if(!member.roles.includes('editor'))throw Error('FORBIDDEN');
    const {rows:[row]}=await tx.query(`UPDATE episode_grok_reviews r SET state='accepted',accepted_by=$4,accepted_at=now(),updated_at=now()
      FROM episodes e WHERE r.id=$1 AND r.episode_id=$2 AND e.id=r.episode_id AND e.version=$3
        AND r.episode_version=$3 AND r.state='succeeded'
      RETURNING r.id,r.episode_id,r.episode_version,r.round,r.state,r.accepted_at`,[uuid(reviewId),uuid(episodeId),version,member.id]);
    if(!row)throw Error('GROK_REVIEW_NOT_READY');
    return row;
  });
}

export async function claimGrokReviewBatch(db){
  await db.query(`UPDATE episode_grok_reviews SET state='unknown',error_code='GROK_SUBMISSION_OUTCOME_UNKNOWN',updated_at=now()
    WHERE state='submitting' AND mode='batch' AND updated_at<now()-interval '15 minutes'`);
  return db.transaction(async tx=>{
    const {rows}=await tx.query(`SELECT id,batch_request_id,input_snapshot FROM episode_grok_reviews
      WHERE state='queued' AND mode='batch' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 10`);
    for(const row of rows)await tx.query(`UPDATE episode_grok_reviews SET state='submitting',attempt=attempt+1,updated_at=now() WHERE id=$1`,[row.id]);
    return rows;
  });
}

export async function saveGrokReviewSubmission(db,ids,batchId,errorCode=null,unknown=false){
  if(!ids.length)return;
  await db.query(`UPDATE episode_grok_reviews SET state=$2,batch_id=$3,error_code=$4,
    reserved_micros=CASE WHEN $5 AND NOT $6 THEN 0 ELSE reserved_micros END,
    submitted_at=CASE WHEN $2='submitted' THEN now() ELSE submitted_at END,updated_at=now()
    WHERE id=ANY($1::uuid[])`,[ids,unknown?'unknown':errorCode?'failed':'submitted',batchId,errorCode,Boolean(errorCode&&!unknown),unknown]);
}

function parseGrokResult(text){
  const result=JSON.parse(text??'');
  if(!Number.isInteger(result.originalityScore)||result.originalityScore<0||result.originalityScore>100
    ||!Number.isInteger(result.interestScore)||result.interestScore<0||result.interestScore>100
    ||typeof result.summary!=='string'||result.summary.length>2500
    ||!Array.isArray(result.factRisks)||result.factRisks.length>12
    ||!Array.isArray(result.recommendations)||result.recommendations.length>8
    ||result.recommendations.some(item=>typeof item?.change!=='string'||typeof item?.reason!=='string'))throw Error();
  return result;
}

// Stores one finished review (both modes). The auto-accept rule is identical for direct and batch.
async function storeGrokReviewResult(db,id,text,fromState){
  let result=null;
  try{result=parseGrokResult(text);}catch{
    await db.query(`UPDATE episode_grok_reviews SET state='failed',result=NULL,error_code='GROK_RESULT_INVALID',completed_at=now(),updated_at=now()
      WHERE id=$1 AND state=$2`,[id,fromState]);
    return 'failed';
  }
  const {rows:[settings]}=await db.query('SELECT auto_accept_score FROM editorial_ai_settings WHERE id=1');
  const threshold=Number(settings?.auto_accept_score??80);
  const autoAccepted=result.originalityScore>=threshold&&result.interestScore>=threshold&&result.factRisks.length===0;
  await db.query(`UPDATE episode_grok_reviews SET state=$2,result=$3::text::jsonb,error_code=NULL,completed_at=now(),updated_at=now(),
    auto_accepted=$4::boolean,auto_accept_threshold=CASE WHEN $4::boolean THEN $5::smallint ELSE NULL END,
    accepted_at=CASE WHEN $4::boolean THEN now() ELSE NULL END WHERE id=$1 AND state=$6`,[id,autoAccepted?'accepted':'succeeded',json(result),autoAccepted,threshold,fromState]);
  return autoAccepted?'accepted':'succeeded';
}

export async function completeGrokReviewBatch(db,batchId,results){
  const {rows}=await db.query(`SELECT id,batch_request_id FROM episode_grok_reviews WHERE batch_id=$1 AND state='submitted'`,[batchId]);
  for(const row of rows)await storeGrokReviewResult(db,row.id,results[row.batch_request_id],'submitted');
  return rows.length;
}

// Direct mode: atomically take queued reviews (one by id right after the click, or the oldest ones from cron).
export async function claimDirectGrokReviews(db,{id=null,limit=3}={}){
  await db.query(`UPDATE episode_grok_reviews SET state='failed',error_code='GROK_DIRECT_INTERRUPTED',completed_at=now(),updated_at=now()
    WHERE state='submitting' AND mode='direct' AND updated_at<now()-interval '5 minutes'`);
  const {rows}=await db.query(`UPDATE episode_grok_reviews SET state='submitting',attempt=attempt+1,submitted_at=now(),updated_at=now()
    WHERE id IN (SELECT id FROM episode_grok_reviews WHERE state='queued' AND mode='direct' AND ($1::uuid IS NULL OR id=$1::uuid)
      ORDER BY created_at,id LIMIT $2::integer FOR UPDATE SKIP LOCKED) AND state='queued'
    RETURNING id,input_snapshot`,[id,limit]);
  return rows;
}

export async function completeDirectGrokReview(db,id,text){
  return storeGrokReviewResult(db,id,text,'submitting');
}

// When xAI certainly did not bill, the reserve is released; an uncertain outcome keeps it in the monthly cap.
export async function failDirectGrokReview(db,id,errorCode,outcomeUnknown=false){
  await db.query(`UPDATE episode_grok_reviews SET state='failed',error_code=$2,completed_at=now(),updated_at=now(),
    reserved_micros=CASE WHEN $3::boolean THEN reserved_micros ELSE 0 END WHERE id=$1 AND state='submitting'`,[id,errorCode,outcomeUnknown]);
}
