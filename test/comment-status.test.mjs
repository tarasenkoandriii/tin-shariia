import assert from 'node:assert/strict';
import test from 'node:test';
import { commentStatus } from '../src/editorial/comment-status.mjs';

const published = { state: 'published', published_at: '2026-11-15T10:58:44Z' };

test('send and visibility are separate facts', () => {
  assert.equal(commentStatus({ state: 'succeeded' }).visibility, null);
  assert.equal(commentStatus({ state: 'succeeded' }).send.label, 'Чекає схвалення');
  const verified = commentStatus({ ...published, publication_steps: { phase: 'verified', linked_verified_at: '2026-11-15T12:53:48Z' } });
  assert.equal(verified.send.label, 'Прийнято YouTube API');
  assert.deepEqual([verified.visibility.value, verified.visibility.label, verified.visibility.checkedAt], ['confirmed', 'Видимість підтверджено', '2026-11-15T12:53:48Z']);
  assert.equal(commentStatus({ ...published, publication_steps: { phase: 'waiting_link' } }).visibility.label, 'Перевіряємо видимість');
});

test('blocked or gone comments are problems; comments without a reload check are neutral', () => {
  const blocked = commentStatus({ ...published, publication_steps: { phase: 'blocked', checked_at: '2026-11-14T13:20:54Z' } }).visibility;
  assert.deepEqual([blocked.value, blocked.tone, blocked.problem], ['not_confirmed', 'warning', true]);
  const gone = commentStatus({ ...published, publication_steps: { phase: 'verified', checked_at: '2026-11-14T13:20:54Z' },
    public_visibility: { code: 'YOUTUBE_COMMENT_NOT_VISIBLE', checkedAt: '2026-11-15T13:36:58Z' } }).visibility;
  assert.deepEqual([gone.value, gone.problem, gone.checkedAt], ['not_confirmed', true, '2026-11-15T13:36:58Z']);
  const main = commentStatus({ ...published, public_visibility: { code: 'OK', checkedAt: '2026-11-15T13:00:00Z' } }).visibility;
  assert.deepEqual([main.value, main.tone, main.problem], ['not_confirmed', 'neutral', false]);
  assert.match(main.reason, /перевірки після перезавантаження для цього коментаря немає/);
});
