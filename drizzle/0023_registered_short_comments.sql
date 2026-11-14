ALTER TABLE youtube_short_comments ALTER COLUMN upload_id DROP NOT NULL;
ALTER TABLE youtube_short_comments ADD CONSTRAINT youtube_comment_registered_short
  CHECK (upload_id IS NOT NULL OR publication_id IS NOT NULL);

CREATE VIEW youtube_comment_candidates AS
SELECT u.id,'upload'::text AS kind,u.id AS upload_id,NULL::uuid AS registered_publication_id,
  u.episode_id,u.media_revision_id,u.youtube_id,u.title,u.updated_at
FROM youtube_short_uploads u WHERE u.state='published' AND u.actual_privacy_status='public'
UNION ALL
SELECT p.id,'publication'::text AS kind,NULL::uuid AS upload_id,p.id AS registered_publication_id,
  p.episode_id,p.media_revision_id,p.youtube_id,p.snapshot->'episode'->>'title' AS title,p.published_at AS updated_at
FROM publications p JOIN episode_media_revisions m ON m.id=p.media_revision_id
WHERE p.ai_disclosed=true AND m.state='passed' AND m.sha256 IS NOT NULL
  AND (m.report->>'width')::integer < (m.report->>'height')::integer
  AND (m.report->>'durationMs')::integer BETWEEN 1 AND 60000
  AND NOT EXISTS(SELECT 1 FROM youtube_short_uploads u WHERE u.youtube_id=p.youtube_id);
