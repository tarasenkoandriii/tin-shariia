import {randomUUID} from 'node:crypto';
import {activeMember} from '../access/membership.mjs';
import {uuid} from '../editorial/workflow-input.mjs';

const json=value=>JSON.stringify(value);

async function publisher(tx,identity){
  if(!identity) throw Error('AUTH_REQUIRED');
  const member=await activeMember(tx,identity);
  if(!member?.roles.includes('publisher')) throw Error('FORBIDDEN');
  return member;
}

export async function createOAuthState(db,identity,{stateHash,codeVerifier}){
  if(!/^[a-f0-9]{64}$/.test(stateHash)||typeof codeVerifier!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(codeVerifier)) throw Error('INVALID_INPUT');
  return db.transaction(async tx=>{
    const member=await publisher(tx,identity);
    await tx.query('DELETE FROM youtube_oauth_states WHERE expires_at<=now()');
    await tx.query(`INSERT INTO youtube_oauth_states(state_hash,member_id,code_verifier,expires_at)
      VALUES($1,$2,$3,now()+interval '10 minutes')`,[stateHash,member.id,codeVerifier]);
    return {memberId:member.id};
  });
}

export async function consumeOAuthState(db,identity,stateHash){
  return db.transaction(async tx=>{
    const member=await publisher(tx,identity);
    const {rows:[state]}=await tx.query(`DELETE FROM youtube_oauth_states WHERE state_hash=$1 AND member_id=$2
      AND expires_at>now() RETURNING code_verifier`,[stateHash,member.id]);
    if(!state) throw Error('YOUTUBE_OAUTH_STATE_INVALID');
    return {memberId:member.id,codeVerifier:state.code_verifier};
  });
}

export async function saveYouTubeConnection(db,identity,{channelId,channelTitle,refreshTokenEncrypted,scopes}){
  return db.transaction(async tx=>{
    const member=await publisher(tx,identity);
    await tx.query('UPDATE youtube_connections SET disconnected_at=now(),refresh_token_encrypted=NULL,updated_at=now() WHERE disconnected_at IS NULL');
    const {rows:[connection]}=await tx.query(`INSERT INTO youtube_connections(owner_id,channel_id,channel_title,refresh_token_encrypted,scopes)
      VALUES($1,$2,$3,$4,$5) RETURNING id,channel_id,channel_title,connected_at`,
    [member.id,channelId,channelTitle,refreshTokenEncrypted,scopes]);
    return connection;
  });
}

export async function getYouTubeConnection(db,identity){
  const member=await publisher(db,identity);
  const {rows:[connection]}=await db.query(`SELECT id,channel_id,channel_title,connected_at FROM youtube_connections
    WHERE owner_id=$1 AND disconnected_at IS NULL`,[member.id]);
  return connection??null;
}

export async function getYouTubeConnectionSecret(db,identity){
  const member=await publisher(db,identity);
  const {rows:[connection]}=await db.query(`SELECT id,channel_id,channel_title,refresh_token_encrypted,scopes
    FROM youtube_connections WHERE owner_id=$1 AND disconnected_at IS NULL`,[member.id]);
  return connection??null;
}

export async function disconnectYouTube(db,identity){
  return db.transaction(async tx=>{
    const member=await publisher(tx,identity);
    const {rows:[connection]}=await tx.query(`UPDATE youtube_connections SET disconnected_at=now(),refresh_token_encrypted=NULL,updated_at=now()
      WHERE owner_id=$1 AND disconnected_at IS NULL RETURNING id`,[member.id]);
    if(!connection) return false;
    await tx.query(`UPDATE youtube_short_uploads SET state='failed',error_code='YOUTUBE_DISCONNECTED',updated_at=now()
      WHERE connection_id=$1 AND state IN ('queued','uploading','processing','unknown')`,[connection.id]);
    return true;
  });
}

export async function createYouTubeShortUpload(db,identity,episodeId,shortId,input){
  episodeId=uuid(episodeId);shortId=uuid(shortId);
  return db.transaction(async tx=>{
    const member=await publisher(tx,identity);
    if(input.confirmed!==true||!['private','unlisted','public'].includes(input.privacyStatus)
      ||typeof input.idempotencyKey!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)) throw Error('INVALID_INPUT');
    const title=typeof input.title==='string'?input.title.trim():'';
    const description=typeof input.description==='string'?input.description.trim():'';
    if(!title||title.length>100||description.length>5000) throw Error('INVALID_INPUT');
    const {rows:[connection]}=await tx.query(`SELECT id FROM youtube_connections WHERE owner_id=$1 AND disconnected_at IS NULL`,[member.id]);
    if(!connection) throw Error('YOUTUBE_CHANNEL_NOT_CONNECTED');
    const {rows:[release]}=await tx.query(`SELECT s.id,s.episode_id,s.manifest,m.id AS media_revision_id,m.pathname,
      m.expected_bytes,m.sha256,m.expires_at,e.version AS current_version,e.status AS episode_status,
      c.status AS claim_status,c.version AS current_claim_version,
      a.reviewed_at
      FROM shorts_renders s JOIN episode_media_revisions m ON m.id=s.audit_media_revision_id
      JOIN episodes e ON e.id=s.episode_id JOIN claims c ON c.id=e.claim_id
      JOIN LATERAL (SELECT x.reviewed_at,x.job_id,x.attempt FROM ai_jobs j
        JOIN prepublication_audits x ON x.job_id=j.id AND x.attempt=j.attempt
        WHERE j.media_revision_id=m.id AND j.mode='video' AND j.status='succeeded'
        ORDER BY x.completed_at DESC,j.created_at DESC,j.id DESC LIMIT 1) a ON true
      WHERE s.id=$1 AND s.episode_id=$2 AND s.state='ready' AND m.kind='short' AND m.state='passed'
        AND m.sha256 IS NOT NULL AND m.expected_bytes>0 AND m.expires_at>now()
        AND e.status='approved' AND e.version=s.episode_version AND c.status='approved'
        AND m.snapshot->>'claimVersion'=c.version::text AND a.reviewed_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM audit_findings f LEFT JOIN audit_finding_reviews r USING(job_id,attempt,position)
          WHERE f.job_id=a.job_id AND f.attempt=a.attempt AND r.job_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM youtube_short_uploads u WHERE u.episode_id=s.episode_id
          AND u.state='published')`,[shortId,episodeId]);
    if(!release) throw Error('YOUTUBE_RELEASE_APPROVAL_REQUIRED');
    if(input.reviewedSha256!==release.sha256) throw Error('YOUTUBE_MEDIA_CONFIRMATION_REQUIRED');
    const existingByKey=await tx.query('SELECT * FROM youtube_short_uploads WHERE idempotency_key=$1',[input.idempotencyKey]);
    if(existingByKey.rows[0]) return existingByKey.rows[0];
    const {rows:[existingMedia]}=await tx.query('SELECT id,created_by,state,title,privacy_status,sha256 FROM youtube_short_uploads WHERE media_revision_id=$1',[release.media_revision_id]);
    if(existingMedia){
      if(existingMedia.created_by===member.id&&existingMedia.title===title&&existingMedia.privacy_status===input.privacyStatus
        &&existingMedia.sha256===release.sha256) return existingMedia;
      throw Error('YOUTUBE_UPLOAD_EXISTS');
    }
    const id=randomUUID();
    const {rows:[upload]}=await tx.query(`INSERT INTO youtube_short_uploads
      (id,episode_id,media_revision_id,connection_id,created_by,idempotency_key,title,description,privacy_status,total_bytes,sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id,state,title,privacy_status,total_bytes,sha256,created_at`,
    [id,episodeId,release.media_revision_id,connection.id,member.id,input.idempotencyKey,title,description,
      input.privacyStatus,release.expected_bytes,release.sha256]);
    await tx.query(`INSERT INTO youtube_upload_events(upload_id,actor_id,action,details) VALUES($1,$2,'queued',$3::text::jsonb)`,
      [upload.id,member.id,json({privacyStatus:upload.privacy_status,mediaRevisionId:release.media_revision_id,sha256:release.sha256})]);
    return upload;
  });
}

export async function loadYouTubeUpload(db,identity,id){
  await publisher(db,identity);
  const {rows:[row]}=await db.query(`SELECT u.id,u.episode_id,u.media_revision_id,u.connection_id,u.title,u.description,
    u.privacy_status,u.state,u.upload_uri_encrypted,u.upload_offset,u.total_bytes,u.sha256,u.youtube_id,
    u.processing_status,u.actual_privacy_status,u.error_code,u.run_lease,u.created_at,m.pathname,m.expires_at,
    c.refresh_token_encrypted,c.channel_id
    FROM youtube_short_uploads u JOIN episode_media_revisions m ON m.id=u.media_revision_id
    JOIN youtube_connections c ON c.id=u.connection_id WHERE u.id=$1`,[uuid(id)]);
  if(!row) throw Error('NOT_FOUND');
  return row;
}

export async function loadYouTubeUploadInternal(db,id){
  const {rows:[row]}=await db.query(`SELECT u.id,u.episode_id,u.media_revision_id,u.connection_id,u.title,u.description,
    u.privacy_status,u.state,u.upload_uri_encrypted,u.upload_offset,u.total_bytes,u.sha256,u.youtube_id,
    u.processing_status,u.actual_privacy_status,u.error_code,u.run_lease,u.created_at,m.pathname,m.expires_at,
    c.refresh_token_encrypted,c.channel_id
    FROM youtube_short_uploads u JOIN episode_media_revisions m ON m.id=u.media_revision_id
    JOIN youtube_connections c ON c.id=u.connection_id WHERE u.id=$1`,[uuid(id)]);
  if(!row) throw Error('NOT_FOUND');
  return row;
}

export async function loadYouTubeUploadForShort(db,identity,episodeId,shortId){
  await publisher(db,identity);
  const {rows:[row]}=await db.query(`SELECT u.id,u.episode_id,u.media_revision_id,u.title,u.description,u.privacy_status,
    u.state,u.upload_offset,u.total_bytes,u.sha256,u.youtube_id,u.processing_status,u.actual_privacy_status,
    u.error_code,u.created_at FROM youtube_short_uploads u JOIN shorts_renders s ON s.audit_media_revision_id=u.media_revision_id
    WHERE u.episode_id=$1 AND s.id=$2`,[uuid(episodeId),uuid(shortId)]);
  if(!row) throw Error('NOT_FOUND');
  return row;
}

export async function patchYouTubeUpload(db,id,values){
  return db.transaction(async tx=>{
    const uploadId=uuid(id);
    const {rows:[before]}=await tx.query('SELECT state,upload_offset FROM youtube_short_uploads WHERE id=$1 FOR UPDATE',[uploadId]);
    if(!before)return null;
    const {rows:[row]}=await tx.query(`UPDATE youtube_short_uploads SET
      state=COALESCE($2,state),upload_uri_encrypted=COALESCE($3,upload_uri_encrypted),
      upload_offset=COALESCE($4,upload_offset),youtube_id=COALESCE($5,youtube_id),
      processing_status=COALESCE($6,processing_status),actual_privacy_status=COALESCE($7,actual_privacy_status),
      error_code=$8,run_lease=$9,updated_at=now() WHERE id=$1 RETURNING state,upload_offset,youtube_id,processing_status,actual_privacy_status`,
    [uploadId,values.state??null,values.uploadUriEncrypted??null,values.offset??null,values.youtubeId??null,
      values.processingStatus??null,values.actualPrivacyStatus??null,values.errorCode??null,values.lease??null]);
    if(before.state!==row.state||Number(before.upload_offset)!==Number(row.upload_offset)){
      const action=row.state==='uploading'?(before.state==='queued'?'session_started':'chunk_accepted'):
        row.state==='processing'?'processing':row.state==='published'?'published':row.state==='failed'?'failed':row.state==='unknown'?'unknown':null;
      if(action)await tx.query(`INSERT INTO youtube_upload_events(upload_id,action,details) VALUES($1,$2,$3::text::jsonb)`,
        [uploadId,action,json({from:before.state,state:row.state,offset:Number(row.upload_offset),youtubeId:row.youtube_id,
          processingStatus:row.processing_status,privacyStatus:row.actual_privacy_status,errorCode:values.errorCode??null})]);
    }
    return row;
  });
}

export async function claimYouTubeUpload(db,id){
  return db.transaction(async tx=>{
    const {rows:[row]}=await tx.query(`SELECT state,run_lease FROM youtube_short_uploads WHERE id=$1 FOR UPDATE`,[uuid(id)]);
    if(!row) throw Error('NOT_FOUND');
    if(['published','failed'].includes(row.state)) return {done:true,state:row.state};
    if(row.run_lease&&new Date(row.run_lease)>new Date()) return {busy:true};
    await tx.query(`UPDATE youtube_short_uploads SET run_lease=now()+interval '90 seconds',updated_at=now()
      WHERE id=$1`,[uuid(id)]);
    return {done:false};
  });
}

export async function releaseYouTubeUploadLease(db,id){
  await db.query('UPDATE youtube_short_uploads SET run_lease=NULL,updated_at=now() WHERE id=$1',[uuid(id)]);
}

