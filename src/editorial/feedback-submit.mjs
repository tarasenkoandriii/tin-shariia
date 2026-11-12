import { validateFeedback } from './feedback.mjs';

/**
 * The persistence adapter locks the draft and target revision for the duration
 * of the transaction. It scopes drafts and attachments to the current author.
 */
export function submitFeedback(store, { actorId, draftId, expectedRevision }) {
  if (!actorId) throw new Error('AUTH_REQUIRED');

  return store.transaction(async (tx) => {
    const draft = await tx.findDraftForUpdate(actorId, draftId);
    if (!draft) throw new Error('DRAFT_NOT_FOUND');

    const target = await tx.findAuthorizedTargetForUpdate(actorId, draft.targetId);
    if (!target) throw new Error('TARGET_UNAVAILABLE');

    if (draft.submittedFeedbackId) {
      return tx.getFeedback(draft.submittedFeedbackId);
    }
    if (draft.revision !== expectedRevision || draft.targetRevision !== target.revision) {
      throw new Error('STALE_REVISION');
    }

    const attachments = await tx.findDraftAttachmentsForUpdate(actorId, draftId);
    const content = validateFeedback(draft, {
      attachments,
      durationMs: target.durationMs,
    });
    const feedback = await tx.insertFeedback({
      ...content,
      authorId: actorId,
      draftId,
      targetId: target.id,
      targetRevision: target.revision,
    });
    await tx.markDraftSubmitted(draftId, feedback.id);
    return feedback;
  });
}
