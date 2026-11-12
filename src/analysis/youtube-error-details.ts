const knownFields = {
  videoMetadata: /\bvideo_?metadata\b/i,
  startOffset: /\bstart_?offset\b/i,
  endOffset: /\bend_?offset\b/i,
  fps: /\bfps\b/i,
  fileUri: /\bfile_?uri\b/i,
  mimeType: /\bmime_?type\b/i,
  mediaResolution: /\bmedia_?resolution\b/i,
  responseSchema: /\bresponse_?schema\b/i,
  thinkingConfig: /\bthinking_?config\b/i,
  model: /\bmodel\b/i,
};

export function youtubeErrorDetails(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'ApiError' || error.message.length > 32768) return {};
  try {
    const payload = JSON.parse(error.message)?.error;
    const violations = Array.isArray(payload?.details)
      ? payload.details.flatMap((detail: { fieldViolations?: unknown }) =>
        Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : [])
      : [];
    const clues = violations.length
      ? violations.map((violation: { field?: unknown }) => typeof violation?.field === 'string' ? violation.field : '').join(' ')
      : typeof payload?.message === 'string' ? payload.message : '';
    const fields = Object.entries(knownFields).filter(([, pattern]) => pattern.test(clues)).map(([field]) => field);
    const reason = /youtube/i.test(clues) && /not supported|unsupported/i.test(clues) ? 'youtube_unsupported'
      : /could not (fetch|access)|failed to (fetch|access)|video (is )?unavailable|not publicly available/i.test(clues) ? 'source_unavailable'
      : undefined;
    return { fields, reason };
  } catch { return {}; }
}
