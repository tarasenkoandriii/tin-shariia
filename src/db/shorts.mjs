import {monthlyAnalysisBudget} from '../analysis/monthly-budget.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {activeMember} from '../access/membership.mjs';
import {uuid} from '../editorial/workflow-input.mjs';
import {validateShortsManifest} from '../media/shorts-manifest.mjs';
import {MAX_STORED_BYTES,STORAGE_DAYS} from '../media/montage-storage.mjs';
import {activeMontagePlan} from './montage-plans.mjs';

const json=value=>JSON.stringify(value);
const tiktokUrl=value=>{
  if(typeof value!=='string'||value.length>500)throw Error('TIKTOK_INVALID_URL');
  let url;try{url=new URL(value);}catch{throw Error('TIKTOK_INVALID_URL');}
  if(url.protocol!=='https:'||!['www.tiktok.com','tiktok.com'].includes(url.hostname)||url.username||url.password
    ||url.search||url.hash||!/^\/@[A-Za-z0-9._-]{2,24}\/video\/\d{10,30}\/?$/.test(url.pathname))throw Error('TIKTOK_INVALID_URL');
  return `https://www.tiktok.com${url.pathname.replace(/\/$/,'')}`;
};
const publishedTimestamp=value=>{
  if(typeof value!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.\d{3}Z$/.test(value))throw Error('INVALID_INPUT');
  const parsed=new Date(value);if(!Number.isFinite(+parsed)||parsed.toISOString()!==value||+parsed>Date.now()+60000)throw Error('INVALID_INPUT');
  return value;
};
async function memberFor(db,identity,author=false){
  if(!identity) throw Error('AUTH_REQUIRED');
  const member=await activeMember(db,identity);
  if(!member||author&&!member.roles.includes('author')) throw Error('FORBIDDEN');
  return member;
}

export async function initShortRender(db,identity,episodeId,input){
  episodeId=uuid(episodeId);
  const mediaId=uuid(input.mediaId);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036598)');
    const member=await memberFor(tx,identity,true);
    const {rows:[source]}=await tx.query(`SELECT m.*,e.status AS episode_status,e.version AS current_version,
      c.status AS claim_status,c.version AS current_claim_version,p.id AS publication
      FROM episode_media_revisions m JOIN episodes e ON e.id=m.episode_id JOIN claims c ON c.id=e.claim_id
      LEFT JOIN publications p ON p.episode_id=e.id WHERE m.id=$1 AND m.episode_id=$2 FOR SHARE OF m,e,c`,[mediaId,episodeId]);
    if(!source) throw Error('NOT_FOUND');
    if(source.state!=='passed'||!source.sha256||!source.report?.durationMs||new Date(source.expires_at)<=new Date()) throw Error('MEDIA_NOT_READY');
    if(source.episode_status!=='approved'||source.claim_status!=='approved'||source.episode_version!==source.current_version
      ||source.snapshot.claimVersion!==source.current_claim_version||source.publication) throw Error('MEDIA_STALE');
    const {rows:[preflight]}=await tx.query(`SELECT state FROM episode_grok_reviews WHERE episode_id=$1 AND episode_version=$2
      ORDER BY round DESC LIMIT 1`,[episodeId,source.current_version]);
    if(preflight?.state!=='accepted')throw Error('GROK_PREFLIGHT_REQUIRED');
    const plan=await activeMontagePlan(tx,identity,input.montagePlanId??null);
    if(plan.spec.format!=='9:16')throw Error('MONTAGE_PLAN_FORMAT_UNSUPPORTED');
    if(input.montagePlanVersion!==undefined&&input.montagePlanVersion!==plan.version)throw Error('REVISION_CONFLICT');
    const manifest=validateShortsManifest(input.manifest,source.report.durationMs);
    const key=createHash('sha256').update(json([member.id,episodeId,mediaId,source.sha256,manifest,plan.id,plan.version])).digest('hex');
    const {rows:[existing]}=await tx.query('SELECT * FROM shorts_renders WHERE idempotency_key=$1',[key]);
    if(existing) return existing;
    const {rows:[budget]}=await tx.query(`SELECT COALESCE((SELECT sum(expected_bytes) FROM episode_media_revisions
      WHERE expires_at>now() AND state<>'expired'),0)+COALESCE((SELECT sum(expected_bytes) FROM shorts_renders
      WHERE expires_at>now() AND state<>'expired'),0) AS used`);
    if(Number(budget.used)+128*1024*1024>MAX_STORED_BYTES) throw Error('MONTAGE_STORAGE_LIMIT');
    const id=randomUUID();
    const {rows:[row]}=await tx.query(`INSERT INTO shorts_renders
      (id,episode_id,media_revision_id,episode_version,created_by,idempotency_key,manifest,expected_bytes,expires_at,montage_plan_id,montage_plan_version)
      VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,now()+$9::integer*interval '1 day',$10,$11) RETURNING *`,
    [id,episodeId,mediaId,source.episode_version,member.id,key,json(manifest),128*1024*1024,STORAGE_DAYS,plan.id,plan.version]);
    return row;
  });
}

export async function reserveShortsProposal(db,identity,episodeId,input,config){
  episodeId=uuid(episodeId);
  const mediaId=uuid(input.mediaId),requestKey=uuid(input.requestId);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036593)');
    const member=await memberFor(tx,identity,true);
    const selectedPlan=await activeMontagePlan(tx,identity,input.montagePlanId??null);
    if(selectedPlan.spec.format!=='9:16')throw Error('MONTAGE_PLAN_FORMAT_UNSUPPORTED');
    if(input.montagePlanVersion!==undefined&&input.montagePlanVersion!==selectedPlan.version)throw Error('REVISION_CONFLICT');
    const {rows:[existing]}=await tx.query('SELECT id,state,plan,requested_by,episode_id,media_revision_id,montage_plan_id,montage_plan_version FROM shorts_plan_calls WHERE request_key=$1',[requestKey]);
    if(existing){
      if(existing.requested_by!==member.id||existing.episode_id!==episodeId||existing.media_revision_id!==mediaId)
        throw Error('INVALID_INPUT');
      if(existing.montage_plan_id!==selectedPlan.id||existing.montage_plan_version!==selectedPlan.version)throw Error('INVALID_INPUT');
      if(existing.state==='succeeded') return {cached:true,id:existing.id,plan:existing.plan};
      throw Error(existing.state==='unknown'?'SHORTS_PROPOSAL_UNKNOWN':'SHORTS_PROPOSAL_PENDING');
    }
    const {rows:[source]}=await tx.query(`SELECT m.id,m.snapshot,m.sha256,m.report,m.state,m.expires_at,
      e.version,e.status AS episode_status,c.status AS claim_status,c.version AS claim_version,cv.transcript_id
      FROM episode_media_revisions m JOIN episodes e ON e.id=m.episode_id JOIN claims c ON c.id=e.claim_id
      JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=m.episode_version
      JOIN claim_versions cv ON cv.claim_id=c.id AND cv.version=ev.claim_version
      LEFT JOIN publications p ON p.episode_id=e.id
      WHERE m.id=$1 AND m.episode_id=$2 AND p.id IS NULL FOR SHARE OF m,e,c`,[mediaId,episodeId]);
    if(!source) throw Error('NOT_FOUND');
    if(source.state!=='passed'||!source.report?.durationMs||new Date(source.expires_at)<=new Date()) throw Error('MEDIA_NOT_READY');
    if(source.episode_status!=='approved'||source.claim_status!=='approved'||source.snapshot.episodeVersion!==source.version
      ||source.snapshot.claimVersion!==source.claim_version) throw Error('MEDIA_STALE');
    const {rows:segments}=await tx.query(`SELECT position,start_ms,end_ms,body FROM transcript_segments
      WHERE transcript_id=$1 ORDER BY position LIMIT 5001`,[source.transcript_id]);
    if(!segments.length||segments.length>5000||segments.some(row=>row.start_ms===null||row.end_ms===null)) throw Error('TRANSCRIPT_REQUIRED');
    const transcript=segments.map(row=>({i:row.position,s:Number(row.start_ms),e:Number(row.end_ms),t:row.body}));
    const snapshot=source.snapshot;
    const context={durationMs:Number(source.report.durationMs),episode:snapshot.episode,claim:snapshot.claim,transcript,
      montagePlan:{id:selectedPlan.id,name:selectedPlan.name,version:selectedPlan.version,spec:selectedPlan.spec}};
    const serialized=JSON.stringify(context);
    if(Buffer.byteLength(serialized)>96_000) throw Error('TRANSCRIPT_TOO_LARGE');
    const reserve=Math.ceil(Buffer.byteLength(serialized)/3.5+1800)*config.inputRate+4096*config.outputRate;
    const budget=await monthlyAnalysisBudget(tx);
    if(Number(budget.used)+reserve>config.monthlyMicros) throw Error('BUDGET_EXHAUSTED');
    const {rows:[call]}=await tx.query(`INSERT INTO shorts_plan_calls
      (episode_id,media_revision_id,requested_by,request_key,month,model,reserved_micros,state,montage_plan_id,montage_plan_version)
      VALUES($1,$2,$3,$4,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$5,$6,'running',$7,$8) RETURNING id`,
    [episodeId,mediaId,member.id,requestKey,config.model,reserve,selectedPlan.id,selectedPlan.version]);
    return {cached:false,id:call.id,context,reserve};
  });
}

/** @param {{state:string,spent?:number,plan?:object|null}} values */
export async function settleShortsProposal(db,id,values){
  const {state,spent=0,plan=null}=values;
  await db.query(`UPDATE shorts_plan_calls SET state=$2,spent_micros=$3,plan=$4::text::jsonb
    WHERE id=$1 AND state='running'`,[uuid(id),state,spent,plan?json(plan):null]);
}

export async function getShortRender(db,identity,episodeId,id){
  await memberFor(db,identity);
  const {rows:[row]}=await db.query(`SELECT s.* FROM shorts_renders s WHERE s.id=$1 AND s.episode_id=$2
    AND s.expires_at>now()`,[uuid(id),uuid(episodeId)]);
  if(!row) throw Error('NOT_FOUND');
  return row;
}

export async function listShortRenders(db,identity,episodeId){
  await memberFor(db,identity);
  const {rows}=await db.query(`SELECT s.id,s.episode_id,s.media_revision_id,s.episode_version,s.manifest,s.state,s.expected_bytes,s.sha256,s.error_code,s.expires_at,s.created_at,
    s.montage_plan_id,s.montage_plan_version,
    s.audit_ffmpeg_id,s.technical_report,s.audit_media_revision_id,u.id AS youtube_upload_id,u.state AS youtube_upload_state,
    u.youtube_id AS youtube_video_id,u.privacy_status AS youtube_privacy_status,u.processing_status AS youtube_processing_status,
    u.actual_privacy_status AS youtube_actual_privacy_status,u.contains_synthetic_media AS youtube_ai_disclosed,
    u.actual_contains_synthetic_media AS youtube_actual_ai_disclosed,u.error_code AS youtube_error_code,u.upload_offset AS youtube_upload_offset,
    u.total_bytes AS youtube_total_bytes,
    (SELECT to_jsonb(s) FROM publication_youtube_stats s WHERE s.upload_id=u.id ORDER BY s.fetched_at DESC LIMIT 1) AS youtube_stats,
    (SELECT jsonb_build_object('id',t.id,'state',t.state,'tiktok_url',t.tiktok_url,'published_at',t.published_at,
      'ai_disclosed',t.ai_disclosed,'sha256',t.sha256,'title',t.title,'description',t.description,
      'error_note',t.error_note,'created_at',t.created_at)
      FROM tiktok_short_publications t WHERE t.short_id=s.id) AS tiktok_publication
    FROM shorts_renders s LEFT JOIN youtube_short_uploads u ON u.media_revision_id=s.audit_media_revision_id
    WHERE s.episode_id=$1 AND s.expires_at>now() ORDER BY s.created_at DESC LIMIT 12`,[uuid(episodeId)]);
  return rows;
}

async function publisherFor(db,identity){
  if(!identity)throw Error('AUTH_REQUIRED');
  const member=await activeMember(db,identity);if(!member?.roles.includes('publisher'))throw Error('FORBIDDEN');
  return member;
}

const tiktokReleaseSql=`SELECT s.id,s.episode_id,s.episode_version,s.manifest,s.sha256,s.pathname,LEAST(s.expires_at,m.expires_at) AS expires_at,m.id AS media_revision_id,
    m.sha256 AS media_sha256,m.pathname AS media_pathname,m.snapshot,e.version AS current_version,e.status AS episode_status,
    c.status AS claim_status,c.version AS current_claim_version,a.reviewed_at
    FROM shorts_renders s JOIN episode_media_revisions m ON m.id=s.audit_media_revision_id
    JOIN episodes e ON e.id=s.episode_id JOIN claims c ON c.id=e.claim_id
    JOIN LATERAL (SELECT x.reviewed_at,x.job_id,x.attempt FROM ai_jobs j
      JOIN prepublication_audits x ON x.job_id=j.id AND x.attempt=j.attempt
      WHERE j.media_revision_id=m.id AND j.mode='video' AND j.status='succeeded'
      ORDER BY x.completed_at DESC,j.created_at DESC,j.id DESC LIMIT 1) a ON true
    WHERE s.id=$1 AND s.episode_id=$2 AND s.state='ready' AND m.kind='short' AND m.state='passed'
      AND s.sha256=m.sha256 AND s.pathname=m.pathname AND m.expected_bytes>0 AND m.expires_at>now() AND s.expires_at>now()
      AND e.status='approved' AND e.version=s.episode_version AND c.status='approved'
      AND m.snapshot->>'claimVersion'=c.version::text AND a.reviewed_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM audit_findings f LEFT JOIN audit_finding_reviews r USING(job_id,attempt,position)
        WHERE f.job_id=a.job_id AND f.attempt=a.attempt AND r.job_id IS NULL)
    FOR SHARE OF s,m,e,c`;

export async function readTikTokPackageMedia(db, identity, episodeId, shortId) {
  episodeId = uuid(episodeId);
  shortId = uuid(shortId);
  return db.transaction(async tx => {
    await publisherFor(tx, identity);
    const {rows: [release]} = await tx.query(tiktokReleaseSql, [shortId, episodeId]);
    if (!release?.pathname || release.pathname !== release.media_pathname) throw Error('NOT_FOUND');

    const {rows: [publication]} = await tx.query(`SELECT sha256, media_revision_id
      FROM tiktok_short_publications
      WHERE short_id=$1 AND episode_id=$2 AND state='ready_to_publish'
      FOR SHARE`, [shortId, episodeId]);
    if (!publication || publication.sha256 !== release.sha256 ||
        publication.sha256 !== release.media_sha256 ||
        publication.media_revision_id !== release.media_revision_id) {
      throw Error('NOT_FOUND');
    }
    return {pathname: release.pathname, expires_at: release.expires_at, id: shortId};
  });
}

export async function prepareTikTokPublication(db,identity,episodeId,shortId,input){
  episodeId=uuid(episodeId);shortId=uuid(shortId);
  if(input.confirmed!==true||input.aiDisclosureConfirmed!==true||typeof input.reviewedSha256!=='string'||!/^([a-f0-9]{64})$/.test(input.reviewedSha256))throw Error('TIKTOK_CONFIRMATION_REQUIRED');
  return db.transaction(async tx=>{
    const member=await publisherFor(tx,identity);
    // Serialize the first package creation even when no publication row exists yet.
    const prepareReleaseSql = tiktokReleaseSql.replace('FOR SHARE OF s,m,e,c', 'FOR UPDATE OF s FOR SHARE OF m,e,c');
    const {rows:[release]}=await tx.query(prepareReleaseSql,[shortId,episodeId]);
    if(!release)throw Error('TIKTOK_RELEASE_APPROVAL_REQUIRED');
    if(input.reviewedSha256!==release.sha256)throw Error('TIKTOK_MEDIA_CONFIRMATION_REQUIRED');
    const {rows:[existing]}=await tx.query('SELECT * FROM tiktok_short_publications WHERE short_id=$1 FOR UPDATE',[shortId]);
    if(existing){
      if(existing.sha256!==release.sha256||existing.media_revision_id!==release.media_revision_id)throw Error('TIKTOK_MEDIA_CONFIRMATION_REQUIRED');
      if(existing.state==='published')return {...existing,deduplicated:true};
      if(existing.state==='ready_to_publish')return {...existing,deduplicated:true};
      const {rows:[updated]}=await tx.query(`UPDATE tiktok_short_publications SET state='ready_to_publish',error_note=NULL,
        updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *`,[existing.id,member.id]);
      await tx.query(`INSERT INTO tiktok_short_publication_events(publication_id,actor_id,action,details)
        VALUES($1,$2,'retry_prepared',$3::text::jsonb)`,[existing.id,member.id,json({sha256:release.sha256})]);
      return {...updated,deduplicated:false};
    }
    const {rows:[row]}=await tx.query(`INSERT INTO tiktok_short_publications
      (short_id,episode_id,episode_version,media_revision_id,sha256,title,description,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,[shortId,episodeId,release.episode_version,release.media_revision_id,
      release.sha256,release.manifest.title,release.manifest.description,member.id]);
    await tx.query(`INSERT INTO tiktok_short_publication_events(publication_id,actor_id,action,details)
      VALUES($1,$2,'prepared',$3::text::jsonb)`,[row.id,member.id,json({sha256:release.sha256,mediaRevisionId:release.media_revision_id,aiDisclosureConfirmed:true})]);
    return {...row,deduplicated:false};
  });
}

export async function registerTikTokPublication(db,identity,episodeId,shortId,input){
  episodeId=uuid(episodeId);shortId=uuid(shortId);
  const url=tiktokUrl(input.url),publishedAt=publishedTimestamp(input.publishedAt);
  if(input.confirmed!==true||input.aiDisclosureConfirmed!==true)throw Error('TIKTOK_DISCLOSURE_REQUIRED');
  return db.transaction(async tx=>{
    const member=await publisherFor(tx,identity);
    const {rows:[release]}=await tx.query(tiktokReleaseSql,[shortId,episodeId]);
    if(!release)throw Error('TIKTOK_RELEASE_APPROVAL_REQUIRED');
    const {rows:[row]}=await tx.query(`SELECT * FROM tiktok_short_publications WHERE short_id=$1 AND episode_id=$2 FOR UPDATE`,[shortId,episodeId]);
    if(!row)throw Error('TIKTOK_PACKAGE_REQUIRED');
    if(row.sha256!==release.sha256||row.media_revision_id!==release.media_revision_id)throw Error('TIKTOK_MEDIA_CONFIRMATION_REQUIRED');
    if(input.reviewedSha256!==row.sha256)throw Error('TIKTOK_MEDIA_CONFIRMATION_REQUIRED');
    if(row.state==='published'){
      if(row.tiktok_url===url&&new Date(row.published_at).toISOString()===publishedAt&&row.ai_disclosed===true)return {...row,deduplicated:true};
      throw Error('TIKTOK_PUBLICATION_CONFLICT');
    }
    if(row.state!=='ready_to_publish')throw Error('INVALID_TRANSITION');
    const {rows:[updated]}=await tx.query(`UPDATE tiktok_short_publications SET state='published',tiktok_url=$2,published_at=$3,
      ai_disclosed=true,error_note=NULL,updated_by=$4,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,url,publishedAt,member.id]);
    await tx.query(`INSERT INTO tiktok_short_publication_events(publication_id,actor_id,action,details)
      VALUES($1,$2,'published',$3::text::jsonb)`,[row.id,member.id,json({url,publishedAt,sha256:row.sha256,aiDisclosed:true})]);
    return {...updated,deduplicated:false};
  }).catch(error=>{
    if(error?.code==='23505'&&(error.constraint_name??error.constraint)==='tiktok_short_publications_url'){
      throw Error('TIKTOK_PUBLICATION_CONFLICT');
    }
    throw error;
  });
}

export async function failTikTokPublication(db,identity,episodeId,shortId,input){
  episodeId=uuid(episodeId);shortId=uuid(shortId);
  const note=typeof input.note==='string'?input.note.trim():'';
  if(!note||note.length>1000||input.confirmed!==true)throw Error('INVALID_INPUT');
  return db.transaction(async tx=>{
    const member=await publisherFor(tx,identity);
    const {rows:[existing]}=await tx.query(`SELECT * FROM tiktok_short_publications WHERE short_id=$1 AND episode_id=$2 FOR UPDATE`,[shortId,episodeId]);
    if(!existing)throw Error('TIKTOK_PACKAGE_REQUIRED');
    if(existing.state==='failed'&&existing.error_note===note)return {...existing,deduplicated:true};
    if(existing.state!=='ready_to_publish')throw Error('INVALID_TRANSITION');
    const {rows:[row]}=await tx.query(`UPDATE tiktok_short_publications SET state='failed',error_note=$2,updated_by=$3,updated_at=now()
      WHERE id=$1 RETURNING *`,[existing.id,note,member.id]);
    await tx.query(`INSERT INTO tiktok_short_publication_events(publication_id,actor_id,action,details)
      VALUES($1,$2,'failed',$3::text::jsonb)`,[row.id,member.id,json({note,sha256:row.sha256})]);
    return row;
  });
}

export async function updateShortRender(db,id,token,values){
  const {rows:[row]}=await db.query(`UPDATE shorts_renders SET state=$3,ffmpeg_id=COALESCE($4,ffmpeg_id),
    audit_ffmpeg_id=COALESCE($5,audit_ffmpeg_id),pathname=COALESCE($6,pathname),expected_bytes=COALESCE($7,expected_bytes),
    sha256=COALESCE($8,sha256),technical_report=COALESCE($9::text::jsonb,technical_report),
    audit_media_revision_id=COALESCE($10,audit_media_revision_id),error_code=$11,run_lease=$12
    WHERE id=$1 AND run_token=$2 RETURNING id`,
  [id,token,values.state,values.ffmpegId??null,values.auditFfmpegId??null,values.pathname??null,values.bytes??null,
    values.sha256??null,values.technicalReport?json(values.technicalReport):null,values.auditMediaRevisionId??null,
    values.errorCode??null,values.lease??null]);
  return Boolean(row);
}

export async function createShortAuditMedia(db,id,token,technicalReport){
  return db.transaction(async tx=>{
    const {rows:[short]}=await tx.query(`SELECT s.*,m.snapshot AS source_snapshot,e.status AS episode_status,e.version AS current_version,
      c.status AS claim_status,c.version AS current_claim_version
      FROM shorts_renders s JOIN episode_media_revisions m ON m.id=s.media_revision_id
      JOIN episodes e ON e.id=s.episode_id JOIN claims c ON c.id=e.claim_id
      WHERE s.id=$1 AND s.run_token=$2 AND s.state='technical_check' AND s.run_lease>now()
      FOR UPDATE OF s,m,e,c`,[uuid(id),uuid(token)]);
    if(!short) return null;
    if(short.audit_media_revision_id) return short.audit_media_revision_id;
    if(short.episode_status!=='approved'||short.claim_status!=='approved'||short.episode_version!==short.current_version
      ||short.source_snapshot.claimVersion!==short.current_claim_version) throw Error('MEDIA_STALE');
    const snapshot={...short.source_snapshot,short:{hook:short.manifest.hook,title:short.manifest.title,
      description:short.manifest.description,durationMs:short.manifest.durationMs,clips:short.manifest.clips}};
    const {rows:[media]}=await tx.query(`INSERT INTO episode_media_revisions
      (episode_id,episode_version,uploaded_by,ordinal,pathname,expected_bytes,upload_until,expires_at,snapshot,state,sha256,report,kind)
      SELECT $1,$2,$3,COALESCE(MAX(ordinal),0)+1,$4,$5,now(),$6,$7::text::jsonb,'passed',$8,$9::text::jsonb,'short'
      FROM episode_media_revisions WHERE episode_id=$1 RETURNING id`,
    [short.episode_id,short.episode_version,short.created_by,short.pathname,short.expected_bytes,short.expires_at,json(snapshot),
      short.sha256,json(technicalReport)]);
    return media.id;
  });
}
