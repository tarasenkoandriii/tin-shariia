import { createHmac, timingSafeEqual } from 'node:crypto';

const maxLifetimeMs = 15 * 60 * 1000;

export function createMediaReadGrants(secret) {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new Error('MEDIA_GRANT_SECRET_REQUIRED');
  }

  const key = Buffer.from(secret);
  const sign = (payload) => createHmac('sha256', key).update(payload).digest();

  return {
    issue({ objectId, jobId, expiresAt, now = Date.now() }) {
      if (!objectId || !jobId || !Number.isSafeInteger(expiresAt)
        || expiresAt <= now || expiresAt - now > maxLifetimeMs) {
        throw new Error('INVALID_MEDIA_GRANT');
      }
      const payload = Buffer.from(JSON.stringify([objectId, jobId, expiresAt])).toString('base64url');
      return `${payload}.${sign(payload).toString('base64url')}`;
    },
    verify(token, { objectId, jobId, now = Date.now() }) {
      if (typeof token !== 'string' || token.length > 2048) return false;
      const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) return false;
      const expected = sign(match[1]).toString('base64url');
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) return false;
      const [signedObject, signedJob, expiresAt] = JSON.parse(
        Buffer.from(match[1], 'base64url').toString('utf8'),
      );
      return signedObject === objectId && signedJob === jobId && expiresAt > now;
    },
  };
}
