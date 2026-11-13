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
    const {rows:[review]}=await tx.query(`INSERT INTO episode_grok_reviews
      (episode_id,episode_version,round,batch_request_id,input_snapshot,reserved_micros)
      VALUES($1,$2,$3,$4,$5::text::jsonb,$6) RETURNING id,episode_id,episode_version,round,state,created_at`,
    [episode.id,episode.version,previous.round+1,randomUUID(),serialized,RESERVE_MICROS]);
    return review;
  });
}

export async function listEpisodeGrokReviews(db,identity,episodeId){
  await allowed(db,identity);
  const {rows}=await db.query(`SELECT id,episode_id,episode_version,round,state,result,error_code,
    accepted_by,accepted_at,auto_accepted,auto_accept_threshold,created_at,completed_at,reserved_micros FROM episode_grok_reviews
    WHERE episode_id=$1 ORDER BY episode_version DESC,round DESC LIMIT 20`,[uuid(episodeId)]);
  return rows;
}

export async function listEpisodeGrokReviewsForEpisodes(db,identity,episodeIds){
  await allowed(db,identity);
  if(!episodeIds.length)return [];
  const {rows}=await db.query(`SELECT id,episode_id,episode_version,round,state,result,error_code,
    accepted_by,accepted_at,auto_accepted,auto_accept_threshold,created_at,completed_at,reserved_micros
    FROM episode_grok_reviews WHERE episode_id=ANY($1::uuid[]) ORDER BY episode_id,episode_version DESC,round DESC`,[episodeIds]);
  return rows;
}

export async function readGrokAutoAcceptScore(db,identity){
  const member=await activeMember(db,identity);
  if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
  const {rows:[row]}=await db.query('SELECT auto_accept_score FROM editorial_ai_settings WHERE id=1');
  return row?.auto_accept_score??80;
}

export async function updateGrokAutoAcceptScore(db,identity,value){
  return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
    if(!Number.isSafeInteger(value)||value<0||value>100)throw Error('INVALID_INPUT');
    const {rows:[before]}=await tx.query('SELECT auto_accept_score FROM editorial_ai_settings WHERE id=1 FOR UPDATE');
    const {rows:[row]}=await tx.query(`UPDATE editorial_ai_settings SET auto_accept_score=$1,updated_by=$2,updated_at=now()
      WHERE id=1 RETURNING auto_accept_score`,[value,member.id]);
    await tx.query(`INSERT INTO editorial_ai_setting_events(actor_id,old_auto_accept_score,new_auto_accept_score)
      VALUES($1,$2,$3)`,[member.id,before.auto_accept_score,row.auto_accept_score]);
    return row.auto_accept_score;
  });
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
    WHERE state='submitting' AND updated_at<now()-interval '15 minutes'`);
  return db.transaction(async tx=>{
    const {rows}=await tx.query(`SELECT id,batch_request_id,input_snapshot FROM episode_grok_reviews
      WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 10`);
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

export async function completeGrokReviewBatch(db,batchId,results){
  const {rows}=await db.query(`SELECT id,batch_request_id FROM episode_grok_reviews WHERE batch_id=$1 AND state='submitted'`,[batchId]);
  for(const row of rows){
    let result=null,errorCode=null;
    try{
      result=JSON.parse(results[row.batch_request_id]??'');
      if(!Number.isInteger(result.originalityScore)||result.originalityScore<0||result.originalityScore>100
        ||!Number.isInteger(result.interestScore)||result.interestScore<0||result.interestScore>100
        ||typeof result.summary!=='string'||result.summary.length>2500
        ||!Array.isArray(result.factRisks)||result.factRisks.length>12
        ||!Array.isArray(result.recommendations)||result.recommendations.length>8
        ||result.recommendations.some(item=>typeof item?.change!=='string'||typeof item?.reason!=='string'))throw Error();
    }catch{errorCode='GROK_RESULT_INVALID';}
    if(!errorCode){
      const {rows:[settings]}=await db.query('SELECT auto_accept_score FROM editorial_ai_settings WHERE id=1');
      const threshold=Number(settings?.auto_accept_score??80);
      const autoAccepted=result.originalityScore>=threshold&&result.interestScore>=threshold&&result.factRisks.length===0;
      await db.query(`UPDATE episode_grok_reviews SET state=$2,result=$3::text::jsonb,error_code=NULL,completed_at=now(),updated_at=now(),
        auto_accepted=$4,auto_accept_threshold=CASE WHEN $4 THEN $5 ELSE NULL END,accepted_at=CASE WHEN $4 THEN now() ELSE NULL END
        WHERE id=$1 AND state='submitted'`,[row.id,autoAccepted?'accepted':'succeeded',json(result),autoAccepted,threshold]);
    }else await db.query(`UPDATE episode_grok_reviews SET state='failed',result=NULL,error_code=$2,completed_at=now(),updated_at=now()
      WHERE id=$1 AND state='submitted'`,[row.id,errorCode]);
  }
  return rows.length;
}
