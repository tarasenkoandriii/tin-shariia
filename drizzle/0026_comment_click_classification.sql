ALTER TABLE youtube_short_comment_clicks ADD COLUMN traffic_class text NOT NULL DEFAULT 'unknown'
  CHECK (traffic_class IN ('unknown','test'));
CREATE INDEX youtube_comment_click_class_time ON youtube_short_comment_clicks(traffic_class,clicked_at);
