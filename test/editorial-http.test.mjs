import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createEditorialImportHandler } from '../src/http/editorial-import.mjs';

const origin = 'https://editor.test';

test('HTTP import checks access before saving and deduplicates imports in PostgreSQL', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile(new URL('../drizzle/0000_editorial_import.sql', import.meta.url), 'utf8'));
  let access;
  const handle = createEditorialImportHandler({ db, allowedOrigin: origin, authorize: async () => access });
  const post = (path, body, requestOrigin = origin) =>
    handle(new Request(origin + path, { method: 'POST', headers: { origin: requestOrigin }, body }));

  const videoBody = JSON.stringify({ url: 'https://youtu.be/CXH9VMko19s' });
  assert.equal((await post('/api/videos', videoBody)).status, 401);
  access = { actorId: 'editor', canImport: false };
  assert.equal((await post('/api/videos', videoBody)).status, 403);
  assert.deepEqual((await db.query('SELECT id FROM videos')).rows, []);
  access.canImport = true;
  access.durationMs = 1500;
  assert.equal((await post('/api/videos', videoBody, 'https://other.test')).status, 403);
  const video = await (await post('/api/videos', videoBody)).json();
  const path = `/api/videos/${video.data.id}/transcripts?format=srt`;
  assert.equal((await post(path, '00:00:00,000 --> 00:00:02,000\nТекст')).status, 422);
  assert.equal((await post(path, Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
  const cue = '00:00:00,000 --> 00:00:01,000\nТекст';
  const first = await post(path, cue);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await first.json(), await (await post(path, cue)).json());
  assert.equal((await db.query('SELECT id FROM transcripts')).rows.length, 1);
});
