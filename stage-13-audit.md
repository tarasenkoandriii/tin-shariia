# Stage 13 audit — YouTube publishing integration

**Status: deployed to Production. Live YouTube acceptance remains open.** No channel is connected and no private upload has been completed.

## Current production capability

- A publisher can register a YouTube URL after uploading through YouTube Studio. Registration checks the current approved episode, approved media revision, completed video audit and reviewed findings. Duplicate registrations are rejected or returned idempotently.
- Production stores the YouTube video ID, publication timestamp, frozen editorial snapshot, later metrics and correction history.
- The read-only Shariy channel catalog is deployed at `/editorial/youtube-channel` and uses the server-only `YOUTUBE_API_KEY` for video metadata and statistics. It is a separate read capability, not a publisher.
- Production has both Google OAuth credentials and the independent token encryption key as sensitive variables.

## Local implementation completed

- Publisher-only Google OAuth authorization-code flow with random `state`, PKCE, offline refresh, scope validation, channel identity and revoke/disconnect handling.
- AES-256-GCM encryption for refresh tokens and resumable session URLs; secrets are never returned to the browser.
- Resumable 8 MiB upload steps tied to an already passed and reviewed exact Shorts media revision. The request includes the user-selected title/description and explicit visibility (private by default) and is confirmed against the file SHA-256.
- Recovery probes the YouTube upload session before sending more bytes, preventing a blind second upload after an ambiguous result. The final video ID, processing state and actual privacy are reconciled before marking the upload complete.
- Automated checks cover OAuth state/PKCE, encryption/tamper rejection, session URL validation, byte-range recovery and privacy/status reconciliation.

## Remaining acceptance work

Production migration `0010_youtube_uploads` was applied. Vercel deployment [4jScywxtk7DKjbv61Lzuzbzv7xAU](https://vercel.com/sibionics-ai/tin-shariia/4jScywxtk7DKjbv61Lzuzbzv7xAU) is READY at commit `acadf3e`. The production connection endpoint returned HTTP 401 without authentication. [CI passed](https://github.com/tarasenkoandriii/tin-shariia/actions/runs/43298650227), including the PostgreSQL workflow check and production build.

Production has zero connected channels and zero ready Shorts with a passed media revision. The publisher must connect the intended channel and approve a reviewed Shorts revision. Acceptance requires one private upload and confirmation of video ID, completed processing, playback and private visibility.

Official protocol references: [YouTube resumable upload](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), [YouTube OAuth](https://developers.google.com/youtube/v3/guides/authentication).

## Private YouTube Studio check — 2026-11-13

The connected editorial channel is `@ТіньШарія` (`UCqiH2d7WT_POfbRi17KKPfw`). The 1.15× narration cut of «Мідас» і «Карфаген»: дві справи, різні стадії was uploaded manually in YouTube Studio. Studio listed it under Shorts with visibility Private, and it played in the authorized browser. YouTube video ID: `9s2TYleQ7o4`.

This verifies private playback on the intended channel. Stage 13 acceptance still requires a separate approved media revision to pass through the editorial app's OAuth uploader and reconciliation. The manual Studio upload did not exercise that route.
