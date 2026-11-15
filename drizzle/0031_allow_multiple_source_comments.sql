DROP INDEX youtube_comment_target_short;
CREATE UNIQUE INDEX youtube_comment_active_target_short
ON youtube_short_comments(parent_video_id,short_video_id)
WHERE target_kind='source' AND state NOT IN ('published','rejected','failed');
