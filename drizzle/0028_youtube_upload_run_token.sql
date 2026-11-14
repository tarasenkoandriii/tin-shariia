-- Owner token for the YouTube upload worker lease: only the claimant may write or release.
ALTER TABLE youtube_short_uploads ADD COLUMN run_token uuid;
