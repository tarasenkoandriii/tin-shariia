import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFeedback } from '../src/editorial/feedback.mjs';

const draft = { kind: 'suggestion', text: ' Перевірити цитату ', attachmentIds: ['image'] };
const context = {
  durationMs: 2000,
  attachments: new Map([['image', { status: 'ready', mime: 'image/png', bytes: 1024 }]]),
};

test('accepts editable text and an approved image in one suggestion', () => {
  assert.deepEqual(validateFeedback({ ...draft, timestampMs: 0 }, context), {
    kind: 'suggestion', text: 'Перевірити цитату', attachmentIds: ['image'], timestampMs: 0,
  });
  assert.equal(validateFeedback({ ...draft, text: '' }, context).text, '');
  assert.deepEqual(validateFeedback({ ...draft, attachmentIds: [] }, context).attachmentIds, []);
});

test('rejects empty submissions, unavailable or duplicate images and invalid timecodes', () => {
  assert.throws(() => validateFeedback({ ...draft, text: ' ', attachmentIds: [] }, context), /EMPTY_FEEDBACK/);
  assert.throws(() => validateFeedback({ ...draft, attachmentIds: ['other'] }, context), /ATTACHMENT_UNAVAILABLE/);
  assert.throws(() => validateFeedback({ ...draft, attachmentIds: ['image', 'image'] }, context), /DUPLICATE_ATTACHMENT/);
  assert.throws(() => validateFeedback({ ...draft, timestampMs: 2000 }, context), /INVALID_FEEDBACK_TIMECODE/);
});
