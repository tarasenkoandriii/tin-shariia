import {createCommentShortLink,verifyCommentShortLink} from '../youtube/comment-short-link.mjs';
import {verifyYouTubeCommentTarget} from '../youtube/comment-target.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {activeMember} from '../access/membership.mjs';
import {uuid} from '../editorial/workflow-input.mjs';

const RESERVE_MICROS=50_000,MONTHLY_CAP_MICROS=5_000_000;
const json=value=>JSON.stringify(value);
const COMMENT_SCOPE='https://www.googleapis.com/auth/youtube.force-ssl';

const recoverableFailures=['YOUTUBE_COMMENT_AUTH_FAILED','YOUTUBE_OAUTH_NOT_CONFIGURED',
  'YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED','YOUTUBE_TOKEN_INVALID','YOUTUBE_TOKEN_REFRESH_FAILED',
  'YOUTUBE_TOKEN_REFRESH_REVOKED','YOUTUBE_TOKEN_REFRESH_CLIENT','YOUTUBE_COMMENT_APPROVAL_CHANGED',
  'YOUTUBE_COMMENT_SCOPE_REQUIRED','YOUTUBE_COMMENT_TARGET_UNVERIFIED','YOUTUBE_COMMENT_WRONG_TARGET_CHANNEL',
  'YOUTUBE_COMMENT_SHORT_NOT_PUBLIC'];

async function memberFor(db,identity){
  if(!identity)throw Error('AUTH_REQUIRED');
  const member=await activeMember(db,identity);
  if(!member||!member.roles.some(role=>['admin','author','editor','publisher'].includes(role)))throw Error('FORBIDDEN');
  return member;
}

function origin(){
  const value=process.env.APP_ORIGIN;
  let url;try{url=new URL(value);}catch{throw Error('APP_ORIGIN_INVALID');}
  if(url.protocol!=='https:'||url.origin!==value)throw Error('APP_ORIGIN_INVALID');
  return url.origin;
}

export async function loadYouTubeCommentDashboard(db,identity){
  await memberFor(db,identity);
  const [{rows:[settings]},{rows:[connection]},{rows:comments},{rows:chart},{rows:[clickTotals]}]=await Promise.all([
    db.query('SELECT enabled,interval_hours,updated_at FROM youtube_comment_settings WHERE id=1'),
    db.query(`SELECT channel_title,channel_id,scopes FROM youtube_connections WHERE disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1`),
    db.query(`SELECT c.id,c.episode_id,c.target_kind,c.approved_channel_id,c.parent_video_id,c.short_video_id,c.tracking_token,c.state,c.draft_text,c.final_text,
      (SELECT row_to_json(step) FROM (SELECT phase,plain_verified_at,linked_verified_at,checked_at,error_code
        FROM youtube_comment_steps WHERE comment_id=c.id) step) AS publication_steps,
      c.scheduled_at,c.published_at,c.youtube_comment_id,c.error_code,c.created_at,
      (c.state='failed' AND c.published_at IS NULL AND c.youtube_thread_id IS NULL AND c.youtube_comment_id IS NULL
        AND c.error_code=ANY($1::text[])) AS can_recover,
      COALESCE((c.input_snapshot->>'verificationPending')::boolean,false) AS verification_pending,
      c.input_snapshot->>'parentTitle' AS episode_title,
      c.input_snapshot->>'preparedShortLink' AS prepared_short_link,
      (SELECT count(*)::integer FROM youtube_short_comment_clicks x WHERE x.comment_id=c.id) AS click_count
      FROM youtube_short_comments c
      ORDER BY COALESCE(c.published_at,c.scheduled_at,c.created_at) DESC LIMIT 100`,[recoverableFailures]),
    db.query(`SELECT date_trunc('hour',clicked_at) AS hour,count(*)::integer AS clicks
      FROM youtube_short_comment_clicks WHERE clicked_at>=now()-interval '7 days'
      GROUP BY 1 ORDER BY 1`),
    db.query('SELECT count(*)::integer AS total_clicks FROM youtube_short_comment_clicks'),
  ]);
  const result=await db.query(`SELECT c.id,c.parent_video_id,c.published_at,c.short_video_id,count(x.id)::integer AS clicks
    FROM youtube_short_comments c LEFT JOIN youtube_short_comment_clicks x ON x.comment_id=c.id
    WHERE c.state='published' AND c.published_at>=now()-interval '7 days'
    GROUP BY c.id ORDER BY c.published_at`);
  return {settings:settings??{enabled:false,interval_hours:3},
    connection:connection?{channelTitle:connection.channel_title,channelId:connection.channel_id,commentScope:connection.scopes.includes(COMMENT_SCOPE)}:null,
    comments:comments.map(row=>({...row,click_count:Number(row.click_count)})),
    chart:chart.map(row=>({hour:row.hour,clicks:Number(row.clicks)})),
    totalClicks:Number(clickTotals.total_clicks),
    chartEnd:new Date().toISOString(),
    publishedMarkers:result.rows.map(row=>({id:row.id,parentVideoId:row.parent_video_id,publishedAt:row.published_at,shortVideoId:row.short_video_id,clicks:Number(row.clicks)})),
    candidates:(await db.query(`SELECT u.id,u.kind,u.title,u.youtube_id AS short_video_id,v.youtube_id AS source_video_id
      FROM youtube_comment_candidates u JOIN episodes e ON e.id=u.episode_id JOIN claims c ON c.id=e.claim_id
      JOIN videos v ON v.id=c.video_id
      ORDER BY u.updated_at DESC LIMIT 100`)).rows,
    shortLinkOrigin:origin()};
}

export async function updateYouTubeCommentSettings(db,identity,{enabled,intervalHours,confirmed}){
  return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
    if(typeof enabled!=='boolean'||!Number.isSafeInteger(intervalHours)||intervalHours<3||intervalHours>168)throw Error('INVALID_INPUT');
    if(enabled&&confirmed!==true)throw Error('YOUTUBE_COMMENT_CONSENT_REQUIRED');
    if(enabled){const {rows:[connection]}=await tx.query('SELECT scopes FROM youtube_connections WHERE disconnected_at IS NULL LIMIT 1');
      if(!connection?.scopes?.includes(COMMENT_SCOPE))throw Error('YOUTUBE_COMMENT_SCOPE_REQUIRED');}
    const {rows:[row]}=await tx.query(`UPDATE youtube_comment_settings SET enabled=$1,interval_hours=$2,updated_by=$3,updated_at=now()
      WHERE id=1 RETURNING enabled,interval_hours,updated_at`,[enabled,intervalHours,member.id]);
    return row;
  });
}


export async function prepareYouTubeCommentShortLink(db,identity,id,googleLink){
  const member=await activeMember(db,identity);
  if(!member?.roles.includes('editor'))throw Error('FORBIDDEN');
  const {rows:[row]}=await db.query("SELECT tracking_token,state,input_snapshot FROM youtube_short_comments WHERE id=$1",[uuid(id)]);
  if(!row||row.state!=='succeeded')throw Error('YOUTUBE_COMMENT_NOT_READY');
  const link=new URL('/go/short/'+encodeURIComponent(row.tracking_token),origin()).toString();
  const saved=row.input_snapshot?.preparedShortLink;
  if(saved&&!googleLink){
    try{return {url:await verifyCommentShortLink(saved,link),provider:new URL(saved).hostname};}catch{/* Regenerate a broken saved link. */}
  }
  const result=await createCommentShortLink(link,{googleLink});
  const updated=await db.query(`UPDATE youtube_short_comments SET input_snapshot=jsonb_set(input_snapshot,
    '{preparedShortLink}',to_jsonb($2::text)),updated_at=now() WHERE id=$1 AND state='succeeded' RETURNING id`,[uuid(id),result.url]);
  if(!updated.rows.length)throw Error('YOUTUBE_COMMENT_NOT_READY');
  return result;
}

export async function approveYouTubeComment(db,identity,id,input,verify=verifyYouTubeCommentTarget){
  return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('editor'))throw Error('FORBIDDEN');
    const {rows:[settings]}=await tx.query('SELECT enabled,interval_hours FROM youtube_comment_settings WHERE id=1 FOR UPDATE');
    if(!settings?.enabled && input.publishNow!==true)throw Error('YOUTUBE_COMMENT_SCHEDULE_DISABLED');
    const {rows:[connection]}=await tx.query('SELECT scopes,channel_id FROM youtube_connections WHERE disconnected_at IS NULL LIMIT 1');
    if(!connection?.scopes?.includes(COMMENT_SCOPE))throw Error('YOUTUBE_COMMENT_SCOPE_REQUIRED');
    const {rows:[row]}=await tx.query(`SELECT c.*, (SELECT v.youtube_id FROM episodes e JOIN claims cl ON cl.id=e.claim_id JOIN videos v ON v.id=cl.video_id WHERE e.id=c.episode_id) AS source_video_id FROM youtube_short_comments c WHERE c.id=$1 FOR UPDATE OF c`,[uuid(id)]);
    if(!row||row.state!=='succeeded')throw Error('YOUTUBE_COMMENT_NOT_READY');
    const link=new URL('/go/short/'+encodeURIComponent(row.tracking_token),origin()).toString();
    const text=commentText(input.text);
    if(input.targetVideoId!==row.parent_video_id||input.channelId!==connection.channel_id||input.link!==link)
      throw Error('YOUTUBE_COMMENT_APPROVAL_CHANGED');
    await verify({...row,...connection});
    const staged=row.target_kind==='source';
    if(staged&&!input.shortLink)throw Error('YOUTUBE_COMMENT_SHORT_LINK_REQUIRED');
    const publicLink=input.shortLink?await verifyCommentShortLink(input.shortLink,link):link;
    const finalText=text+'\n\n'+publicLink;
    if(finalText.length>2000)throw Error('YOUTUBE_COMMENT_TEXT_TOO_LONG');
    const {rows:[last]}=await tx.query(`SELECT COALESCE(max(COALESCE(published_at,scheduled_at)),now()) AS last_at
      FROM youtube_short_comments WHERE state IN ('scheduled','publishing','published')`);
    const {rows:[scheduled]}=await tx.query(`UPDATE youtube_short_comments SET state='scheduled',final_text=$2,
      scheduled_at=CASE WHEN $7 THEN now() ELSE GREATEST(now(),$3::timestamptz+($4::text||' hours')::interval) END,
      input_snapshot=jsonb_set(input_snapshot,'{publishNow}',to_jsonb($7::boolean)),approved_by=$5,approved_channel_id=$6,approved_at=now(),updated_at=now()
      WHERE id=$1 AND state='succeeded' RETURNING id,state,scheduled_at,final_text`,[row.id,finalText,last.last_at,settings.interval_hours,member.id,connection.channel_id,input.publishNow===true]);
    if(!scheduled)throw Error('YOUTUBE_COMMENT_NOT_READY');
    if(staged) await tx.query(`INSERT INTO youtube_comment_steps(comment_id,phase,plain_text,linked_text)
      VALUES($1,'waiting_plain',$2,$3)
      ON CONFLICT(comment_id) DO UPDATE SET phase='waiting_plain',plain_text=$2,linked_text=$3,
      lease=NULL,lease_until=NULL,plain_verified_at=NULL,linked_verified_at=NULL,checked_at=NULL,error_code=NULL`,
      [row.id,text,finalText]);
    await tx.query(`INSERT INTO youtube_short_comment_events(comment_id,actor_id,action,details) VALUES($1,$2,'approved',$3::text::jsonb)`,
      [row.id,member.id,json({scheduledAt:scheduled.scheduled_at,intervalHours:settings.interval_hours})]);
    return scheduled;
  });
}

export async function recoverYouTubeComment(db,identity,id){
  return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('editor')) throw Error('FORBIDDEN');
    const {rows:[row]}=await tx.query(`UPDATE youtube_short_comments SET state='succeeded',
      draft_text=COALESCE(regexp_replace(final_text,E'\\n\\nhttps://[^[:space:]]+$',''),draft_text),
      final_text=NULL,approved_by=NULL,approved_at=NULL,approved_channel_id=NULL,
      scheduled_at=NULL,completed_at=NULL,lease_until=NULL,error_code=NULL,updated_at=now(),
      input_snapshot=input_snapshot-'publishNow'-'verificationPending'
      WHERE id=$1 AND state='failed' AND published_at IS NULL AND youtube_thread_id IS NULL
        AND youtube_comment_id IS NULL AND error_code=ANY($2::text[])
      RETURNING id,state`,[uuid(id),recoverableFailures]);
    if(!row) throw Error('YOUTUBE_COMMENT_NOT_READY');
    return row;
  });
}

export async function rejectYouTubeComment(db,identity,id){
  return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('editor'))throw Error('FORBIDDEN');
    const {rows:[row]}=await tx.query(`UPDATE youtube_short_comments SET state='rejected',updated_at=now(),completed_at=now()
      WHERE id=$1 AND state='succeeded' RETURNING id`,[uuid(id)]);
    if(!row)throw Error('YOUTUBE_COMMENT_NOT_READY');
    await tx.query(`INSERT INTO youtube_short_comment_events(comment_id,actor_id,action) VALUES($1,$2,'rejected')`,[row.id,member.id]);
    return {id:row.id,state:'rejected'};
  });
}

export async function queueYouTubeCommentDrafts(db,{autoGenerate=true}={}){
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036599)');
    await tx.query(`UPDATE youtube_short_comments SET state='succeeded',error_code='GROK_COMMENT_DRAFT_INTERRUPTED',
      updated_at=now() WHERE state='submitting' AND batch_id IS NULL AND updated_at<now()-interval '10 minutes'`);
    const {rows:queued}=await tx.query(`SELECT id,batch_request_id,input_snapshot FROM youtube_short_comments
      WHERE state='queued' AND NOT (input_snapshot @> '{"verificationPending":true}'::jsonb)
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if(queued.length){
      await tx.query("UPDATE youtube_short_comments SET state='submitting',attempt=attempt+1,updated_at=now() WHERE id=$1",[queued[0].id]);
      return queued;
    }
    const {rows:[settings]}=await tx.query('SELECT enabled FROM youtube_comment_settings WHERE id=1');
    if(!settings?.enabled||!autoGenerate)return [];
    const {rows:[pending]}=await tx.query(`SELECT id FROM youtube_short_comments
      WHERE state IN ('queued','submitting','submitted','succeeded','scheduled','publishing','unknown') LIMIT 1`);
    if(pending)return [];
    const {rows:[budget]}=await tx.query(`SELECT
      (SELECT COALESCE(sum(reserved_micros),0) FROM episode_grok_reviews WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+
      (SELECT COALESCE(sum(reserved_micros),0) FROM youtube_short_comments WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS used`);
    const slots=Math.max(0,Math.min(3,Math.floor((MONTHLY_CAP_MICROS-Number(budget.used))/RESERVE_MICROS)));
    if(!slots)return [];
    const {rows:candidates}=await tx.query(`SELECT u.id AS upload_id,u.episode_id,u.youtube_id AS short_video_id,u.title AS short_title,
      p.id AS publication_id,p.youtube_id AS parent_video_id,p.published_at AS main_published_at,ev.content AS episode,cv.content AS claim
      FROM youtube_short_uploads u JOIN publications p ON p.episode_id=u.episode_id
      JOIN episode_media_revisions m ON m.id=u.media_revision_id
      JOIN episode_versions ev ON ev.episode_id=u.episode_id AND ev.version=m.episode_version
      JOIN claim_versions cv ON cv.claim_id=ev.claim_id AND cv.version=ev.claim_version
      JOIN episodes e ON e.id=u.episode_id JOIN claims c ON c.id=e.claim_id
      JOIN youtube_connections active ON active.disconnected_at IS NULL AND active.scopes @> ARRAY[$1]::text[]
      WHERE u.state='published' AND u.actual_privacy_status='public' AND u.youtube_id IS NOT NULL AND p.youtube_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM publication_youtube_stats s WHERE s.publication_id=p.id AND s.channel_id=active.channel_id AND s.error_code IS NULL)
        AND EXISTS(SELECT 1 FROM publication_youtube_stats s WHERE s.upload_id=u.id AND s.channel_id=active.channel_id AND s.error_code IS NULL)
        AND NOT EXISTS(SELECT 1 FROM youtube_short_comments x WHERE (x.upload_id=u.id AND x.target_kind='main') OR (x.parent_video_id=p.youtube_id AND x.short_video_id=u.youtube_id))
      ORDER BY u.updated_at LIMIT 1 FOR UPDATE OF u SKIP LOCKED`,[COMMENT_SCOPE]);
    for(const row of candidates){
      const requestId=randomUUID(),trackingToken=randomBytes(24).toString('base64url');
      const input={parentVideoId:row.parent_video_id,parentTitle:row.episode?.title??'',shortVideoId:row.short_video_id,
        shortTitle:row.short_title,script:row.episode?.script??'',claim:row.claim,mainPublishedAt:row.main_published_at};
      await tx.query(`INSERT INTO youtube_short_comments(episode_id,publication_id,upload_id,parent_video_id,short_video_id,
        tracking_token,batch_request_id,input_snapshot,reserved_micros)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9)`,
        [row.episode_id,row.publication_id,row.upload_id,row.parent_video_id,row.short_video_id,trackingToken,requestId,json(input),RESERVE_MICROS]);
    }
    const {rows:jobs}=await tx.query(`SELECT id,batch_request_id,input_snapshot FROM youtube_short_comments WHERE state='queued'
      AND NOT (input_snapshot @> '{"verificationPending":true}'::jsonb)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10`);
    for(const job of jobs)await tx.query(`UPDATE youtube_short_comments SET state='submitting',attempt=attempt+1,updated_at=now() WHERE id=$1`,[job.id]);
    return jobs;
  });
}

export async function completeYouTubeCommentDraftBatch(db,batchId,results){
  const {rows}=await db.query(`SELECT id,batch_request_id FROM youtube_short_comments WHERE batch_id=$1 AND state='submitted'`,[batchId]);
  for(const row of rows){
    let text=null,errorCode=null;
    try{const result=JSON.parse(results[row.batch_request_id]??'');text=typeof result.comment==='string'?result.comment.trim():null;
      if(!text||text.length>1200||/https?:\/\//i.test(text))throw Error();}
    catch{errorCode='GROK_COMMENT_RESULT_INVALID';}
    if(errorCode)await db.query(`UPDATE youtube_short_comments SET state='failed',error_code=$2,completed_at=now(),updated_at=now() WHERE id=$1`,[row.id,errorCode]);
    else{
      await db.query(`UPDATE youtube_short_comments SET state='succeeded',draft_text=$2,error_code=NULL,completed_at=now(),updated_at=now() WHERE id=$1`,[row.id,text]);
      await db.query(`INSERT INTO youtube_short_comment_events(comment_id,action) VALUES($1,'drafted')`,[row.id]);
    }
  }
  return rows.length;
}

export async function claimScheduledYouTubeComment(db){
  return db.transaction(async tx=>{
    await tx.query(`UPDATE youtube_short_comments SET state='unknown',error_code='YOUTUBE_COMMENT_OUTCOME_UNKNOWN',updated_at=now()
      WHERE state='publishing' AND lease_until<now()`);
    const {rows:[settings]}=await tx.query('SELECT enabled,interval_hours FROM youtube_comment_settings WHERE id=1 FOR UPDATE');
    if(!settings)return null;
    const {rows:[recent]}=await tx.query(`SELECT id FROM youtube_short_comments
      WHERE state IN ('publishing','unknown') AND approved_at IS NOT NULL
        OR state='published' AND published_at>now()-($1::text||' hours')::interval LIMIT 1`,[settings.interval_hours]);
    if(recent)return null;
    const {rows:[row]}=await tx.query(`SELECT c.id,c.final_text,(SELECT plain_text FROM youtube_comment_steps WHERE comment_id=c.id) AS plain_text,c.parent_video_id,c.short_video_id,c.tracking_token,c.target_kind,c.approved_channel_id,
      (SELECT v.youtube_id FROM episodes e JOIN claims cl ON cl.id=e.claim_id JOIN videos v ON v.id=cl.video_id WHERE e.id=c.episode_id) AS source_video_id, y.channel_title,y.channel_id,y.scopes,y.refresh_token_encrypted
      FROM youtube_short_comments c LEFT JOIN youtube_connections y ON y.disconnected_at IS NULL
      WHERE c.state='scheduled' AND c.scheduled_at<=now()
        AND ($1 OR c.input_snapshot @> '{"publishNow":true}'::jsonb)
      ORDER BY c.scheduled_at,c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1`,[settings.enabled]);
    if(!row)return null;
    await tx.query(`UPDATE youtube_short_comments SET state='publishing',lease_until=now()+interval '10 minutes',updated_at=now() WHERE id=$1`,[row.id]);
    return row;
  });
}

export async function recordYouTubeCommentPublished(db,id,{threadId,commentId,publishedAt}){
  const {rows:[row]}=await db.query(`UPDATE youtube_short_comments SET state='published',youtube_thread_id=$2,youtube_comment_id=$3,
    published_at=$4::timestamptz,lease_until=NULL,error_code=NULL,updated_at=now() WHERE id=$1 AND state='publishing' RETURNING id`,
    [uuid(id),threadId,commentId,publishedAt]);
  if(row)await db.query(`INSERT INTO youtube_short_comment_events(comment_id,action,details) VALUES($1,'published',$2::text::jsonb)`,
    [row.id,json({publishedAt})]);
}

export async function recordYouTubeCommentFailure(db,id,code,{unknown=false}={}){
  const state=unknown?'unknown':'failed';
  const {rows:[row]}=await db.query(`UPDATE youtube_short_comments SET state=$2,error_code=$3,lease_until=NULL,updated_at=now(),completed_at=now()
    WHERE id=$1 AND state='publishing' RETURNING id`,[uuid(id),state,code]);
  if(row)await db.query(`INSERT INTO youtube_short_comment_events(comment_id,action,details) VALUES($1,$2,$3::text::jsonb)`,
    [row.id,unknown?'unknown':'failed',json({errorCode:code})]);
}

export async function recordYouTubeShortCommentClick(db,token){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,64}$/.test(token))return null;
  const {rows:[row]}=await db.query(`SELECT id,short_video_id,state FROM youtube_short_comments WHERE tracking_token=$1 AND state IN ('succeeded','published')`,[token]);
  if(!row)return null;
  if(row.state==='published')await db.query('INSERT INTO youtube_short_comment_clicks(comment_id) VALUES($1)',[row.id]);
  return `https://www.youtube.com/shorts/${encodeURIComponent(row.short_video_id)}`;
}

function commentText(value){
  const text=typeof value==='string'?value.trim():'';
  if(!text||text.length>1200||/https?:\/\//i.test(text)) throw Error('YOUTUBE_COMMENT_TEXT_INVALID');
  return text;
}

export async function createYouTubeCommentDraft(db,identity,{uploadId,publicationId,targetKind,text,generate},verify=verifyYouTubeCommentTarget){
  if(!['main','source'].includes(targetKind)) throw Error('INVALID_INPUT');
  if(Boolean(uploadId)===Boolean(publicationId)||typeof generate!=='boolean')throw Error('INVALID_INPUT');
  if(publicationId&&targetKind!=='source')throw Error('YOUTUBE_COMMENT_MAIN_EPISODE_REQUIRED');
  const candidateId=uuid(uploadId??publicationId),kind=publicationId?'publication':'upload';
  return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('editor')) throw Error('FORBIDDEN');
    await tx.query('SELECT pg_advisory_xact_lock(72036599)');
    const {rows:[row]}=await tx.query(`SELECT u.upload_id,u.episode_id,u.youtube_id AS short_video_id,
      u.title AS short_title,COALESCE(u.registered_publication_id,p.id) AS publication_id,
      CASE WHEN $2='source' THEN v.youtube_id ELSE p.youtube_id END AS parent_video_id,
      y.channel_id,y.scopes,ev.content AS episode,cv.content AS claim
      FROM youtube_comment_candidates u JOIN episodes e ON e.id=u.episode_id JOIN claims c ON c.id=e.claim_id
      JOIN videos v ON v.id=c.video_id JOIN episode_media_revisions m ON m.id=u.media_revision_id
      JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=m.episode_version
      JOIN claim_versions cv ON cv.claim_id=ev.claim_id AND cv.version=ev.claim_version
      LEFT JOIN publications p ON p.episode_id=e.id AND $2='main'
      LEFT JOIN youtube_connections y ON y.disconnected_at IS NULL
      WHERE u.id=$1 AND u.kind=$3
      ORDER BY p.published_at DESC,p.id DESC LIMIT 1`,[candidateId,targetKind,kind]);
    if(!row?.parent_video_id) throw Error('YOUTUBE_COMMENT_TARGET_UNVERIFIED');
    // Studio publications are checked by the server-side dispatcher, where provider keys live.
    // They remain unapprovable until that read-only YouTube API check completes.
    if(!publicationId)await verify({...row,source_video_id:row.parent_video_id,target_kind:targetKind});
    const {rows:[existing]}=await tx.query('SELECT id FROM youtube_short_comments WHERE parent_video_id=$1 AND short_video_id=$2',
      [row.parent_video_id,row.short_video_id]);
    if(existing) return existing;
    if(generate){
      const {rows:[budget]}=await tx.query(`SELECT
        (SELECT COALESCE(sum(reserved_micros),0) FROM episode_grok_reviews WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+
        (SELECT COALESCE(sum(reserved_micros),0) FROM youtube_short_comments WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS used`);
      if(Number(budget.used)+RESERVE_MICROS>MONTHLY_CAP_MICROS) throw Error('BUDGET_EXHAUSTED');
    }
    const input={parentVideoId:row.parent_video_id,parentTitle:row.episode?.title??'',shortVideoId:row.short_video_id,
      shortTitle:row.short_title,script:row.episode?.script??'',claim:row.claim,targetKind,
      ...(publicationId?{verificationPending:true,generateDraft:generate}:{})};
    const {rows:[draft]}=await tx.query(`INSERT INTO youtube_short_comments(episode_id,publication_id,upload_id,parent_video_id,
      short_video_id,target_kind,tracking_token,batch_request_id,input_snapshot,reserved_micros,state,draft_text)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb,$10,$11,$12) RETURNING id`,
      [row.episode_id,row.publication_id,row.upload_id,row.parent_video_id,row.short_video_id,targetKind,
        randomBytes(24).toString('base64url'),randomUUID(),json(input),generate?RESERVE_MICROS:0,
        generate||publicationId?'queued':'succeeded',generate?null:commentText(text)]);
    return draft;
  });
}

export async function verifyPendingYouTubeCommentDrafts(db,verify=verifyYouTubeCommentTarget){
  return db.transaction(async tx=>{
    const {rows:[row]}=await tx.query(`SELECT c.*, (SELECT v.youtube_id FROM episodes e JOIN claims cl ON cl.id=e.claim_id JOIN videos v ON v.id=cl.video_id WHERE e.id=c.episode_id) AS source_video_id, y.channel_id,y.scopes FROM youtube_short_comments c
      LEFT JOIN youtube_connections y ON y.disconnected_at IS NULL
      WHERE c.state='queued' AND c.input_snapshot @> '{"verificationPending":true}'::jsonb
      ORDER BY c.created_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED`);
    if(!row)return {verified:0};
    try{await verify(row);}
    catch(error){
      const code=/^YOUTUBE_COMMENT_[A-Z_]+$/.test(error?.message)?error.message:'YOUTUBE_COMMENT_TARGET_UNVERIFIED';
      await tx.query(`UPDATE youtube_short_comments SET state='failed',error_code=$2,updated_at=now() WHERE id=$1`,[row.id,code]);
      return {verified:0,verificationFailed:1};
    }
    await tx.query(`UPDATE youtube_short_comments SET state=$2,
      input_snapshot=input_snapshot-'verificationPending',error_code=NULL,updated_at=now() WHERE id=$1`,
      [row.id,row.input_snapshot.generateDraft?'queued':'succeeded']);
    return {verified:1};
  });
}

export async function completeYouTubeCommentDirect(db,id,result){
  let text=null,error=result.error??null;
  if(!error) try{text=commentText(JSON.parse(result.text).comment);}catch{error='GROK_COMMENT_RESULT_INVALID';}
  // A failed draft can still be edited manually. Keep its reservation when a request may have been billed.
  await db.query(`UPDATE youtube_short_comments SET state='succeeded',draft_text=$2,error_code=$3,
    completed_at=now(),updated_at=now() WHERE id=$1 AND state='submitting'`,[id,text,error]);
}
