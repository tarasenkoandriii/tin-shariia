import { randomUUID } from 'node:crypto';
import { activeMember } from '../access/membership.mjs';
import { uuid } from '../editorial/workflow-input.mjs';
import { parseTranscript } from '../editorial/transcript.mjs';
import { importTranscript } from './editorial-import.mjs';

export const readerErrors = ['NO_CAPTIONS', 'READER_UNAVAILABLE', 'INVALID_CAPTIONS'];

export async function captionsImportStatus(db, identity, videoId, enqueue = false) {
  videoId = uuid(videoId);
  const member = await activeMember(db, identity);
  if (!member?.roles.some(role => role === 'author' || role === 'admin')) throw Error('FORBIDDEN');
  if (enqueue) {
    await db.query(`INSERT INTO captions_import_jobs (video_id)
      SELECT id FROM videos WHERE id=$1
      ON CONFLICT (video_id) DO UPDATE SET status='queued', updated_at=now(),
        lease=NULL, lease_until=NULL, error_code=NULL, transcript_version=NULL
      WHERE captions_import_jobs.status IN ('done','failed')`, [videoId]);
  }
  const { rows: [job] } = await db.query(`SELECT
    CASE WHEN j.status='running' AND j.lease_until < now() THEN 'queued' ELSE j.status END AS status,
    j.error_code AS "errorCode", j.transcript_version AS version
    FROM videos v LEFT JOIN captions_import_jobs j ON v.id=j.video_id WHERE v.id=$1`, [videoId]);
  if (!job) throw Error('NOT_FOUND');
  return job;
}

export async function claimCaptionsImport(db) {
  const { rows: [job] } = await db.query(`WITH candidate AS (
    SELECT video_id FROM captions_import_jobs
    WHERE status='queued' OR (status='running' AND lease_until < now())
    ORDER BY updated_at, video_id LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE captions_import_jobs j SET status='running', updated_at=now(),
    lease=$1, lease_until=now()+interval '4 minutes'
  FROM candidate c JOIN videos v ON v.id=c.video_id WHERE j.video_id=c.video_id
  RETURNING j.video_id AS "videoId", v.youtube_id AS "youtubeId", j.lease`, [randomUUID()]);
  return job ?? null;
}

export async function finishCaptionsImport(db, input) {
  const videoId = uuid(input.videoId);
  const lease = uuid(input.lease);
  let errorCode = readerErrors.includes(input.errorCode) ? input.errorCode : null;
  const bytes = typeof input.srt === 'string' ? Buffer.from(input.srt) : null;
  if (!errorCode) {
    try { parseTranscript(bytes, 'srt'); }
    catch { errorCode = 'INVALID_CAPTIONS'; }
  }
  return db.transaction(async tx => {
    const { rows: [job] } = await tx.query(`SELECT status FROM captions_import_jobs
      WHERE video_id=$1 AND lease=$2 AND lease_until > now() FOR UPDATE`, [videoId, lease]);
    if (job?.status !== 'running') return false;
    const transcript = errorCode ? null : await importTranscript({ transaction: work => work(tx) },
      { videoId, bytes, format: 'srt' });
    await tx.query(`UPDATE captions_import_jobs SET status=$2, error_code=$3,
      transcript_version=$4, updated_at=now(), lease=NULL, lease_until=NULL WHERE video_id=$1`,
    [videoId, errorCode ? 'failed' : 'done', errorCode, transcript?.version ?? null]);
    return true;
  });
}
