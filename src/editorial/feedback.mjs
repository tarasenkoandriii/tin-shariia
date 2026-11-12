const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxImageBytes = 5 * 1024 * 1024;

/** Attachments and duration come from server records after authorization. */
export function validateFeedback(draft, { attachments, durationMs }) {
  if (!['comment', 'suggestion'].includes(draft.kind)) {
    throw new Error('INVALID_FEEDBACK_KIND');
  }

  const text = typeof draft.text === 'string' ? draft.text.trim() : '';
  if (!Array.isArray(draft.attachmentIds) || draft.attachmentIds.length > 4) {
    throw new Error('INVALID_ATTACHMENT_COUNT');
  }
  const attachmentIds = [...draft.attachmentIds];
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error('DUPLICATE_ATTACHMENT');
  }
  if (!text && attachmentIds.length === 0) throw new Error('EMPTY_FEEDBACK');

  for (const id of attachmentIds) {
    const image = attachments.get(id);
    if (!image || image.status !== 'ready' || !imageTypes.has(image.mime)
      || !Number.isSafeInteger(image.bytes) || image.bytes <= 0
      || image.bytes > maxImageBytes) {
      throw new Error('ATTACHMENT_UNAVAILABLE');
    }
  }

  const timestampMs = draft.timestampMs ?? null;
  if (timestampMs !== null && (!Number.isSafeInteger(timestampMs)
    || !Number.isSafeInteger(durationMs) || timestampMs < 0 || timestampMs >= durationMs)) {
    throw new Error('INVALID_FEEDBACK_TIMECODE');
  }

  return { kind: draft.kind, text, attachmentIds, timestampMs };
}
