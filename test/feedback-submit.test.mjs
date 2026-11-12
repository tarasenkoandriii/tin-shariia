import assert from 'node:assert/strict';
import test from 'node:test';
import { submitFeedback } from '../src/editorial/feedback-submit.mjs';

const request = { actorId: 'editor', draftId: 'draft', expectedRevision: 2 };

function fixture() {
  const draft = {
    id: 'draft', targetId: 'episode', targetRevision: 5, revision: 2,
    kind: 'comment', text: 'Перевірити звук', attachmentIds: [],
  };
  const target = { id: 'episode', revision: 5, durationMs: 1000 };
  const records = new Map();
  let authorized = true;
  const tx = {
    findDraftForUpdate: async (actor, id) => actor === 'editor' && id === draft.id ? draft : null,
    findAuthorizedTargetForUpdate: async () => authorized ? target : null,
    findDraftAttachmentsForUpdate: async () => new Map(),
    insertFeedback: async (content) => {
      const row = { id: String(records.size + 1), ...content };
      records.set(row.id, row);
      return row;
    },
    markDraftSubmitted: async (_, id) => { draft.submittedFeedbackId = id; },
    getFeedback: async (id) => records.get(id),
  };
  return {
    store: { transaction: (callback) => callback(tx) },
    target, records,
    revokeAccess: () => { authorized = false; },
  };
}

test('submits once and returns the same record on retry', async () => {
  const { store, records, target } = fixture();
  const first = await submitFeedback(store, request);
  target.revision++;
  assert.deepEqual(await submitFeedback(store, request), first);
  assert.equal(records.size, 1);
  assert.equal(first.targetRevision, 5);
});

test('rejects another author, stale revisions and replay after access revocation', async () => {
  const { store, records, revokeAccess } = fixture();
  await assert.rejects(submitFeedback(store, { ...request, actorId: 'other' }), /DRAFT_NOT_FOUND/);
  await assert.rejects(submitFeedback(store, { ...request, expectedRevision: 1 }), /STALE_REVISION/);
  await submitFeedback(store, request);
  revokeAccess();
  await assert.rejects(submitFeedback(store, request), /TARGET_UNAVAILABLE/);
  assert.equal(records.size, 1);
});
