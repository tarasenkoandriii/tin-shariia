// Two separate facts about a YouTube comment, shown side by side everywhere in the editorial UI:
//  1. sending — did the YouTube API accept it (state='published', published_at set);
//  2. visibility — what the later check after a page reload saved (youtube_comment_steps), or the
//     public API lookup when it found the comment gone. Nothing here changes how comments are sent or checked.

const sendLabels = {
  queued: 'У черзі', submitting: 'Готується текст', submitted: 'Готується текст', succeeded: 'Чекає схвалення',
  scheduled: 'Заплановано', publishing: 'Відправляється', published: 'Прийнято YouTube API', failed: 'Помилка відправлення',
  rejected: 'Відхилено редактором', unknown: 'Результат відправлення невідомий',
};
const sendTones = { published: 'success', failed: 'danger', unknown: 'warning', rejected: 'neutral', succeeded: 'warning' };

export const visibilityLabels = {
  checking: 'Перевіряємо видимість',
  confirmed: 'Видимість підтверджено',
  not_confirmed: 'Видимість не підтверджено',
};
const visibilityTones = { checking: 'info', confirmed: 'success', not_confirmed: 'warning' };
const checkingPhases = new Set(['waiting_plain', 'link_ready', 'link_sending', 'waiting_link']);

export function commentStatus(row) {
  const sent = row?.state === 'published' && Boolean(row.published_at);
  const send = { sent, at: sent ? row.published_at : null, label: sendLabels[row?.state] ?? 'Стан невідомий', tone: sendTones[row?.state] ?? 'neutral' };
  if (!sent) return { send, visibility: null };
  const phase = row.publication_steps?.phase ?? null;
  const gone = row.public_visibility?.code === 'YOUTUBE_COMMENT_NOT_VISIBLE';
  let value, reason;
  if (gone) { value = 'not_confirmed'; reason = 'Публічний API YouTube не знайшов коментар'; }
  else if (phase === 'verified') { value = 'confirmed'; reason = 'Перевірено після перезавантаження сторінки'; }
  else if (phase === 'blocked') { value = 'not_confirmed'; reason = 'Після перезавантаження коментар не знайдено'; }
  else if (checkingPhases.has(phase)) {
    value = 'checking';
    reason = phase === 'waiting_plain' ? 'Чекаємо перевірки тексту після перезавантаження'
      : phase === 'waiting_link' ? 'Чекаємо перевірки посилання після перезавантаження' : 'Додаємо схвалене посилання';
  } else {
    value = 'not_confirmed';
    reason = row.public_visibility?.code === 'OK'
      ? 'Публічний API повертає коментар; перевірки після перезавантаження не було'
      : 'Перевірки після перезавантаження не було';
  }
  const checkedAt = phase === 'verified' ? (row.publication_steps?.linked_verified_at ?? row.publication_steps?.checked_at ?? null)
    : (row.publication_steps?.checked_at ?? row.public_visibility?.checkedAt ?? null);
  return { send, visibility: { value, label: visibilityLabels[value], tone: visibilityTones[value], reason, checkedAt } };
}
