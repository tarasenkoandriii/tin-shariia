import { createHash } from 'node:crypto';

const maxBytes = 2 * 1024 * 1024;

function timestamp(value, format) {
  const pattern = format === 'srt'
    ? /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/
    : /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
  const parts = pattern.exec(value);
  if (!parts) throw new Error('INVALID_TIMECODE');
  const ms = ((Number(parts[1] ?? 0) * 60 + Number(parts[2])) * 60
    + Number(parts[3])) * 1000 + Number(parts[4]);
  if (!Number.isSafeInteger(ms)) throw new Error('INVALID_TIMECODE');
  return ms;
}

export function parseTranscript(bytes, format, durationMs = Infinity) {
  if (!(bytes instanceof Uint8Array)) throw new Error('INVALID_INPUT');
  if (bytes.byteLength > maxBytes) throw new Error('TRANSCRIPT_TOO_LARGE');
  if (!['txt', 'srt', 'vtt'].includes(format)) throw new Error('UNSUPPORTED_FORMAT');
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      .replace(/\r\n?/g, '\n').trim();
  } catch {
    throw new Error('INVALID_UTF8');
  }
  if (!content || content.includes('\0')) throw new Error('INVALID_TRANSCRIPT');

  let segments = [{ startMs: null, endMs: null, text: content }];
  if (format !== 'txt') {
    const blocks = content.split(/\n[ \t]*\n+/);
    if (format === 'vtt' && !/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(blocks.shift() ?? '')) {
      throw new Error('INVALID_VTT_HEADER');
    }
    segments = [];
    for (const block of blocks) {
      const lines = block.split('\n');
      if (format === 'vtt' && /^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0])) continue;
      if (!lines[0].includes('-->')) {
        if (format === 'srt' && !/^\d+$/.test(lines[0])) throw new Error('INVALID_CUE');
        lines.shift();
      }
      const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)([ \t]+.*)?$/.exec(lines.shift() ?? '');
      const text = lines.join('\n').trim();
      if (!timing || !text || (format === 'srt' && timing[3])) throw new Error('INVALID_CUE');
      const startMs = timestamp(timing[1], format);
      const endMs = timestamp(timing[2], format);
      if (endMs <= startMs || endMs > durationMs || startMs < (segments.at(-1)?.startMs ?? 0)) {
        throw new Error('INVALID_CUE_INTERVAL');
      }
      segments.push({ startMs, endMs, text });
    }
    if (!segments.length) throw new Error('EMPTY_TRANSCRIPT');
  }

  return {
    segments,
    hash: createHash('sha256').update(JSON.stringify(segments)).digest('hex'),
  };
}
