export const verdicts = ['confirmed','partially_confirmed','false','missing_context','insufficient'];
export const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function string(value, maximum, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new Error('INVALID_INPUT');
  const result = value.trim();
  if (result.length > maximum || (required && !result) || result.includes('\0')) {
    throw new Error('INVALID_INPUT');
  }
  return result;
}

export function uuid(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('INVALID_INPUT');
  return value;
}

function url(value, required) {
  const raw = string(value, 2048, required);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error();
    return parsed.href;
  } catch {
    throw new Error('INVALID_INPUT');
  }
}

function date(value, required) {
  const raw = string(value, 10, required);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(+parsed)
      || parsed.toISOString().slice(0, 10) !== raw || raw.startsWith('0000')) throw new Error('INVALID_INPUT');
  return raw;
}

export function claimInput(input) {
  const start = input.startMs;
  const end = input.endMs;
  if (!(start == null && end == null)
      && !(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start)) {
    throw new Error('INVALID_INPUT');
  }
  const verdict = string(input.verdict, 32);
  if (verdict && !verdicts.includes(verdict)) throw new Error('INVALID_INPUT');
  const evidence = input.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 12) throw new Error('INVALID_INPUT');
  return {
    transcriptId: input.transcriptId ? uuid(input.transcriptId) : null,
    content: {
      quote: string(input.quote, 12000, true),
      translation: string(input.translation, 12000),
      context: string(input.context, 12000),
      question: string(input.question, 2000, true),
      verdict,
      explanation: string(input.explanation, 12000),
      startMs: start ?? null, endMs: end ?? null,
    },
    evidence: evidence.map(source => ({
      title: string(source?.title, 500, true),
      url: url(source?.url, true),
      organization: string(source?.organization, 500),
      publicationDate: date(source?.publicationDate, false),
      accessedOn: date(source?.accessedOn, true),
      primaryUrl: url(source?.primaryUrl, false),
      locator: string(source?.locator, 3000, true),
      coverage: string(source?.coverage, 3000, true),
    })),
  };
}

export function episodeInput(input) {
  return {
    title: string(input.title, 250, true),
    script: string(input.script, 50000, true),
    description: string(input.description, 5000),
    thumbnail: string(input.thumbnail, 3000),
    captions: string(input.captions, 16000),
    subtitles: string(input.subtitles, 50000),
    pinnedComment: string(input.pinnedComment, 5000),
    fragments: string(input.fragments, 6000),
  };
}
