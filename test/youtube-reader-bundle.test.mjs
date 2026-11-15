import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const bundle = JSON.parse(await readFile(`${root}services/youtube-reader/bundle.json`, 'utf8'));
const compose = await readFile(`${root}services/youtube-reader/compose.yml`, 'utf8');
const mounts = [...compose.matchAll(/^\s*-\s*\.\/([\w.-]+):(\/[\w./-]+)(?::ro)?\s*$/gm)].map(m => ({name: m[1], target: m[2]}));

test('every file the reader compose mounts is shipped by the deploy bundle and exists in the repository', async () => {
  const fileMounts = mounts.filter(m => m.name !== 'profile');
  assert.ok(fileMounts.some(m => m.target === '/reader/capture-quote.cjs'), 'capture script must be mounted');
  for (const {name} of fileMounts) {
    assert.ok(bundle.files[name], `${name} is mounted but not in bundle.json — Docker would create an empty directory instead`);
    await access(`${root}${bundle.files[name]}`);
  }
  for (const source of Object.values(bundle.files)) await access(`${root}${source}`);
});

test('every relative import in the shipped reader files is shipped too', async () => {
  for (const [name, source] of Object.entries(bundle.files)) {
    if (!/\.(m?js|cjs)$/.test(name)) continue;
    const text = await readFile(`${root}${source}`, 'utf8');
    for (const [, spec] of text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.\/[^'"]+)['"]/g))
      assert.ok(bundle.files[spec.slice(2)], `${name} imports ${spec}, which is not deployed`);
  }
});

test('the files the deploy checks inside the container are all mounted', () => {
  for (const path of bundle.mustExistInContainer) assert.ok(mounts.some(m => m.target === path), path);
});

test('the quote script names the missing capture file instead of a generic failure', async () => {
  const text = await readFile(`${root}scripts/fetch-editorial-quote.mjs`, 'utf8');
  assert.match(text, /QUOTE_READER_SCRIPT_MISSING/);
  assert.ok(text.includes(bundle.container));
});
