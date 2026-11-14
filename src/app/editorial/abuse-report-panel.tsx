'use client';

import { useState } from 'react';

type Reason = { id: string; label: string; secondary: { id: string; label: string }[] };
type Missing = { code: string; message: string };
type Basis = { label: string; hint: string; url: string };
type Report = {
  id: string; state: 'draft'|'confirmed'|'sending'|'accepted'|'rejected'|'unknown'; revision: number; claimVersion: number;
  policyBasis: string; policyNote: string; comments: string; reasonId: string|null; secondaryReasonId: string|null; reasonLabel: string;
  confirmationHash: string|null; sentAt: string|null; httpStatus: number|null; errorCode: string|null;
  sourceChannelTitle: string; sourceChannelId: string|null;
};
type Data = {
  report: Report|null; missing: Missing[]; policyBases: Record<string,Basis>; proposedComments: string; canEdit: boolean; canSend: boolean;
  source: { youtubeId: string; url: string; timecode: string|null; quote: string; verdictLabel: string; claimVersion: number };
  evidence: { title: string; url: string; organization: string; publicationDate: string|null }[];
  account: { channelId: string; channelTitle: string; hasScope: boolean }|null;
};

const stateLabels: Record<Report['state'],string> = {
  draft:'Чернетка', confirmed:'Підтверджено редактором — можна надіслати', sending:'Надсилається…',
  accepted:'Скаргу прийнято YouTube', rejected:'YouTube відхилив скаргу', unknown:'Потрібна ручна перевірка',
};
const messages: Record<string,string> = {
  FORBIDDEN:'Потрібні права редактора.', CLAIM_NOT_APPROVED:'Фактчек ще не затверджено.',
  ABUSE_REPORT_NOT_ELIGIBLE:'Висновок фактчеку не вказує на хибний чи оманливий зміст.',
  ABUSE_REPORT_INCOMPLETE:'Бракує матеріалів — див. список вище.', ABUSE_REPORT_CHANGED:'Чернетка змінилася. Перевірте її й підтвердьте ще раз.',
  ABUSE_REPORT_CONFIRMATION_REQUIRED:'Спершу підтвердьте ролик, категорію й текст.',
  ABUSE_REPORT_CONFIRMATION_STALE:'Після підтвердження змінилися дані. Підтвердьте скаргу ще раз.',
  ABUSE_REPORT_IN_PROGRESS:'Скарга вже надсилається.', ABUSE_REPORT_ALREADY_SENT:'На це відео вже надіслано скаргу від цього акаунта.',
  ABUSE_REPORT_MANUAL_CHECK:'Результат попередньої спроби невідомий. Автоматичний повтор заблоковано.',
  ABUSE_REASON_INVALID:'Категорії немає в чинному списку YouTube. Виберіть іншу й підтвердьте ще раз.',
  YOUTUBE_CHANNEL_NOT_CONNECTED:'Не підключено канал YouTube.', YOUTUBE_ABUSE_SCOPE_REQUIRED:'Підключення не має дозволу youtube.force-ssl. Перепідключіть канал.',
  YOUTUBE_ABUSE_AUTH_FAILED:'Google не прийняв токен підключення. Перепідключіть канал.', YOUTUBE_TOKEN_REFRESH_REVOKED:'Google відкликав дозвіл. Перепідключіть канал.',
  YOUTUBE_ABUSE_REASONS_UNAVAILABLE:'Не вдалося завантажити категорії YouTube. Спробуйте пізніше.',
  YOUTUBE_ABUSE_INVALID_REASON:'YouTube не прийняв категорію. Виберіть чинну й підтвердьте ще раз.',
  YOUTUBE_ABUSE_RATE_LIMIT:'Перевищено ліміт запитів YouTube. Спробуйте пізніше з новим підтвердженням.',
  YOUTUBE_ABUSE_VIDEO_NOT_FOUND:'YouTube не знайшов відео: його видалено, приховано або ID неправильний.',
  YOUTUBE_ABUSE_FORBIDDEN:'YouTube заборонив цьому акаунту надсилати скаргу.',
  YOUTUBE_ABUSE_OUTCOME_UNKNOWN:'Запит міг дійти до YouTube, але відповіді немає. Перевірте вручну; автоматичний повтор заблоковано.',
  YOUTUBE_ABUSE_RESPONSE_UNEXPECTED:'YouTube відповів не 204. Перевірте вручну; автоматичний повтор заблоковано.',
};
const say = (code?: string|null) => (code && messages[code]) ?? 'Запит не вдався. Перевірте дані й повторіть.';

async function call(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache:'no-store', ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Error(body?.error?.code ?? 'REQUEST_FAILED');
  return body.data;
}
const send = (body: object, method = 'POST') => ({ method, headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });

// Draft of a YouTube abuse report. Nothing is sent until an editor confirms and presses «Надіслати скаргу».
export function AbuseReportPanel({ claimId }: { claimId: string }) {
  const [data, setData] = useState<Data>();
  const [reasons, setReasons] = useState<Reason[]>();
  const [form, setForm] = useState({ policyBasis:'', policyNote:'', comments:'', reasonId:'', secondaryReasonId:'' });
  const [dirty, setDirty] = useState(false);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  function apply(next: Data) {
    setData(next); setDirty(false); setChecked(false);
    const r = next.report;
    setForm({ policyBasis:r?.policyBasis ?? '', policyNote:r?.policyNote ?? '', comments:r?.comments || next.proposedComments,
      reasonId:r?.reasonId ?? '', secondaryReasonId:r?.secondaryReasonId ?? '' });
  }
  async function run(work: () => Promise<void>) {
    if (pending) return;
    setPending(true); setMessage('');
    try { await work(); } catch (error) { setMessage(say((error as Error).message)); } finally { setPending(false); }
  }
  const load = () => run(async () => {
    apply(await call(`/api/claims/${claimId}/abuse-report`));
    try { setReasons(await call('/api/youtube/abuse-reasons')); } catch (error) { setReasons([]); setMessage(say((error as Error).message)); }
  });
  const edit = (key: keyof typeof form, value: string) => {
    setForm(f => ({ ...f, [key]:value, ...(key==='reasonId' ? { secondaryReasonId:'' } : {}) })); setDirty(true); setChecked(false);
  };
  const save = () => run(async () => {
    apply(await call(`/api/claims/${claimId}/abuse-report`, send({ ...form, reasonId:form.reasonId || null,
      secondaryReasonId:form.secondaryReasonId || null, expectedRevision:data?.report?.revision }, 'PUT')));
    setMessage('Чернетку збережено. Підтвердження, якщо було, скасовано.');
  });
  const confirm = () => run(async () => {
    const r = data!.report!;
    await call(`/api/abuse-reports/${r.id}`, send({ action:'confirm', confirmed:true, revision:r.revision, sourceYoutubeId:data!.source.youtubeId,
      claimVersion:r.claimVersion, reasonId:r.reasonId, secondaryReasonId:r.secondaryReasonId, comments:r.comments }));
    apply(await call(`/api/claims/${claimId}/abuse-report`));
    setMessage('Підтверджено. Тепер можна натиснути «Надіслати скаргу».');
  });
  const submit = () => run(async () => {
    const r = data!.report!;
    const result = await call(`/api/abuse-reports/${r.id}`, send({ action:'send', confirmationHash:r.confirmationHash }));
    apply(await call(`/api/claims/${claimId}/abuse-report`));
    setMessage(result.state==='accepted' ? 'Скаргу прийнято YouTube. Рішення щодо відео приймає YouTube.' : say(result.code));
  });

  const report = data?.report, basis = data?.policyBases[form.policyBasis];
  const reason = reasons?.find(item => item.id === form.reasonId);
  const locked = report && ['sending','accepted','unknown'].includes(report.state);
  return <details className="workflow-card" onToggle={event => { if ((event.target as HTMLDetailsElement).open && !data) void load(); }}>
    <summary>Скарга в YouTube за результатами фактчеку</summary>
    {!data ? <p>{pending ? 'Завантаження…' : message}</p> : <>
      <p>Скаргу надсилає лише редактор кнопкою «Надіслати скаргу». Рішення щодо відео приймає YouTube.</p>
      <dl className="abuse-report-facts">
        <dt>Відео</dt><dd><a href={data.source.url} target="_blank" rel="noreferrer">{data.source.youtubeId}</a>{data.source.timecode && <> · {data.source.timecode}</>}</dd>
        <dt>Канал джерела</dt><dd>{report?.sourceChannelTitle || 'Визначиться після збереження чернетки'}</dd>
        <dt>Цитата</dt><dd><blockquote>{data.source.quote}</blockquote></dd>
        <dt>Фактчек</dt><dd>{data.source.verdictLabel || '—'} · версія {data.source.claimVersion}</dd>
        <dt>Джерела фактчеку</dt><dd><ul>{data.evidence.map(e => <li key={e.url}><a href={e.url} target="_blank" rel="noreferrer">{e.title}</a>
          {e.organization && ` · ${e.organization}`}{e.publicationDate && ` · ${e.publicationDate}`}</li>)}</ul></dd>
        <dt>Від акаунта</dt><dd>{data.account ? `${data.account.channelTitle}${data.account.hasScope ? '' : ' (немає дозволу youtube.force-ssl)'}` : 'Канал YouTube не підключено'}</dd>
        {report && <><dt>Стан</dt><dd>{stateLabels[report.state]}{report.httpStatus ? ` · HTTP ${report.httpStatus}` : ''}{report.errorCode ? ` · ${say(report.errorCode)}` : ''}</dd></>}
      </dl>
      {data.missing.length > 0 && <div role="status"><p>Чого бракує для підтвердження:</p><ul>{data.missing.map(item => <li key={item.code}>{item.message}</li>)}</ul></div>}
      {data.canEdit && !locked && <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>Можлива підстава — правило YouTube
          <select id={`abuse-basis-${claimId}`} value={form.policyBasis} onChange={e => edit('policyBasis', e.target.value)}>
            <option value="">Оберіть правило</option>
            {Object.entries(data.policyBases).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
          </select></label>
        {basis && <p>{basis.hint} <a href={basis.url} target="_blank" rel="noreferrer">Правило YouTube</a></p>}
        <label>Яку вимогу правила порушує цитата
          <textarea id={`abuse-note-${claimId}`} value={form.policyNote} maxLength={2000} onChange={e => edit('policyNote', e.target.value)} /></label>
        <label>Категорія YouTube
          <select id={`abuse-reason-${claimId}`} value={form.reasonId} onChange={e => edit('reasonId', e.target.value)} disabled={!reasons?.length}>
            <option value="">{reasons ? (reasons.length ? 'Оберіть категорію' : 'Категорії недоступні') : 'Завантаження…'}</option>
            {reasons?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
        {reason && reason.secondary.length > 0 && <label>Підкатегорія
          <select id={`abuse-secondary-${claimId}`} value={form.secondaryReasonId} onChange={e => edit('secondaryReasonId', e.target.value)}>
            <option value="">Без підкатегорії</option>
            {reason.secondary.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>}
        <label>Текст скарги
          <textarea id={`abuse-comments-${claimId}`} value={form.comments} maxLength={3000} rows={10} onChange={e => edit('comments', e.target.value)} /></label>
        <button type="button" disabled={pending} onClick={() => edit('comments', data.proposedComments)}>Оновити текст із матеріалів</button>
        <button disabled={pending}>Зберегти чернетку</button>
      </form>}
      {data.canSend && report && !locked && <div>
        {report.state !== 'confirmed' && <>
          <label><input type="checkbox" checked={checked} disabled={dirty} onChange={e => setChecked(e.target.checked)} />
            {' '}Я перевірив ролик {data.source.youtubeId}, категорію «{reasons?.find(item => item.id===report.reasonId)?.label ?? report.reasonId ?? '—'}» і остаточний текст скарги.</label>
          {dirty && <p>Збережіть зміни, щоб підтвердити саме цей текст.</p>}
          <button type="button" disabled={pending || dirty || !checked || data.missing.length > 0} onClick={() => void confirm()}>Підтвердити</button>
        </>}
        {report.state === 'confirmed' && <button type="button" disabled={pending || dirty} onClick={() => void submit()}>
          {pending ? 'Надсилаємо…' : 'Надіслати скаргу'}</button>}
      </div>}
      {message && <p role="alert">{message}</p>}
    </>}
  </details>;
}
