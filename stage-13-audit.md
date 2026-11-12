# Stage 13 audit — YouTube publishing integration

**Status: partially implemented locally; stage remains open.** The new OAuth/uploader code has not been deployed or exercised against Google. No channel is connected and no private upload has been completed.

## Current production capability

- A publisher can register a YouTube URL after uploading through YouTube Studio. Registration checks the current approved episode, approved media revision, completed video audit and reviewed findings. Duplicate registrations are rejected or returned idempotently.
- Production stores the YouTube video ID, publication timestamp, frozen editorial snapshot, later metrics and correction history.
- The read-only Shariy channel catalog is deployed at `/editorial/youtube-channel` and uses the server-only `YOUTUBE_API_KEY` for video metadata and statistics. It is a separate read capability, not a publisher.
- Production now has the independent sensitive `YOUTUBE_TOKEN_ENCRYPTION_KEY`; `GOOGLE_YOUTUBE_CLIENT_ID` and `GOOGLE_YOUTUBE_CLIENT_SECRET` are still absent. No channel is connected through this app.

## Local implementation completed

- Publisher-only Google OAuth authorization-code flow with random `state`, PKCE, offline refresh, scope validation, channel identity and revoke/disconnect handling.
- AES-256-GCM encryption for refresh tokens and resumable session URLs; secrets are never returned to the browser.
- Resumable 8 MiB upload steps tied to an already passed and reviewed exact Shorts media revision. The request includes the user-selected title/description and explicit visibility (private by default) and is confirmed against the file SHA-256.
- Recovery probes the YouTube upload session before sending more bytes, preventing a blind second upload after an ambiguous result. The final video ID, processing state and actual privacy are reconciled before marking the upload complete.
- Automated checks cover OAuth state/PKCE, encryption/tamper rejection, session URL validation, byte-range recovery and privacy/status reconciliation.

## Remaining acceptance work

1. Configure Google Cloud Web OAuth: enable YouTube Data API v3 and register this exact callback:
   `https://tin-shariia.viral4creators.app/api/youtube/oauth/callback`
2. Add `GOOGLE_YOUTUBE_CLIENT_ID` and `GOOGLE_YOUTUBE_CLIENT_SECRET` as sensitive Vercel Production secrets. The independent 32-byte base64url `YOUTUBE_TOKEN_ENCRYPTION_KEY` has been generated and stored; the Viral4Creators Vercel project has only `YOUTUBE_API_KEY`, so there are no OAuth credentials to copy.
3. Deploy the code and apply migration `0010_youtube_uploads` to Production.
4. Connect the owner's channel, choose a specific Shorts revision that has passed exact-file FFmpeg/Gemini review, authorize one private upload, then verify its video ID, processing/playback and private visibility in YouTube Studio/API.

Local validation on 12 Nov 2026: lint and typecheck pass; production build passes; suite reports 32 passed and 1 skipped (native PostgreSQL only). No OAuth connection, channel selection, upload, permission change or paid call has been performed. Until the four acceptance items are complete, closing Stage 13 would overstate readiness.

Official protocol references: [YouTube resumable upload](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), [YouTube OAuth](https://developers.google.com/youtube/v3/guides/authentication).
