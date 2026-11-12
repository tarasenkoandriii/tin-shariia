# Stage 13 audit — YouTube publishing integration

**Status: not implemented; stage remains open.** This audit prevents the existing manual-registration screen from being mistaken for an upload integration.

## Current production capability

- A publisher can register a YouTube URL after uploading through YouTube Studio.
- Registration checks the current approved episode, approved media revision, completed video audit and reviewed findings. Repeated/duplicate registrations are rejected or returned idempotently.
- The app stores the YouTube video ID, publication timestamp, a frozen editorial snapshot, later metrics and correction history.
- There is no OAuth connection flow, channel picker, YouTube API upload, explicit privacy setting, resumable upload state machine, post-upload processing/visibility reconciliation, or retry/unknown-outcome handling for YouTube.
- Production environment has no YouTube OAuth client credentials. No channel has been connected through this app.
- A separate read-only page for the Shariy channel has now been added locally. It uses `YOUTUBE_API_KEY` to page through uploads and fetch metadata/statistics in batches. Production currently lacks that key, and this read-only feed does not satisfy the publishing integration criteria in Stage 13.

## Required implementation and acceptance

1. Implement Google OAuth authorization-code flow with `youtube.upload`, `state`/CSRF validation, offline refresh, encrypted server-side token storage, channel identity, disconnect/revoke handling, and publisher-only access.
2. Implement a durable, resumable YouTube upload state machine for an already audited exact Shorts media revision. Persist upload-session URI securely and track offset/status so retries never create a duplicate after an unknown result.
3. Require the editor to review title, description, target channel and explicit visibility. Default the test path to `private`; never rely on YouTube's default visibility.
4. Reconcile the returned YouTube video ID, processing status and actual `privacyStatus` with YouTube Data API; surface processing failures and expired upload sessions without blind re-upload.
5. Add idempotency and tests for OAuth state, role enforcement, token encryption, upload resume/status reconciliation, duplicate prevention, errors, and privacy selection.
6. Configure a Google Cloud Web OAuth client, enable YouTube Data API v3, register the production callback URL, and add credentials plus an independent token-encryption key to Vercel Production.
7. Connect the owner's YouTube channel, select one editor-approved Shorts revision and explicitly authorize one private test upload. Verify the resulting ID, playback/processing status and privacy in YouTube Studio/API before closing the stage.

Official protocol references: [YouTube resumable upload](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol), [videos.insert](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert), [YouTube OAuth](https://developers.google.com/youtube/v3/guides/authentication).

One read-only YouTube RSS request verified the channel ID/title. No YouTube Data API/OAuth authorization, channel connection, upload, permission change or paid spend was performed.
