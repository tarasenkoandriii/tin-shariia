import Link from 'next/link';
import { redirect } from 'next/navigation';
import { clerkId } from '../../../access/session';
import { activeMember } from '../../../access/membership.mjs';
import { database } from '../../../db/runtime.mjs';
import { loadProjectLog, logProcesses } from '../../../db/project-log.mjs';
import { logRecordType, nextLogAction } from '../../../editorial/log-actions.mjs';
import { Badge, Empty, PageHeader, type Tone } from '../ui';
import { LogRefresh } from './refresh';
import './style.css';

export const dynamic = 'force-dynamic';

type Row = {
  key: string; process: string; state: string; time: string; linked_video_id: string | null; episode_id?: string | null;
  title: string; youtube_id: string | null; level: string; kind: string; message: string;
  error_code: string | null; explanation: string | null; details: Record<string, string | number | null> | null;
};
const detailLabels: Record<string, string> = {
  sourceYoutubeId: 'Вихідне відео', claimVersion: 'Версія фактчеку', reasonId: 'Категорія', secondaryReasonId: 'Підкатегорія',
  reasonLabel: 'Назва категорії', approvedBy: 'Схвалив', actor: 'Виконав', sentAt: 'Надіслано', httpStatus: 'Відповідь YouTube',
  reporterChannelId: 'Канал скаржника',
};
const levels: Record<string, string> = { error: 'Помилка', warning: 'Потрібна увага', active: 'У роботі', success: 'Успішно / інформація' };
const tones: Record<string, Tone> = { error: 'danger', warning: 'warning', active: 'active', success: 'success' };
const fallbackExplanation = 'Відкрийте картку для подробиць; перед повторною відправкою перевірте результат попередньої спроби.';
const kyivSeconds = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Kyiv' });

export default async function ProjectLogs({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await clerkId(); if (!identity) redirect('/sign-in');
  const db = await database(), member = await activeMember(db, identity); if (!member?.roles.includes('admin')) redirect('/editorial');
  const data = await loadProjectLog(db, identity, await searchParams), f = data.filters;
  // Every filter travels with the page number, so pagination never drops the current selection.
  const pageLink = (page: number) => {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(f)) { if (value && key !== 'page') p.set(key, String(value)); }
    p.set('page', String(page));
    return '/editorial/logs?' + p;
  };
  // Remount the (uncontrolled) filter form whenever the applied filters change, e.g. after «Скинути».
  const formKey = [f.process, f.level, f.from, f.to, f.q].join('|');
  const items: Row[] = data.items;

  return <main className="project-log">
    <PageHeader title="Журнал проєкту"
      lead="Що виконується, що завершилося та де потрібна увага. Увесь час у журналі — за Києвом."
      actions={<LogRefresh />} />

    <form key={formKey} className="ed-filters log-filters" action="/editorial/logs" aria-label="Фільтри журналу">
      <label>Процес<select name="process" defaultValue={f.process}>
        <option value="">Усі процеси</option>
        {Object.entries(logProcesses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Результат<select name="level" defaultValue={f.level}>
        <option value="">Усі результати</option>
        {Object.entries(levels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Від<input type="date" name="from" defaultValue={f.from} /></label>
      <label>До включно<input type="date" name="to" defaultValue={f.to} /></label>
      <label className="log-search">Пошук<input name="q" defaultValue={f.q} maxLength={160} placeholder="Назва, YouTube ID або код помилки" /></label>
      <div className="log-filter-actions">
        <button className="ed-primary">Застосувати</button>
        <Link className="ed-button ed-quiet" href="/editorial/logs">Скинути</Link>
      </div>
    </form>

    <dl className="log-summary" aria-label="Підсумок за фільтрами">
      <div><dt>Записів</dt><dd>{data.total}</dd></div>
      <div className="log-sum-active"><dt>У роботі</dt><dd>{data.active}</dd></div>
      <div className="log-sum-error"><dt>Помилки</dt><dd>{data.errors}</dd></div>
      <div className="log-sum-warning"><dt>Потребують уваги</dt><dd>{data.warnings}</dd></div>
    </dl>
    <p className="log-note">«Подія» — збережена дія в історії. «Поточний стан» — останній відомий стан завдання, а не історія всіх його переходів. Для монтажу час — створення завдання. Лічильники рахують записи, а не унікальні ролики. Внутрішні журнали VPS та Vercel сюди не входять.</p>

    {items.length ? <ol className="log-list" aria-label="Записи журналу">{items.map(row => {
      const action = nextLogAction(row);
      const recordType = logRecordType(row.key);
      const attention = row.level === 'error' || row.level === 'warning';
      const explanation = row.explanation ?? (row.error_code || attention ? fallbackExplanation : null);
      return <li key={row.key}><article className={'log-entry log-' + row.level}>
        <header className="log-entry-head">
          <time dateTime={row.time} title="Час за Києвом">{kyivSeconds.format(new Date(row.time))}</time>
          <p className="log-source">
            <strong>{logProcesses[row.process as keyof typeof logProcesses] ?? row.process}</strong>
            {recordType && <span> · {recordType}</span>}
          </p>
          <span className={'log-kind log-kind-' + (row.kind === 'event' ? 'event' : 'snapshot')}>
            {row.kind === 'event' ? 'Подія' : 'Поточний стан'}
          </span>
        </header>
        <div className="log-status">
          <Badge tone={tones[row.level] ?? 'neutral'}>{row.message}</Badge>
          <span className="log-level">{levels[row.level]}</span>
          {explanation && <p className="log-explanation">{explanation}</p>}
        </div>
        <p className="log-subject">{row.linked_video_id
          ? <Link href={'/editorial/videos/' + row.linked_video_id}>{row.title}</Link>
          : row.title}</p>
        {row.details && <dl className="log-details">{Object.entries(row.details)
          .filter(([, value]) => value !== null && value !== '')
          .map(([key, value]) => <div key={key}><dt>{detailLabels[key] ?? key}</dt>
            <dd>{key === 'sentAt' ? kyivSeconds.format(new Date(String(value))) : String(value)}</dd></div>)}</dl>}
        <footer className="log-entry-foot">
          {action && <Link className="ed-button log-action" href={action.href}>{action.label} <span aria-hidden="true">→</span></Link>}
          <details className="ed-details log-tech"><summary>Технічні деталі</summary>
            <dl>
              <div><dt>Код</dt><dd>{row.error_code ? <code>{row.error_code}</code> : '—'}</dd></div>
              <div><dt>Ключ запису</dt><dd><code>{row.key}</code></dd></div>
            </dl>
          </details>
        </footer>
      </article></li>;
    })}</ol> : <Empty unavailable>За цими фільтрами записів немає.</Empty>}

    <nav className="log-pagination" aria-label="Сторінки журналу">
      {f.page > 1 ? <Link className="ed-button" href={pageLink(f.page - 1)}>← Попередня</Link> : <span />}
      <span className="ed-meta">Сторінка {f.page} · по 50 записів</span>
      {f.page * 50 < data.total ? <Link className="ed-button" href={pageLink(f.page + 1)}>Наступна →</Link> : <span />}
    </nav>
  </main>;
}
