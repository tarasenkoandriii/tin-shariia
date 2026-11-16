// Pure helpers for the project journal (/editorial/logs): what kind of record a row is and where the
// editor should go next. Rows come from loadProjectLog (src/db/project-log.mjs); only
// process, state, key, level, linked_video_id and episode_id are read here.

const attentionStates = ['failed', 'blocked', 'unknown', 'expired', 'rejected', 'return', 'disconnected', 'report_rejected', 'report_unknown'];
const safeId = /^[A-Za-z0-9-]{1,64}$/;

const recordTypes = [
  ['comment-event:', 'Дія з коментарем'],
  ['comment:', 'Стан коментаря'],
  ['visibility:', 'Перевірка видимості'],
  ['upload-event:', 'Дія публікації'],
  ['upload:', 'Завантаження на YouTube'],
  ['render:', 'Рендер Shorts'],
  ['media:', 'Файл монтажу'],
  ['captions:', 'Імпорт субтитрів'],
  ['gemini:', 'Завдання Gemini'],
  ['grok:', 'Рецензія Grok'],
  ['editorial:', 'Редакційна дія'],
  ['link:', 'Коротке посилання'],
  ['report-event:', 'Дія зі скаргою'],
  ['report:', 'Скарга YouTube'],
];

/** Human name of the record type behind a journal key, e.g. 'visibility:<id>' → «Перевірка видимості». */
export function logRecordType(key) {
  const value = String(key ?? '');
  return recordTypes.find(([prefix]) => value.startsWith(prefix))?.[1] ?? null;
}

function idAfter(key, prefix) {
  const id = String(key ?? '').slice(prefix.length);
  return safeId.test(id) ? id : null;
}

function needsAttention(row) {
  if (row.level === 'error' || row.level === 'warning') return true;
  return attentionStates.includes(row.state);
}

/**
 * Next available action for a journal row: { label, href } or null when there is nowhere useful to go.
 * Links only point at pages and in-page anchors; the target page keeps its own permission checks.
 */
export function nextLogAction(row) {
  const key = String(row?.key ?? '');
  const process = row?.process;

  if (key.startsWith('comment-event:')) {
    // Event keys carry the event id, not the comment id.
    return { label: 'Відкрити коментарі', href: '/editorial/youtube-comments#visibility' };
  }
  for (const prefix of ['comment:', 'visibility:']) {
    if (key.startsWith(prefix)) {
      const id = idAfter(key, prefix);
      return { label: 'Відкрити коментар', href: '/editorial/youtube-comments' + (id ? '#comment-' + id : '#visibility') };
    }
  }
  if (process === 'links' || key.startsWith('link:')) return { label: 'Відкрити коментарі', href: '/editorial/youtube-comments' };
  if (process === 'comments') return { label: 'Відкрити коментарі', href: '/editorial/youtube-comments' };

  const videoId = typeof row?.linked_video_id === 'string' && safeId.test(row.linked_video_id) ? row.linked_video_id : null;
  if (!videoId) return null;
  const card = '/editorial/videos/' + videoId;
  const episodeId = typeof row?.episode_id === 'string' && safeId.test(row.episode_id) ? row.episode_id : null;
  const episode = (part) => card + (episodeId ? '#episode-' + episodeId + (part ? '-' + part : '') : '');
  const attention = needsAttention(row);

  switch (process) {
    case 'captions':
      return attention
        ? { label: 'Імпортувати субтитри знову', href: card + '#transcripts' }
        : { label: 'Відкрити картку', href: card + '#transcripts' };
    case 'gemini':
      return { label: attention ? 'Перевірити аналіз' : 'Відкрити аналіз', href: card + '#analysis' };
    case 'grok':
      return { label: attention ? 'Перевірити рецензію Grok' : 'Відкрити картку', href: episode('grok') };
    case 'render': {
      const shorts = key.startsWith('render:');
      return { label: attention ? (shorts ? 'Перевірити Shorts' : 'Перевірити монтаж') : 'Відкрити картку',
        href: episode(shorts ? 'shorts' : 'montage') };
    }
    case 'upload':
      return { label: attention ? 'Перевірити публікацію' : 'Відкрити картку', href: episode('publication') };
    case 'reports':
      // The abuse-report form sits inside the approved claim on the video card.
      return { label: attention ? 'Перевірити скаргу' : 'Відкрити скаргу', href: card + '#claims' };
    case 'editorial':
      return { label: attention ? 'Доопрацювати в картці' : 'Відкрити картку', href: episodeId ? episode('') : card + '#claims' };
    default:
      return { label: 'Відкрити картку', href: card };
  }
}
