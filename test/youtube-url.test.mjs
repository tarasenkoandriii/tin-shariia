import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYouTubeUrl } from '../src/editorial/youtube-url.mjs';

const id = 'CXH9VMko19s';

test('watch, share, Shorts and live links have the same canonical identity', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${id}&t=10`,
    `https://youtu.be/${id}?si=example`,
    `https://youtube.com/shorts/${id}`,
    `https://m.youtube.com/live/${id}/`,
  ]) {
    assert.deepEqual(parseYouTubeUrl(url), {
      youtubeId: id,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    });
  }
});

test('rejects other hosts, credentials, ambiguous identifiers and unsupported paths', () => {
  for (const url of [
    `https://youtube.com.example.org/watch?v=${id}`,
    `https://user@youtube.com/watch?v=${id}`,
    `http://youtube.com/watch?v=${id}`,
    `https://youtube.com:8443/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&v=${id}`,
    `https://youtube.com/embed/${id}`,
    'https://youtu.be/invalid',
    '',
  ]) {
    assert.equal(parseYouTubeUrl(url), null, url);
  }
});
