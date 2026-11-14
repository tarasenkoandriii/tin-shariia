'use client';

import { useState } from 'react';

type Step = { source: string; reason: string | null; note: string | null };
type Result = {
  youtubeId: string; status: 'available'|'proxy_auth'|'login_required'|'no_track'|'network'|'unavailable';
  via: string; proxy: string | null; reason?: string; language?: string; automatic?: boolean; segments?: number;
  steps: Step[]; proxyFailures: { status: number | null; codes: string[] }[];
};

const route = (result: Result) => result.proxy ? `через проксі ${result.proxy}` : result.via === 'direct' ? 'напряму з сервера' : result.via;
const stepLine = (step: Step) => `${step.source}: ${step.reason ?? '—'}${step.note ? ` («${step.note}»)` : ''}`;

function summary(result: Result): string {
  switch (result.status) {
    case 'available':
      return `Субтитри доступні: мова ${result.language}, ${result.automatic ? 'автоматичні' : 'ручні (авторські)'}, `
        + `${result.segments} фрагментів. Маршрут: ${route(result)}.`;
    case 'proxy_auth':
      return `Проксі ${result.proxy ?? ''} відхилив облікові дані (HTTP 407). Запити пішли напряму. `
        + 'Перевірте YOUTUBE_CAPTIONS_PROXY_URL або WEBSHARE_PROXY_* у Vercel.';
    case 'login_required':
      return `YouTube вимагає вхід (LOGIN_REQUIRED). Маршрут: ${route(result)}. `
        + 'Одна така відповідь ще не означає, що IP заблоковано: повторіть перевірку пізніше або з іншим проксі.';
    case 'no_track':
      return `YouTube не віддав доріжку субтитрів для цього ролику. Маршрут: ${route(result)}.`;
    case 'network':
      return `Мережева помилка під час запиту до YouTube. Маршрут: ${route(result)}. Спробуйте ще раз.`;
    default:
      return `Субтитри недоступні (${result.reason}). Маршрут: ${route(result)}. Ролик може бути закритий у країні проксі.`;
  }
}

// Checks only whether YouTube serves captions — no Gemini, no budget, no analysis job, no transcript import.
export function CaptionsCheckPanel({ videoId }: { videoId: string }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState('');
  async function check() {
    if (pending) return;
    setPending(true); setError(''); setResult(undefined);
    try {
      const response = await fetch(`/api/videos/${videoId}/captions-check`, { method:'POST', cache:'no-store' });
      const body = await response.json();
      if (!response.ok) throw Error(body.error?.code ?? 'CHECK_FAILED');
      setResult(body.data);
    } catch (cause) {
      const code = (cause as Error).message;
      setError(code === 'FORBIDDEN' ? 'Потрібен редакторський доступ.' : code === 'NOT_FOUND' ? 'Ролик не знайдено.' : `Не вдалося перевірити (${code}).`);
    } finally { setPending(false); }
  }
  return <section className="workflow-card" aria-labelledby="captions-check-title">
    <h3 id="captions-check-title">Субтитри YouTube</h3>
    <p>Перевірка лише читає YouTube: не викликає Gemini, не витрачає бюджет і не створює завдань.</p>
    <button type="button" disabled={pending} onClick={() => void check()}>
      {pending ? 'Перевіряємо…' : 'Перевірити субтитри YouTube'}
    </button>
    {error && <p role="alert">{error}</p>}
    {result && <div role="status">
      <p>{summary(result)}</p>
      {result.status !== 'available' && <ul>{result.steps.map(step => <li key={step.source}>{stepLine(step)}</li>)}</ul>}
      {result.proxyFailures.length > 0 && <p>Відмови проксі: {result.proxyFailures.map(f => `HTTP ${f.status ?? '—'}${f.codes.length ? ` (${f.codes.join(', ')})` : ''}`).join('; ')}.</p>}
      {result.status === 'available' && <p>Щоб використати їх, натисніть «Проаналізувати весь ролик через Gemini» з позначкою «Спершу спробувати субтитри YouTube» або імпортуйте файл розшифрування вручну.</p>}
    </div>}
  </section>;
}
