import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTranscript } from '../src/editorial/transcript.mjs';

const parse = (content, format, duration) =>
  parseTranscript(Buffer.from(content), format, duration);

test('SRT and VTT normalize equivalent cues to the same fingerprint', () => {
  const srt = parse('\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nЦитата', 'srt');
  const vtt = parse('WEBVTT\n\nNOTE annotation\n\ncue\n00:01.000 --> 00:02.500 align:start\nЦитата', 'vtt');
  assert.deepEqual(srt, vtt);
  assert.deepEqual(srt.segments, [{ startMs: 1000, endMs: 2500, text: 'Цитата' }]);
});

test('TXT has no fabricated timing', () => {
  assert.deepEqual(parse('Цитата', 'txt').segments, [
    { startMs: null, endMs: null, text: 'Цитата' },
  ]);
});

test('rejects invalid intervals, missing headers, invalid UTF-8 and oversized imports', () => {
  assert.throws(() => parse('00:00:02,000 --> 00:00:01,000\nТекст', 'srt'), /INVALID_CUE_INTERVAL/);
  assert.throws(() => parse('00:00:01,000 --> 00:00:02,000\nТекст', 'srt', 1500), /INVALID_CUE_INTERVAL/);
  assert.throws(() => parse('00:01.000 --> 00:02.000\nТекст', 'vtt'), /INVALID_VTT_HEADER/);
  assert.throws(() => parseTranscript(Uint8Array.of(255), 'txt'), /INVALID_UTF8/);
  assert.throws(() => parseTranscript(Buffer.alloc(2 * 1024 * 1024 + 1), 'txt'), /TRANSCRIPT_TOO_LARGE/);
});
