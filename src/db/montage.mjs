import {randomUUID} from 'node:crypto';
import {activeMember} from '../access/membership.mjs';
import {uuid} from '../editorial/workflow-input.mjs';
import {packageFor} from './publications.mjs';
import {MAX_MEDIA_BYTES,MAX_STORED_BYTES,STORAGE_DAYS,UPLOAD_MINUTES} from '../media/montage-storage.mjs';

async function memberFor(db,identity,role){
  if(!identity) throw Error('AUTH_REQUIRED');
  const member=await activeMember(db,identity);
  if(!member||(role&&!member.roles.includes(role))) throw Error('FORBIDDEN');
  return member;
}

export async function initMontage(db,identity,episodeId,input){
  episodeId=uuid(episodeId);
  if(!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>MAX_MEDIA_BYTES) throw Error('MONTAGE_SIZE_INVALID');
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036596)');
    const member=await memberFor(tx,identity,'author');
    const {rows:[episode]}=await tx.query('SELECT * FROM episodes WHERE id=$1 FOR UPDATE',[episodeId]);
    if(!episode) throw Error('NOT_FOUND');
    const {rows:published}=await tx.query('SELECT id FROM publications WHERE episode_id=$1',[episodeId]);
    if(published.length) throw Error('EPISODE_PUBLISHED');
    const snapshot=await packageFor(tx,episode,input.version);
    const {rows:[previous]}=await tx.query(`SELECT * FROM episode_media_revisions WHERE episode_id=$1
      AND uploaded_by=$2 AND state='uploading' AND upload_until>now() ORDER BY ordinal DESC LIMIT 1`,[episodeId,member.id]);
    if(previous){
      if(previous.episode_version===input.version&&previous.expected_bytes===input.bytes) return previous;
      throw Error('MONTAGE_UPLOAD_PENDING');
    }
    const {rows:[budget]}=await tx.query(`SELECT COALESCE(sum(expected_bytes),0) AS used FROM episode_media_revisions
      WHERE expires_at>now() AND state<>'expired'`);
    if(Number(budget.used)+input.bytes>MAX_STORED_BYTES) throw Error('MONTAGE_STORAGE_LIMIT');
    const id=randomUUID();
    const pathname='montage/'+episodeId+'/'+id+'.mp4';
    const {rows:[created]}=await tx.query(`INSERT INTO episode_media_revisions
      (id,episode_id,episode_version,uploaded_by,ordinal,pathname,expected_bytes,upload_until,expires_at,snapshot)
      SELECT $1,$2,$3,$4,COALESCE(MAX(ordinal),0)+1,$5,$6,now()+$7::integer*interval '1 minute',
        now()+$8::integer*interval '1 day',$9::text::jsonb
      FROM episode_media_revisions WHERE episode_id=$2 RETURNING *`,
    [id,episodeId,input.version,member.id,pathname,input.bytes,UPLOAD_MINUTES,STORAGE_DAYS,JSON.stringify(snapshot)]);
    return created;
  });
}

export async function ownedMontage(db,identity,episodeId,id){
  const member=await memberFor(db,identity,'author');
  const {rows:[row]}=await db.query('SELECT * FROM episode_media_revisions WHERE id=$1 AND episode_id=$2',
    [uuid(id),uuid(episodeId)]);
  if(!row) throw Error('NOT_FOUND');
  if(row.uploaded_by!==member.id) throw Error('FORBIDDEN');
  return row;
}

export async function confirmMontage(db,identity,episodeId,id,object){
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036596)');
    const owned=await ownedMontage(tx,identity,episodeId,id);
    const {rows:[row]}=await tx.query('SELECT * FROM episode_media_revisions WHERE id=$1 FOR UPDATE',[owned.id]);
    if(row.state!=='uploading') return row;
    if(new Date(row.upload_until).getTime()<=Date.now()) throw Error('MONTAGE_UPLOAD_EXPIRED');
    if(object.pathname!==row.pathname||object.size!==row.expected_bytes||object.contentType!=='video/mp4') {
      throw Error('MONTAGE_OBJECT_MISMATCH');
    }
    const {rows:[episode]}=await tx.query('SELECT * FROM episodes WHERE id=$1 FOR SHARE',[episodeId]);
    const {rows:published}=await tx.query('SELECT id FROM publications WHERE episode_id=$1',[episodeId]);
    if(published.length) throw Error('EPISODE_PUBLISHED');
    await packageFor(tx,episode,row.episode_version);
    const {rows:[updated]}=await tx.query(`UPDATE episode_media_revisions SET state='queued',
      expires_at=COALESCE($2::timestamptz,expires_at) WHERE id=$1 RETURNING *`,[row.id,object.expiresAt??null]);
    return updated;
  });
}

export async function readMontage(db,identity,episodeId,id){
  await memberFor(db,identity);
  const {rows:[row]}=await db.query('SELECT * FROM episode_media_revisions WHERE id=$1 AND episode_id=$2',
    [uuid(id),uuid(episodeId)]);
  if(!row) throw Error('NOT_FOUND');
  if(row.state==='uploading'||row.state==='expired'||new Date(row.expires_at).getTime()<=Date.now()) throw Error('NOT_FOUND');
  return row;
}

export async function listMontage(db,identity,videoId){
  const member=await memberFor(db,identity);
  const {rows}=await db.query(`SELECT m.id,m.episode_id,m.episode_version,m.ordinal,m.expected_bytes,m.created_at,
    m.expires_at,m.sha256,m.report,m.error_code,m.uploaded_by=$2 AS owned,
    (latest.reviewed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM audit_findings f LEFT JOIN audit_finding_reviews r USING(job_id,attempt,position)
      WHERE f.job_id=latest.id AND f.attempt=latest.attempt AND r.job_id IS NULL)) AS release_approved,
    CASE WHEN m.expires_at<=now() OR (m.state='uploading' AND m.upload_until<=now()) THEN 'expired' ELSE m.state END AS state
    FROM episode_media_revisions m JOIN episodes e ON e.id=m.episode_id JOIN claims c ON c.id=e.claim_id
    LEFT JOIN LATERAL (SELECT j.id,j.attempt,a.reviewed_at FROM ai_jobs j JOIN prepublication_audits a
      ON a.job_id=j.id AND a.attempt=j.attempt WHERE j.media_revision_id=m.id AND j.mode='video' AND j.status='succeeded'
      ORDER BY a.completed_at DESC,j.created_at DESC,j.id DESC LIMIT 1) latest ON true
    WHERE c.video_id=$1 ORDER BY m.ordinal DESC LIMIT 100`,[uuid(videoId),member.id]);
  return rows;
}
