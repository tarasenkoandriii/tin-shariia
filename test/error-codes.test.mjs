import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { logUnexpectedError, redactErrorText } from '../src/access/error-log.mjs';

// Codes that never reach the JSON API maps: they have their own handling (server actions, feedback,
// startup configuration) or are thrown only in browser code and scripts. Everything else must be mapped,
// otherwise the editor sees a generic 500 instead of a clear status.
const handledElsewhere = new Set([
  // Membership server actions translate these themselves (src/app/editorial/actions.ts).
  'ALREADY_INITIALIZED', 'INVALID_EMAIL', 'INVALID_ROLES', 'INVITATION_DENIED', 'LAST_ADMIN', 'MEMBER_EXISTS',
  'MEMBER_UNAVAILABLE', 'VERIFIED_EMAIL_REQUIRED',
  // Feedback flow has its own result codes.
  'ATTACHMENT_UNAVAILABLE', 'DRAFT_NOT_FOUND', 'DUPLICATE_ATTACHMENT', 'EMPTY_FEEDBACK', 'INVALID_ATTACHMENT_COUNT',
  'INVALID_FEEDBACK_KIND', 'INVALID_FEEDBACK_TIMECODE', 'STALE_REVISION', 'TARGET_UNAVAILABLE',
  // Startup configuration: a 500 is correct and is now logged.
  'APP_ORIGIN_INVALID', 'APP_ORIGIN_REQUIRES_HTTPS', 'APP_STAGE_MISMATCH', 'DATABASE_STAGE_MISMATCH', 'DATABASE_URL_REQUIRED',
  'PRODUCTION_CLERK_KEYS_REQUIRED', 'MEDIA_GRANT_SECRET_REQUIRED', 'IMPORT_AUTH_CONFIGURATION_REQUIRED',
  // Local rendering scripts only.
  'CAROUSEL_VERDICT_MUST_STAY_STATIC', 'COLLAGE_INVALID_ASSET_COUNT', 'COLLAGE_TEXT_OR_ASSETS_INVALID',
]);

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await files(path));
    else if (/\.(m?js|ts)$/.test(entry.name)) out.push(path); // .tsx is browser code with its own messages
  }
  return out;
}

test('every error code thrown on the server has an HTTP status in one of the API maps', async () => {
  const root = new URL('../src', import.meta.url).pathname;
  const thrown = new Map();
  for (const file of await files(root)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:new\s+)?Error\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) thrown.set(match[1], file.slice(root.length + 1));
  }
  const maps = await Promise.all(['access/publication-http.ts', 'access/analysis-http.ts', 'http/editorial-workflow.mjs']
    .map(name => readFile(`${root}/${name}`, 'utf8')));
  const mapped = code => maps.some(text => new RegExp(`\\b${code}\\s*:`).test(text));
  const missing = [...thrown].filter(([code]) => !mapped(code) && !handledElsewhere.has(code)).map(([code, file]) => `${code} (${file})`);
  assert.deepEqual(missing, [], 'add these codes to a status map or to handledElsewhere with a reason');
});

test('unexpected errors are logged with a request id and without credentials', () => {
  const lines = [], error = console.error;
  console.error = (...args) => lines.push(args);
  try {
    logUnexpectedError('publication', 'req-1', new TypeError('fetch http://user:p4ss@proxy.test:80/x?key=AIzaSECRETKEY123 failed, Bearer ya29.tokenvalue'));
    logUnexpectedError('analysis', 'req-2', Error('SOME_NEW_CODE'));
  } finally { console.error = error; }
  assert.equal(lines[0][0], 'API_UNEXPECTED_ERROR');
  assert.equal(lines[0][1].requestId, 'req-1');
  const text = JSON.stringify(lines);
  for (const leak of ['p4ss', 'AIzaSECRETKEY123', 'ya29.tokenvalue', 'key=']) assert.ok(!text.includes(leak), leak);
  assert.equal(lines[1][1].code, 'SOME_NEW_CODE');
  assert.equal(redactErrorText('x'.repeat(500)).length, 300);
});
