import {activeMember} from '../access/membership.mjs';
import {uuid} from '../editorial/workflow-input.mjs';

export function reviewVideoAudit(db,identity,episodeId,mediaId,input){
  return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);
    if(!member?.roles.includes('editor')) throw Error('FORBIDDEN');
    episodeId=uuid(episodeId);mediaId=uuid(mediaId);
    const {rows:[media]}=await tx.query('SELECT * FROM episode_media_revisions WHERE id=$1 AND episode_id=$2 FOR UPDATE',[mediaId,episodeId]);
    if(!media||media.state!=='passed'||new Date(media.expires_at).getTime()<=Date.now()) throw Error('MEDIA_NOT_READY');
    if(input.action==='finding'){
      if(!Number.isSafeInteger(input.attempt)||!Number.isSafeInteger(input.position)
        ||!['resolved','accepted'].includes(input.disposition)
        ||typeof input.comment!=='string'||!input.comment.trim()||input.comment.length>4000) throw Error('INVALID_INPUT');
      const {rows:[audit]}=await tx.query('SELECT job_id,reviewed_at FROM prepublication_audits WHERE media_revision_id=$1 AND attempt=$2 FOR UPDATE',[mediaId,input.attempt]);
      if(!audit) throw Error('NOT_FOUND');
      if(audit.reviewed_at) throw Error('REVIEW_CLOSED');
      const {rows:[finding]}=await tx.query('SELECT position FROM audit_findings WHERE job_id=$1 AND attempt=$2 AND position=$3',[audit.job_id,input.attempt,input.position]);
      if(!finding) throw Error('NOT_FOUND');
      await tx.query(`INSERT INTO audit_finding_reviews(job_id,attempt,position,disposition,comment,reviewed_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id,attempt,position) DO UPDATE SET
        disposition=EXCLUDED.disposition,comment=EXCLUDED.comment,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now()`,
        [audit.job_id,input.attempt,input.position,input.disposition,input.comment.trim(),member.id]);
      return {action:'finding',attempt:input.attempt,position:input.position,disposition:input.disposition};
    }
    if(input.action!=='approve') throw Error('INVALID_INPUT');
    const {rows:[latest]}=await tx.query(`SELECT j.id,j.attempt,
      (SELECT count(*)::integer FROM audit_findings f WHERE f.job_id=j.id AND f.attempt=j.attempt) AS findings,
      (SELECT count(*)::integer FROM audit_finding_reviews r WHERE r.job_id=j.id AND r.attempt=j.attempt) AS reviewed
      FROM ai_jobs j JOIN prepublication_audits a ON a.job_id=j.id AND a.attempt=j.attempt
      WHERE j.media_revision_id=$1 AND j.mode='video' AND j.status='succeeded'
      ORDER BY a.completed_at DESC LIMIT 1 FOR UPDATE OF j,a`,[mediaId]);
    if(!latest) throw Error('AUDIT_REQUIRED');
    if(latest.reviewed!==latest.findings) throw Error('FINDINGS_OPEN');
    const {rows:[episode]}=await tx.query('SELECT version,status FROM episodes WHERE id=$1 FOR UPDATE',[episodeId]);
    if(!episode||episode.status!=='approved'||episode.version!==media.episode_version) throw Error('MEDIA_STALE');
    const {rows:[approved]}=await tx.query(`UPDATE prepublication_audits SET reviewed_at=now(),reviewed_by=$3
      WHERE job_id=$1 AND attempt=$2 RETURNING media_revision_id,attempt,reviewed_at`,[latest.id,latest.attempt,member.id]);
    return {action:'approve',...approved};
  });
}
