import {createHash,randomUUID} from 'node:crypto';
import {activeMember} from '../access/membership.mjs';
import {uuid} from '../editorial/workflow-input.mjs';
import {validateShortsManifest} from '../media/shorts-manifest.mjs';
import {MAX_STORED_BYTES,STORAGE_DAYS} from '../media/montage-storage.mjs';

const json=value=>JSON.stringify(value);
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
    const manifest=validateShortsManifest(input.manifest,source.report.durationMs);
    const key=createHash('sha256').update(json([member.id,episodeId,mediaId,source.sha256,manifest])).digest('hex');
    const {rows:[existing]}=await tx.query('SELECT * FROM shorts_renders WHERE idempotency_key=$1',[key]);
    if(existing) return existing;
    const {rows:[budget]}=await tx.query(`SELECT COALESCE((SELECT sum(expected_bytes) FROM episode_media_revisions
      WHERE expires_at>now() AND state<>'expired'),0)+COALESCE((SELECT sum(expected_bytes) FROM shorts_renders
      WHERE expires_at>now() AND state NOT IN ('failed','expired')),0) AS used`);
    if(Number(budget.used)+128*1024*1024>MAX_STORED_BYTES) throw Error('MONTAGE_STORAGE_LIMIT');
    const id=randomUUID();
    const {rows:[row]}=await tx.query(`INSERT INTO shorts_renders
      (id,episode_id,media_revision_id,episode_version,created_by,idempotency_key,manifest,expected_bytes,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,now()+$9::integer*interval '1 day') RETURNING *`,
    [id,episodeId,mediaId,source.episode_version,member.id,key,json(manifest),128*1024*1024,STORAGE_DAYS]);
    return row;
  });
}

export async function reserveShortsProposal(db,identity,episodeId,input,config){
  episodeId=uuid(episodeId);
  const mediaId=uuid(input.mediaId),requestKey=uuid(input.requestId);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036600)');
    const member=await memberFor(tx,identity,true);
    const {rows:[existing]}=await tx.query('SELECT id,state,plan FROM shorts_plan_calls WHERE request_key=$1',[requestKey]);
    if(existing){
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
    const context={durationMs:Number(source.report.durationMs),episode:snapshot.episode,claim:snapshot.claim,transcript};
    const serialized=JSON.stringify(context);
    if(Buffer.byteLength(serialized)>96_000) throw Error('TRANSCRIPT_TOO_LARGE');
    const reserve=Math.ceil(Buffer.byteLength(serialized)/3.5+1800)*config.inputRate+4096*config.outputRate;
    const {rows:[budget]}=await tx.query(`SELECT
      COALESCE((SELECT sum(CASE WHEN status='settled' THEN spent_micros ELSE GREATEST(reserved_micros,spent_micros) END)
        FROM budget_reservations WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date),0)
      +COALESCE((SELECT sum(CASE WHEN state='succeeded' THEN spent_micros ELSE reserved_micros END)
        FROM shorts_plan_calls WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date AND state IN ('running','succeeded','unknown')),0) AS used`);
    if(Number(budget.used)+reserve>config.monthlyMicros) throw Error('BUDGET_EXHAUSTED');
    const {rows:[call]}=await tx.query(`INSERT INTO shorts_plan_calls
      (episode_id,media_revision_id,requested_by,request_key,month,model,reserved_micros,state)
      VALUES($1,$2,$3,$4,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$5,$6,'running') RETURNING id`,
    [episodeId,mediaId,member.id,requestKey,config.model,reserve]);
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
  const {rows}=await db.query(`SELECT id,episode_id,media_revision_id,episode_version,manifest,state,expected_bytes,sha256,error_code,expires_at,created_at
    FROM shorts_renders WHERE episode_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 12`,[uuid(episodeId)]);
  return rows;
}

export async function updateShortRender(db,id,token,values){
  const {rows:[row]}=await db.query(`UPDATE shorts_renders SET state=$3,ffmpeg_id=COALESCE($4,ffmpeg_id),
    pathname=COALESCE($5,pathname),expected_bytes=COALESCE($6,expected_bytes),sha256=COALESCE($7,sha256),error_code=$8,
    run_lease=$9 WHERE id=$1 AND run_token=$2 RETURNING id`,
  [id,token,values.state,values.ffmpegId??null,values.pathname??null,values.bytes??null,values.sha256??null,
    values.errorCode??null,values.lease??null]);
  return Boolean(row);
}
