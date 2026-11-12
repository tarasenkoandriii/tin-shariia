import { activeMember } from '../access/membership.mjs';
import { uuid } from '../editorial/workflow-input.mjs';

export async function videoAuditStatus(db,identity,episodeId,mediaId){
  const member=await activeMember(db,identity);
  if(!member) throw Error('FORBIDDEN');
  const {rows:[media]}=await db.query('SELECT id FROM episode_media_revisions WHERE id=$1 AND episode_id=$2',[uuid(mediaId),uuid(episodeId)]);
  if(!media) throw Error('NOT_FOUND');
  const {rows}=await db.query(`SELECT j.id,j.attempt,j.status,j.error_code,j.model,j.requested_by=$2 AS owned,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('attempt',a.attempt,'summary',a.summary,'coverage',a.coverage,
      'completedAt',a.completed_at,'findings',COALESCE((SELECT jsonb_agg(f.finding ORDER BY f.position)
      FROM audit_findings f WHERE f.job_id=a.job_id AND f.attempt=a.attempt),'[]'::jsonb)) ORDER BY a.attempt DESC)
      FROM prepublication_audits a WHERE a.job_id=j.id),'[]'::jsonb) AS reports
    FROM ai_jobs j WHERE j.media_revision_id=$1 ORDER BY j.created_at DESC LIMIT 10`,[media.id,member.id]);
  return rows;
}
