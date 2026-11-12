# Stage 12 acceptance — Shorts audit and admission

**Status: implementation ready for a restricted internal pilot; real editorial acceptance remains pending a usable approved source file.**

## Delivered

- A completed short render is kept private and moves into a separate full-file FFmpeg technical audit before it can become `ready`.
- The audit checks the exact stored file by SHA-256, vertical 1080×1920 dimensions, 30–60 second duration, video and audio streams, audio completeness, loudness/peak and silence report using the existing FFmpeg report service.
- A successful technical report creates an immutable derived media revision (`kind=short`) tied to the currently approved episode, source revision, and short hook/title/description/clip manifest. It is not listed as an ordinary master montage.
- The existing full-video Gemini audit and reviewer finding/admission flow can audit that exact short revision. The UI labels it as a short and shows the measured technical report before reviewer admission.
- Shorts queue idempotency and private file handling remain in place; technical failures do not make a short eligible for admission.
- The migration is additive. No YouTube/TikTok publishing or caption generation was introduced.

## Verification

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm test` — passed (26 passed, 1 native-Postgres-only test skipped).
- `npm run build` — passed.
- `git diff --check` — passed.
- Targeted Shorts, montage, and publication tests cover technical report validation, immutable short revision, hiding derived revisions from normal montage listings, and sending the revision through the existing Gemini audit queue.
- Production migration `0009_shorts_audit.sql` applied.

## Required before calling editorial acceptance complete

The production database currently has 14 approved episodes but **no unexpired approved episode media revision in `passed` state**, so the full real-media path cannot be honestly demonstrated yet. No source episode or publication was modified to manufacture a test input.

Once an editor uploads/reprocesses a usable approved source, complete one real run: generate the short, inspect its video and audio, review the full-file FFmpeg report, run the existing Gemini audit within the project budget, resolve every blocking finding, rerun the audit on the exact final SHA-256, and admit it as a draft. This is editorial acceptance, not a production release or publication.

No actual Gemini spend or external publication was made in this implementation pass.
