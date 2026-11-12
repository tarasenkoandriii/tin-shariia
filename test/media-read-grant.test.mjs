import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createMediaReadGrants } from '../src/media/read-grant.mjs';

test('private media grant permits only its object, job and lifetime', () => {
  const grants = createMediaReadGrants(randomBytes(32));
  const scope = { objectId: 'media-1', jobId: 'job-1', now: 1000 };
  const token = grants.issue({ ...scope, expiresAt: 2000 });
  assert.equal(grants.verify(token, scope), true);
  assert.equal(grants.verify(token, { ...scope, objectId: 'media-2' }), false);
  assert.equal(grants.verify(token, { ...scope, jobId: 'job-2' }), false);
  assert.equal(grants.verify(token, { ...scope, now: 2000 }), false);
  assert.equal(grants.verify('A' + token, scope), false);
  assert.throws(() => grants.issue({ ...scope, expiresAt: 1_000_000 }), /INVALID_MEDIA_GRANT/);
});
