-- Persist AI disclosure state for the platform publication routes.
ALTER TABLE youtube_short_uploads
  ADD COLUMN contains_synthetic_media boolean NOT NULL DEFAULT false,
  ADD COLUMN actual_contains_synthetic_media boolean;

ALTER TABLE publications
  ADD COLUMN ai_disclosed boolean NOT NULL DEFAULT false;
