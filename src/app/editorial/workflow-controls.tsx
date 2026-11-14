'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { verdictLabels } from './workflow-types';
import type { Claim, Evidence, Episode, Transcript } from './workflow-types';

const messages: Record<string, string> = {
  APPROVAL_REQUIRED: "Потрібен погоджений сценарій цієї версії.",
  RELEASE_APPROVAL_REQUIRED: 'Спершу потрібен аудит Gemini та явний допуск цієї ревізії монтажу редактором.',
  PUBLICATION_CONFLICT: "Цей випуск або YouTube-ролик уже зареєстровано з іншими даними.",
  METRIC_TOO_EARLY: "Заміри доступні після завершення відповідного періоду.",
  METRIC_CONFLICT: "Заміри вже містять новіші або інші дані за цей час.",
  EPISODE_PUBLISHED: "Опублікований сценарій збережено. Для змін створіть виправлення.",
  AUTH_REQUIRED: 'Увійдіть знову.',
  FORBIDDEN: 'Для цієї дії потрібна відповідна роль.',
  SELF_APPROVAL: 'Потрібен незалежний перевіряльник.',
  REVISION_CONFLICT: 'Матеріал уже змінився. Оновіть сторінку перед повтором.',
  CLAIM_STALE: 'Твердження змінилося. Збережіть сценарій з новою погодженою версією.',
  CLAIM_NOT_APPROVED: 'Твердження має пройти перевірку.',
  REVIEW_INCOMPLETE: 'Додайте висновок, пояснення і щонайменше одне джерело.',
  INVALID_TRANSITION: 'Дія недоступна в поточному стані.',
  TRANSCRIPT_MISMATCH: 'Розшифрування належить іншому відео.',
  INVALID_INPUT: 'Перевірте заповнені поля.',
};

export function useRequest() {
  const router = useRouter();
  const [state, setState] = useState({ pending: false, message: '' });
  async function send(path: string, init: RequestInit, done?: (id: string) => void) {
    if (state.pending) return;
    setState({ pending: true, message: '' });
    try {
      const response = await fetch(path, init);
      const result = await response.json();
      if (!response.ok) throw Error(result.error?.code);
      if (done) done(result.data.id);
      else router.refresh();
      setState({ pending: false, message: 'Збережено.' });
    } catch (error) {
      setState({ pending: false, message: messages[(error as Error).message] ?? 'Запит не вдалося виконати. Перевірте введені дані та повторіть.' });
    }
  }
  return { ...state, send };
}

export function json(body: object, method = 'POST') {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
}

function Notice({ message }: { message: string }) {
  return message ? <output role="status">{message}</output> : null;
}

export function VideoForm() {
  const request = useRequest();
  const router = useRouter();
  return <form onSubmit={event => void request.send('/api/videos', json({ url: submit(event).get('url') }),
    id => router.push('/editorial/videos/'+id))}>
    <label>Посилання YouTube <input type="url" name="url" maxLength={2048} required /></label>
    <button disabled={request.pending}>Додати відео</button>
    <Notice message={request.message} />
  </form>;
}

export function YouTubeCaptionsImport({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [starting, setStarting] = useState(false);
  const path = '/api/videos/'+videoId+'/captions-import';
  const busy = status === 'queued' || status === 'running';

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(path, { signal: controller.signal });
        if (!response.ok) throw Error();
        const { data } = await response.json();
        if (controller.signal.aborted) return;
        setStatus(data.status);
        if (data.status === 'queued' || data.status === 'running') {
          timer = setTimeout(poll, 4000);
        } else if (data.status === 'done' && busy) {
          router.refresh();
        }
        setMessage(data.status === 'queued' ? 'Очікуємо на зчитувач YouTube…'
          : data.status === 'running' ? 'Зчитуємо субтитри YouTube…'
          : data.status === 'done' ? 'Розшифрування збережено · версія '+data.version
          : data.errorCode === 'NO_CAPTIONS' ? 'YouTube не повернув субтитри. Можна імпортувати файл.'
          : data.status === 'failed' ? 'Не вдалося зчитати субтитри. Повторіть або імпортуйте файл.' : '');
      } catch {
        if (!controller.signal.aborted && busy) timer = setTimeout(poll, 8000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, router, busy]);

  async function start() {
    setStarting(true);
    try {
      const response = await fetch(path, { method: 'POST' });
      if (!response.ok) throw Error();
      const { data } = await response.json();
      setStatus(data.status);
      setMessage('Запит прийнято.');
    } catch {
      setMessage('Імпорт із YouTube недоступний. Можна імпортувати файл.');
    } finally { setStarting(false); }
  }

  return <div>
    <button type="button" disabled={busy || starting} onClick={() => void start()}>Імпортувати субтитри з YouTube</button>
    <Notice message={message} />
  </div>;
}

export function TranscriptForm({ videoId }: { videoId: string }) {
  const request = useRequest();
  return <form onSubmit={event => {
    const file = submit(event).get('file') as File;
    const format = file.name.split('.').pop()?.toLowerCase() ?? '';
    void request.send('/api/videos/'+videoId+'/transcripts?format='+encodeURIComponent(format), {
      method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
    });
  }}>
    <label>Розшифрування TXT, SRT або VTT <input type="file" accept=".txt,.srt,.vtt" name="file" required /></label>
    <button disabled={request.pending}>Імпортувати файл</button>
    <Notice message={request.message} />
  </form>;
}

const claimFields = {
  quote: 'Оригінальна цитата', translation: 'Український переклад', context: 'Контекст',
  question: 'Питання для перевірки', explanation: 'Пояснення і прогалини в доказах',
};
const episodeFields = {
  title: 'Заголовок', script: 'Сценарій', description: 'Опис', thumbnail: 'Завдання для обкладинки',
  captions: 'Титри', subtitles: 'Субтитри', pinnedComment: 'Закріплений коментар',
  fragments: 'Фрагменти та обґрунтування',
};
const evidenceFields = {
  title: 'Назва', url: 'Посилання', organization: 'Автор або організація', publicationDate: 'Дата публікації',
  accessedOn: 'Дата доступу', primaryUrl: 'Первинний документ', locator: 'Сторінка або фрагмент', coverage: 'Що підтверджує',
};

function Fields({ labels, values, required }: { labels: Record<string,string>; values?: Record<string, string | number | null>; required: string[] }) {
  return Object.entries(labels).map(([name,label]) =>
    <label key={name}>{label}<textarea name={name} defaultValue={values?.[name] ?? ""} required={required.includes(name)} /></label>);
}

function EvidenceFields({ initial }: { initial: Evidence[] }) {
  const [items,setItems] = useState<{ id: number; source: Evidence | null }[]>(initial.map((source, id) => ({ id, source })));
  return <>
    {items.map(({id,source}, index) => <fieldset key={id} className="workflow-fields">
      <legend>Джерело {index+1}</legend>
      <input type="hidden" name="sourceId" value={id} />
      {Object.entries(evidenceFields).map(([key,label]) => <label key={key}>{label}
        <input name={id+'.'+key} defaultValue={source?.[key as keyof Evidence] ?? ''}
          required={['title','url','accessedOn','locator','coverage'].includes(key)}
          type={key.endsWith('Date') || key==='accessedOn' ? 'date' : ['url','primaryUrl'].includes(key) ? 'url' : 'text'} />
      </label>)}
      <button type="button" onClick={() => setItems(items.filter(item=>item.id!==id))}>Вилучити джерело</button>
    </fieldset>)}
    <button type="button" disabled={items.length>=12} onClick={() => setItems([...items,{
      id: Math.max(-1,...items.map(item=>item.id))+1, source: null,
    }])}>Додати джерело</button>
  </>;
}

function editorRequest(collection: string, item: Claim | Episode | undefined, data: object) {
  const path = '/api/'+collection+(item ? '/'+item.id : '');
  return { path, init: json(item ? {
    ...data, action:'edit', version:item.version, expectedRevision:item.revision,
  } : { ...data, action:'create' }, item ? 'PATCH' : 'POST') };
}

type DraftFields = { transcriptId?:string; quote:string; question:string; startMs:number|null; endMs:number|null };
export function ClaimForm({ videoId, transcripts, claim, draft }: {
  videoId: string; transcripts: Transcript[]; claim?: Claim; draft?: DraftFields;
}) {
  const request = useRequest();
  return <form onSubmit={event => {
    const form = submit(event);
    const number = (name: string) => form.get(name) === '' ? null : Number(form.get(name));
    const evidence = form.getAll('sourceId').map(id =>
      Object.fromEntries(Object.keys(evidenceFields).map(key => [key,form.get(id+'.'+key)])));
    const {path,init} = editorRequest('claims',claim,{
      ...Object.fromEntries(form), parentId:videoId, startMs:number('startMs'), endMs:number('endMs'), evidence,
    });
    void request.send(path,init);
  }}>
    <Fields labels={claimFields} values={claim?.content ?? draft} required={['quote','question']} />
    <label>Версія розшифрування <select name="transcriptId" defaultValue={claim?.transcript_id ?? draft?.transcriptId ?? ''}>
      <option value="">Ручна цитата</option>
      {transcripts.map(t=><option key={t.id} value={t.id}>{t.version} · {t.format.toUpperCase()}</option>)}
    </select></label>
    <label>Початок, мс <input type="number" name="startMs" min={0} defaultValue={claim?.content.startMs ?? draft?.startMs ?? ''} /></label>
    <label>Кінець, мс <input type="number" name="endMs" min={1} defaultValue={claim?.content.endMs ?? draft?.endMs ?? ''} /></label>
    <label>Висновок <select name="verdict" defaultValue={claim?.content.verdict ?? ''}>
      <option value="">Оберіть висновок</option>
      {Object.entries(verdictLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
    </select></label>
    <EvidenceFields initial={claim?.evidence ?? []} />
    <button disabled={request.pending}>{claim ? 'Зберегти нову версію' : 'Створити твердження'}</button>
    <Notice message={request.message} />
  </form>;
}

export function EpisodeForm({ claim, episode }: { claim: Claim; episode?: Episode }) {
  const request = useRequest();
  return <form onSubmit={event => {
    const {path,init}=editorRequest('episodes',episode,{
      ...Object.fromEntries(submit(event)), parentId:claim.id, claimVersion:claim.version,
    });
    void request.send(path,init);
  }}>
    <Fields labels={episodeFields} values={episode?.content} required={['title','script']} />
    <button disabled={request.pending}>{episode ? 'Зберегти нову версію сценарію' : 'Створити сценарій'}</button>
    <Notice message={request.message} />
  </form>;
}

export function Transitions({ collection, item, actions, children }: {
  collection: string; item: Claim | Episode; actions: string[]; children?: ReactNode;
}) {
  const request = useRequest();
  if (!actions.length) return null;
  const labels: Record<string,string> = { submit:'Передати на перевірку', approve:'Погодити', return:'Повернути', withdraw:'Зняти з роботи' };
  return <form onSubmit={event => {
    const form=submit(event);
    const action=String(form.get('action'));
    const review=action==='approve'||action==='return';
    void request.send('/api/'+collection+'/'+item.id+(review?'/reviews':''),json({
      action, version:item.version, expectedRevision:item.revision, comment:form.get('comment'),
    }));
  }}>
    {children}
    {actions.some(action => action!=='submit') && <label>Коментар або причина повернення <textarea name="comment" maxLength={4000} /></label>}
    <div>{actions.map(action => <button key={action} name="action" value={action} disabled={request.pending}>{labels[action]}</button>)}</div>
    <Notice message={request.message} />
  </form>;
}
