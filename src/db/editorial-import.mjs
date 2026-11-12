import { parseYouTubeUrl } from '../editorial/youtube-url.mjs';
import { parseTranscript } from '../editorial/transcript.mjs';

export async function registerVideo(db, url) {
  const video = parseYouTubeUrl(url);
  if (!video) throw new Error('INVALID_YOUTUBE_URL');
  const { rows } = await db.query(
    `INSERT INTO videos (youtube_id) VALUES ($1)
     ON CONFLICT (youtube_id) DO UPDATE SET youtube_id = EXCLUDED.youtube_id
     RETURNING id`,
    [video.youtubeId],
  );
  return { id: rows[0].id, ...video };
}

/** Call after authorizing the editor and resolving any trusted media duration. */
export async function importTranscript(db, { videoId, bytes, format, durationMs }) {
  const { hash, segments } = parseTranscript(bytes, format, durationMs);
  return db.transaction(async (tx) => {
    // Serialize version assignment and deduplication for this video.
    const video = await tx.query('SELECT id FROM videos WHERE id = $1 FOR UPDATE', [videoId]);
    if (!video.rows.length) throw new Error('VIDEO_NOT_FOUND');

    const existing = await tx.query(
      'SELECT id, version FROM transcripts WHERE video_id = $1 AND content_hash = $2',
      [videoId, hash],
    );
    if (existing.rows.length) return existing.rows[0];

    const { rows: [transcript] } = await tx.query(
      `INSERT INTO transcripts (video_id, version, format, content_hash)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3 FROM transcripts WHERE video_id = $1
       RETURNING id, version`,
      [videoId, format, hash],
    );
    await tx.query(
      `INSERT INTO transcript_segments (transcript_id, position, start_ms, end_ms, body)
       SELECT $1, (ordinality - 1)::integer, (cue->>'startMs')::bigint,
              (cue->>'endMs')::bigint, cue->>'text'
       FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS segment(cue, ordinality)`,
      [transcript.id, JSON.stringify(segments)],
    );
    return transcript;
  });
}
