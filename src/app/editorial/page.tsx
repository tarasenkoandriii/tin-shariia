import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { activeMember } from '../../access/membership.mjs';
import { clerkId } from '../../access/session';
import { loadEditorialOverview } from '../../db/editorial-overview.mjs';
import { database } from '../../db/runtime.mjs';
import { LegacyAnchors } from './legacy-anchors';
import { canOpen, can } from './sections';
import { Badge, Empty, KyivTime, PageHeader, SectionHead, Thumb, type Tone } from './ui';
import './overview.css';

export const dynamic = 'force-dynamic';

type Attention = { key: string; kind: string; title: string; stage: string; reason: string; tone: Tone; time: string | null; href: string };
type Step = { key: string; videoId: string; youtubeId: string | null; title: string; stage: string; label: string; tone: Tone; time: string | null; href: string; action: string };
type CommentState = {
  id: string; targetKind: string; parentVideoId: string;
  send: { sent: boolean; at: string | null; label: string; tone: Tone };
  visibility: { value: string; label: string; tone: Tone; reason: string; checkedAt: string | null } | null;
  commentUrl: string | null; href: string;
};
type Publication = {
  key: string; shortYoutubeId: string; title: string; publishedAt: string; sourceYoutubeId: string | null;
  videoId: string | null; episodeId: string | null; href: string | null; comments: CommentState[];
};
type Event = { key: string; time: string; label: string; title: string; href: string | null; tone: Tone };
type Day = { day: string; shorts: number; verifiedComments: number | null };
type Overview = {
  roles: string[]; generatedAt: string;
  attention: { total: number; items: Attention[] } | null;
  stats: { inReview: number | null; inProduction: number | null; publishedShorts7d: number | null; verifiedComments7d: number | null };
  pipeline: Step[] | null; publications: Publication[] | null;
  events: { full: boolean; items: Event[] } | null;
  series: { timeZone: string; days: Day[] } | null;
};

const stageLabels: Record<string, string> = {
  factcheck: 'Фактчек', transcripts: 'Субтитри', analysis: 'Аналіз Gemini', script: 'Сценарій', grok: 'Перевірка Grok',
  montage: 'Монтаж', shorts: 'Shorts', publication: 'Публікація', published: 'Опубліковано', comments: 'Коментарі',
};
const number = (value: number | null | undefined) => value === null || value === undefined ? null : value;

function Stat({ label, value, period, href, hint }: { label: string; value: number | null; period?: string; href: string | null; hint: string }) {
  const body = <>
    <span className="ov-stat-label">{label}</span>
    {value === null ? <strong className="ov-stat-value ov-stat-na">Дані недоступні</strong> : <strong className="ov-stat-value">{value}</strong>}
    <span className="ov-stat-hint">{period ? <><b>{period}</b> · </> : null}{hint}</span>
  </>;
  return href && value !== null ? <Link className="ov-stat" href={href}>{body}</Link> : <div className="ov-stat">{body}</div>;
}

function Chart({ days, timeZone }: { days: Day[]; timeZone: string }) {
  const comments = days.some(day => day.verifiedComments !== null);
  const max = Math.max(1, ...days.flatMap(day => [day.shorts, day.verifiedComments ?? 0]));
  const label = (day: string) => new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(day + 'T12:00:00Z'));
  const width = 100 / days.length;
  const summary = days.map(day => `${label(day.day)}: Shorts ${day.shorts}${comments ? `, коментарів ${day.verifiedComments ?? 0}` : ''}`).join('; ');
  return <figure className="ov-chart">
    <figcaption>
      <strong>Опубліковані Shorts{comments ? ' і коментарі з підтвердженою видимістю' : ''}</strong>
      <span>Кількість за добу · останні 7 днів · час {timeZone === 'Europe/Kyiv' ? 'за Києвом' : timeZone}</span>
    </figcaption>
    <svg viewBox="0 0 700 180" role="img" aria-label={'Графік за 7 днів. ' + summary} preserveAspectRatio="none">
      {[0, 1, 2].map(line => <line key={line} x1="0" x2="700" y1={20 + line * 60} y2={20 + line * 60} className="ov-chart-grid" />)}
      {days.map((day, index) => {
        const x = index * width * 7, bar = (value: number) => Math.max(value ? 3 : 0, value / max * 140);
        return <g key={day.day}>
          <rect x={x + 22} y={160 - bar(day.shorts)} width={comments ? 22 : 40} height={bar(day.shorts)} rx="3" className="ov-bar-shorts" />
          {comments && <rect x={x + 48} y={160 - bar(day.verifiedComments ?? 0)} width="22" height={bar(day.verifiedComments ?? 0)} rx="3" className="ov-bar-comments" />}
        </g>;
      })}
    </svg>
    <ol className="ov-chart-axis" aria-hidden="true">{days.map(day => <li key={day.day}>{label(day.day)}</li>)}</ol>
    <p className="ov-legend"><span><i className="ov-bar-shorts" /> Shorts</span>{comments && <span><i className="ov-bar-comments" /> Коментарі, видимість підтверджено</span>}
      <span className="ed-meta">Шкала: 0–{max}</span></p>
  </figure>;
}

export default async function Overview({ searchParams }: { searchParams: Promise<{ youtube?: string }> }) {
  const identity = await clerkId();
  if (!identity) redirect('/sign-in');
  // The YouTube OAuth callback still returns to /editorial?youtube=…; the connection now has its own page.
  const result = (await searchParams).youtube;
  if (result) redirect('/editorial/youtube?youtube=' + encodeURIComponent(result));
  const db = await database();
  const member = await activeMember(db, identity);
  if (!member) return <main><UserButton /><h1>Доступ до редакції закрито</h1><Link href="/invite">Маю запрошення</Link></main>;

  const data: Overview = await loadEditorialOverview(db, identity);
  const roles: string[] = member.roles;
  const attention = data.attention;
  const commentsPage = canOpen('comments', roles);
  const statusLine = [
    attention ? (attention.total ? `Потребує уваги: ${attention.total}` : 'Термінових задач немає') : null,
    number(data.stats.inReview) !== null ? `на перевірці: ${data.stats.inReview}` : null,
    number(data.stats.inProduction) !== null ? `у виробництві: ${data.stats.inProduction}` : null,
  ].filter(Boolean).join(' · ');

  return <main className="ov">
    <LegacyAnchors />
    <PageHeader title="Огляд редакції"
      lead={<>{statusLine}{statusLine ? ' · ' : ''}оновлено <KyivTime value={data.generatedAt} /></>}
      actions={can.addVideo(roles) ? <Link className="ed-button ed-primary" href="/editorial/videos?add=1#add-video">Додати відео</Link> : undefined} />

    <section className="ov-attention ed-card" aria-labelledby="ov-attention">
      <SectionHead id="ov-attention" title="Потребує уваги"
        meta={attention && attention.total > attention.items.length ? `Показано ${attention.items.length} із ${attention.total}` : 'Задачі, де потрібна ваша дія'} />
      {!attention ? <Empty unavailable>Дані недоступні. Оновіть сторінку трохи пізніше.</Empty>
        : attention.items.length === 0 ? <Empty>Немає задач, що потребують уваги.</Empty>
          : <ol className="ov-queue">{attention.items.map(item => <li key={item.key} className={'ov-queue-item ov-' + item.tone}>
            <div className="ov-queue-main">
              <Link href={item.href} className="ov-queue-title">{item.title}</Link>
              <p><Badge tone={item.tone}>{stageLabels[item.stage] ?? item.stage}</Badge> <span>{item.reason}</span></p>
            </div>
            <div className="ov-queue-side"><KyivTime value={item.time} /><Link className="ed-button" href={item.href}>Відкрити</Link></div>
          </li>)}</ol>}
    </section>

    <section className="ov-stats" aria-label="Стан редакції">
      <Stat label="На перевірці" value={number(data.stats.inReview)} href="/editorial/videos?stage=review" hint="твердження та сценарії, що чекають рішення" />
      <Stat label="У виробництві" value={number(data.stats.inProduction)} href="/editorial/videos?stage=production" hint="погоджені сценарії без публікації" />
      <Stat label="Опубліковані Shorts" value={number(data.stats.publishedShorts7d)} period="7 днів" href="/editorial/videos?stage=published" hint="YouTube API та зареєстровані з Studio" />
      <Stat label="Коментарі з підтвердженою видимістю" value={number(data.stats.verifiedComments7d)} period="7 днів"
        href={commentsPage ? '/editorial/youtube-comments?visibility=confirmed#visibility' : null} hint="перевірено після перезавантаження сторінки" />
    </section>

    <section className="ed-section" aria-labelledby="ov-pipeline">
      <SectionHead id="ov-pipeline" title="Випуски в роботі" meta="Останні 8 активних за часом зміни"
        action={<Link href="/editorial/videos">Усі відео →</Link>} />
      {!data.pipeline ? <Empty unavailable>Дані недоступні.</Empty> : data.pipeline.length === 0 ? <Empty>Активних випусків немає.</Empty>
        : <div className="ed-table-wrap ov-pipeline"><table className="ed-table">
          <thead><tr><th scope="col"><span className="ed-visually-hidden">Прев’ю</span></th><th scope="col">Випуск</th><th scope="col">Етап</th><th scope="col">Остання зміна</th><th scope="col"><span className="ed-visually-hidden">Дія</span></th></tr></thead>
          <tbody>{data.pipeline.map(step => <tr key={step.key}>
            <td className="ov-cell-thumb"><Thumb youtubeId={step.youtubeId} /></td>
            <td className="ov-cell-title"><Link href={'/editorial/videos/' + step.videoId}>{step.title}</Link>{step.youtubeId && <span className="ed-meta">YouTube {step.youtubeId}</span>}</td>
            <td className="ov-cell-stage"><Badge tone={step.tone}>{step.label}</Badge></td>
            <td className="ov-cell-time"><KyivTime value={step.time} /></td>
            <td className="ov-cell-action"><Link className="ed-button" href={step.href}>{step.action}</Link></td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    <div className="ov-columns">
      <section className="ed-section" aria-labelledby="ov-published">
        <SectionHead id="ov-published" title="Останні публікації" meta="Shorts і коментарі до них" />
        {!data.publications ? <Empty unavailable>Дані недоступні.</Empty> : data.publications.length === 0 ? <Empty>Опублікованих Shorts ще немає.</Empty>
          : <ul className="ov-publications">{data.publications.map(item => <li key={item.key} className="ed-card">
            <div className="ov-publication-head">
              <Thumb youtubeId={item.shortYoutubeId} vertical />
              <div>
                {item.href ? <Link href={item.href} className="ov-queue-title">{item.title}</Link> : <strong>{item.title}</strong>}
                <p className="ed-meta">Опубліковано <KyivTime value={item.publishedAt} /></p>
                <p className="ov-links">
                  <a href={`https://www.youtube.com/shorts/${encodeURIComponent(item.shortYoutubeId)}`} target="_blank" rel="noreferrer">Short на YouTube</a>
                  {item.sourceYoutubeId && <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(item.sourceYoutubeId)}`} target="_blank" rel="noreferrer">Вихідне відео</a>}
                </p>
              </div>
            </div>
            {commentsPage && <ul className="ov-comments">{item.comments.length === 0 ? <li className="ed-meta">Коментарів до цього Short ще немає.</li>
              : item.comments.map(comment => <li key={comment.id}>
                <span className="ov-comment-target">{comment.targetKind === 'source' ? 'Коментар під вихідним відео' : 'Коментар під основним випуском'}</span>
                <span className="ov-pair">
                  <Badge tone={comment.send.tone}>{comment.send.label}</Badge>
                  {comment.send.at && <KyivTime value={comment.send.at} />}
                </span>
                {comment.visibility && <span className="ov-pair">
                  <Badge tone={comment.visibility.tone}>{comment.visibility.label}</Badge>
                  <span className="ed-meta">{comment.visibility.reason}</span>
                </span>}
                <span className="ov-links">
                  {comment.commentUrl && <a href={comment.commentUrl} target="_blank" rel="noreferrer">Коментар на YouTube</a>}
                  <Link href={comment.href}>Деталі</Link>
                </span>
              </li>)}</ul>}
          </li>)}</ul>}
      </section>

      <section className="ed-section" aria-labelledby="ov-events">
        <SectionHead id="ov-events" title="Останні події"
          action={data.events?.full ? <Link href="/editorial/logs">Повний журнал →</Link> : undefined}
          meta={data.events && !data.events.full ? 'Редакційні рішення' : 'Час за Києвом'} />
        {data.series && <Chart days={data.series.days} timeZone={data.series.timeZone} />}
        {!data.events ? <Empty unavailable>Дані недоступні.</Empty> : data.events.items.length === 0 ? <Empty>Подій ще немає.</Empty>
          : <ol className="ov-events">{data.events.items.map(event => <li key={event.key}>
            <KyivTime value={event.time} />
            <div><Badge tone={event.tone}>{event.label}</Badge>{' '}
              {event.href ? <Link href={event.href}>{event.title}</Link> : <span>{event.title}</span>}</div>
          </li>)}</ol>}
      </section>
    </div>
  </main>;
}
