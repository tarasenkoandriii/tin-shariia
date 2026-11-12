'use client';

import { useRef, useState, type FormEvent } from 'react';

type Proposal = {
  source: { url: string; start: number };
  manifest: null | { hook: string; title: string; description: string; clips: {startMs: number; endMs: number}[] };
  reasons: string[];
  narrationUk?: string;
  spentMicros: number;
};

const time = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
};

export function YouTubeShortProposal() {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [proposal,setProposal] = useState<Proposal | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const url = String(form.get('url')).trim();
    const startSeconds = Number(form.get('startSeconds'));
    const key = JSON.stringify([url,startSeconds]);
    if (request.current?.key !== key) request.current = {key,id:crypto.randomUUID()};
    setBusy(true);
    setError('');
    setProposal(null);
    try {
      const response = await fetch('/api/youtube/short-proposal',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({url,startSeconds,requestId:request.current.id}),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error?.code ?? 'SHORTS_PROPOSAL_UNKNOWN');
      setProposal(body.data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'SHORTS_PROPOSAL_UNKNOWN');
    } finally { setBusy(false); }
  }

  return <section className="workflow-card">
    <h2>Фрагмент YouTube для Shorts</h2>
    <p>Gemini аналізує до 45 секунд публічного відео й пропонує фрагменти загальною тривалістю 30–45 секунд.</p>
    <form onSubmit={submit}>
      <label>Посилання YouTube <input name="url" type="url" required placeholder="https://www.youtube.com/watch?v=…" /></label>
      <label>Початок, секунди <input name="startSeconds" type="number" min="0" max="86400" step="1" defaultValue="0" required /></label>
      <button disabled={busy}>{busy ? 'Аналізуємо…' : 'Проаналізувати фрагмент'}</button>
    </form>
    {error && <p role="alert">Не вдалося отримати план ({error}).</p>}
    {proposal && <div aria-live="polite">
      {proposal.manifest ? <>
        <h3>{proposal.manifest.title}</h3>
        <p>{proposal.manifest.hook}</p>
        <p>{proposal.manifest.description}</p>
        {proposal.narrationUk && <><h4>Текст для озвучення</h4><p>{proposal.narrationUk}</p></>}
        <ol>{proposal.manifest.clips.map((clip,index) => <li key={clip.startMs}>
          <a href={proposal.source.url + '&t=' + Math.floor(clip.startMs / 1000)} target="_blank" rel="noreferrer">
            {time(clip.startMs)}–{time(clip.endMs)}
          </a> · {proposal.reasons[index]}
        </li>)}</ol>
      </> : <p>У цьому фрагменті Gemini не знайшов самодостатнього уривка.</p>}
      <p>Витрати за даними Gemini: ${(proposal.spentMicros / 1_000_000).toFixed(4)}</p>
    </div>}
  </section>;
}
