ALTER TABLE youtube_short_comments
  ALTER COLUMN publication_id DROP NOT NULL,
  DROP CONSTRAINT youtube_short_comments_upload_id_key,
  ADD COLUMN target_kind text NOT NULL DEFAULT 'main' CHECK (target_kind IN ('main','source')),
  ADD COLUMN approved_channel_id text,
  ADD CONSTRAINT youtube_comment_main_publication CHECK (target_kind <> 'main' OR publication_id IS NOT NULL);
CREATE UNIQUE INDEX youtube_comment_main_upload ON youtube_short_comments(upload_id) WHERE target_kind='main';
CREATE UNIQUE INDEX youtube_comment_target_short ON youtube_short_comments(parent_video_id,short_video_id) WHERE target_kind='source';
