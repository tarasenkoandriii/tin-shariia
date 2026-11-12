import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { auditMedia } from '../scripts/audit-media.mjs';
import { createPrivateMediaHandler } from '../src/media/private-media.mjs';
import { createMediaReadGrants } from '../src/media/read-grant.mjs';

test('private HTTP delivery supplies a complete clip for audio audit and rejects expired reads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tin-media-'));
  t.after(() => rm(dir, { recursive: true }));
  const source = join(dir, 'source.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=size=160x90:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-af', 'apad', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', source,
  ]);
  const original = await readFile(source);
  const grants = createMediaReadGrants(randomBytes(32));
  let now = 1000;
  let reads = 0;
  const handle = createPrivateMediaHandler({
    grants,
    now: () => now,
    readObject: async () => {
      reads++;
      return Readable.toWeb(Readable.from([original]));
    },
  });
  const server = createServer(async (req, res) => {
    const response = await handle(new Request('http://localhost' + req.url, { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}/api/media/clip`;
  const grant = grants.issue({ objectId: 'clip', jobId: 'audit', now, expiresAt: 2000 });
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await fetch(`${base}?job=other&grant=${grant}`)).status, 403);
  const authorizedUrl = `${base}?job=audit&grant=${grant}`;
  const response = await fetch(authorizedUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(downloaded, original);
  const path = join(dir, 'download.mp4');
  await writeFile(path, downloaded);
  const report = await auditMedia(path);
  assert.equal(report.durationMs, 2000);
  assert.ok(Number.isFinite(report.integratedLufs));
  assert.ok(Number.isFinite(report.truePeakDbfs));
  assert.deepEqual(report.silence, [{ startMs: 1000, endMs: 2000 }]);
  now = 2000;
  assert.equal((await fetch(authorizedUrl)).status, 403);
  assert.equal(reads, 1);
});
