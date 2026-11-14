'use client';

import { useEffect, useRef, useState } from 'react';

// React blocks javascript: URLs in JSX, so the bookmarklet link gets its href directly on the DOM node.
export function CaptionsBookmarklet({ href, youtubeId }: { href: string; youtubeId: string }) {
  const link = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState('');
  useEffect(() => { link.current?.setAttribute('href', href); }, [href]);
  async function copy() {
    try { await navigator.clipboard.writeText(href); setCopied('Код закладки скопійовано.'); }
    catch { setCopied('Не вдалося скопіювати — перетягніть кнопку на панель закладок.'); }
  }
  return <details>
    <summary>Субтитри з браузера редакції (без проксі й Gemini)</summary>
    <ol>
      <li>Один раз перетягніть кнопку{' '}
        <a ref={link} className="button" draggable onClick={event => event.preventDefault()}>Субтитри YouTube → SRT</a>
        {' '}на панель закладок браузера (або <button type="button" onClick={() => void copy()}>скопіюйте код</button> у нову закладку).
        {copied && <span role="status"> {copied}</span>}</li>
      <li>Відкрийте <a href={'https://www.youtube.com/watch?v=' + youtubeId} target="_blank" rel="noreferrer">ролик на YouTube</a>,
        за потреби увімкніть субтитри (CC) і натисніть закладку. Браузер збереже файл <code>{youtubeId}-мова.srt</code>.</li>
      <li>Перевірте, що назва файлу починається з <code>{youtubeId}</code>, та імпортуйте його формою «Розшифрування» вище.</li>
    </ol>
    <p>Закладка працює лише на youtube.com у вашому браузері: бере субтитри, які вже завантажив плеєр, або відкриту панель
      «Показати транскрипцію». Нічого не надсилає на сервер редакції.</p>
    <p>Ролики офіційного каналу закриті для українських IP: з Києва YouTube відповідає «Відео недоступне». Перед
      натисканням закладки увімкніть у браузері VPN з виходом за межами України й оновіть сторінку ролика.</p>
  </details>;
}
