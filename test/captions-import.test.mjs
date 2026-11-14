import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { captionsImportStatus, claimCaptionsImport, finishCaptionsImport } from '../src/db/captions-import.mjs';
import { registerVideo } from '../src/db/editorial-import.mjs';

test('captions import protects editorial access, rejects stale leases and deduplicates transcripts', async () => {
  const db = new PGlite();
  try {
    for (const file of ['0000_editorial_import', '0001_editorial_access', '0024_captions_import']) {
      await db.exec(await readFile(new URL('../drizzle/'+file+'.sql', import.meta.url), 'utf8'));
    }
    const { rows: [member] } = await db.query(
      "INSERT INTO members (clerk_user_id, email) VALUES ('author', 'author@example.test') RETURNING id",
    );
    await db.query("INSERT INTO member_roles VALUES ($1,'author')", [member.id]);
    const { id: videoId, youtubeId } = await registerVideo(db, 'https://youtu.be/QAcheck0001');
    const enqueue = () => captionsImportStatus(db, 'author', videoId, true);
    await assert.rejects(captionsImportStatus(db, 'unknown', videoId, true), /FORBIDDEN/);
    assert.equal((await enqueue()).status, 'queued');
    const job = await claimCaptionsImport(db);
    assert.equal(job.youtubeId, youtubeId);
    assert.equal((await enqueue()).status, 'running');
    assert.equal(await claimCaptionsImport(db), null);

    const srt = '1\n00:00:01,000 --> 00:00:02,000\nТестовий фрагмент.';
    assert.equal(await finishCaptionsImport(db, { videoId, lease: randomUUID(), srt }), false);
    await db.query("UPDATE captions_import_jobs SET lease_until=now()-interval '1 second'");
    assert.equal((await captionsImportStatus(db, 'author', videoId)).status, 'queued');
    const recovered = await claimCaptionsImport(db);
    assert.notEqual(recovered.lease, job.lease);
    assert.equal(await finishCaptionsImport(db, { ...job, srt }), false);
    assert.equal(await finishCaptionsImport(db, { ...recovered, srt }), true);
    assert.deepEqual(await captionsImportStatus(db, 'author', videoId),
      { status: 'done', errorCode: null, version: 1 });

    await enqueue();
    assert.equal(await finishCaptionsImport(db, { ...await claimCaptionsImport(db), srt }), true);
    assert.equal((await captionsImportStatus(db, 'author', videoId)).version, 1);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM transcripts')).rows[0].count, 1);

    await enqueue();
    assert.equal(await finishCaptionsImport(db, { ...await claimCaptionsImport(db), srt: '' }), true);
    assert.equal((await captionsImportStatus(db, 'author', videoId)).errorCode, 'INVALID_CAPTIONS');
  } finally {
    await db.close();
  }
});
