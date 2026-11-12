import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { importTranscript, registerVideo } from '../src/db/editorial-import.mjs';

test('stores video identity, immutable transcript versions and ordered cues', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile(new URL('../drizzle/0000_editorial_import.sql', import.meta.url), 'utf8'));
  const video = await registerVideo(db, 'https://youtu.be/CXH9VMko19s');
  assert.deepEqual(await registerVideo(db, 'https://youtube.com/shorts/CXH9VMko19s'), video);
  const save = (format, content) =>
    importTranscript(db, { videoId: video.id, bytes: Buffer.from(content), format });

  const first = await save('srt', '1\n00:00:01,000 --> 00:00:02,000\nЦитата');
  assert.deepEqual(await save('vtt', 'WEBVTT\n\n00:01.000 --> 00:02.000\nЦитата'), first);
  const second = await save('txt', 'Виправлена цитата');
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.notEqual(first.id, second.id);
  const result = await db.query(
    'SELECT body, start_ms::text AS start_ms FROM transcript_segments WHERE transcript_id = $1',
    [first.id],
  );
  assert.deepEqual(result.rows, [{ body: 'Цитата', start_ms: '1000' }]);
});
