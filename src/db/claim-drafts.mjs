import { activeMember } from '../access/membership.mjs';
import { changeEditorial } from './editorial-workflow.mjs';
import { uuid } from '../editorial/workflow-input.mjs';

// Turns every not-yet-converted Gemini draft of a finished analysis into a draft claim of the same video.
// Claims stay drafts: verdict, explanation and sources are added by people, then the claim goes to review.
export async function createClaimsFromDrafts(db, identity, jobId) {
  jobId = uuid(jobId);
  const member = await activeMember(db, identity);
  if (!member?.roles.includes('author')) throw Error('FORBIDDEN');
  const { rows:[job] } = await db.query(
    "SELECT id,video_id,transcript_id,mode,status FROM ai_jobs WHERE id=$1 AND mode IN ('transcript','youtube')", [jobId]);
  if (!job) throw Error('NOT_FOUND');
  if (job.status !== 'succeeded') throw Error('ANALYSIS_NOT_READY');
  const { rows:drafts } = await db.query(
    'SELECT position FROM ai_claim_drafts WHERE job_id=$1 AND claim_id IS NULL ORDER BY position', [jobId]);
  const claims = [], skipped = [];
  for (const { position } of drafts) {
    // Fence: only one request converts a given draft; a crashed attempt can be retried after two minutes.
    const { rows:[draft] } = await db.query(`UPDATE ai_claim_drafts SET claiming_at=now()
      WHERE job_id=$1 AND position=$2 AND claim_id IS NULL AND (claiming_at IS NULL OR claiming_at<now()-interval '2 minutes')
      RETURNING draft`, [jobId, position]);
    if (!draft) continue;
    const item = draft.draft;
    let claim;
    try { claim = await changeEditorial(db, identity, 'claim', {
      action:'create', parentId:job.video_id,
      ...(job.transcript_id ? { transcriptId:job.transcript_id } : {}),
      quote:item.quote, question:item.question,
      context:[item.context, item.paraphrase ? 'Переказ Gemini, не дослівна цитата — звірте з відео.' : '',
        job.mode === 'youtube' ? 'Знайдено Gemini під час перегляду всього ролику.' : ''].filter(Boolean).join(' '),
      ...(Number.isSafeInteger(item.startMs) && Number.isSafeInteger(item.endMs) && item.endMs > item.startMs
        ? { startMs:item.startMs, endMs:item.endMs } : {}),
    }); } catch (error) {
      // One unusable draft must not block the others; it stays available for manual transfer.
      await db.query('UPDATE ai_claim_drafts SET claiming_at=NULL WHERE job_id=$1 AND position=$2', [jobId, position]);
      skipped.push({ position, code:error?.message ?? 'CLAIM_CREATE_FAILED' });
      continue;
    }
    await db.query('UPDATE ai_claim_drafts SET claim_id=$3,claiming_at=NULL WHERE job_id=$1 AND position=$2', [jobId, position, claim.id]);
    claims.push({ position, id:claim.id });
  }
  return { created:claims.length, claims, skipped };
}
