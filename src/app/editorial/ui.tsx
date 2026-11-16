import Link from 'next/link';
import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'info' | 'active' | 'success' | 'warning' | 'danger';

export function PageHeader({ title, lead, actions, crumbs }: {
  title: ReactNode; lead?: ReactNode; actions?: ReactNode; crumbs?: { href?: string; label: string }[];
}) {
  return <>
    {crumbs && <nav className="ed-crumbs" aria-label="Шлях"><ol>
      {crumbs.map((crumb, index) => <li key={index}>
        {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
      </li>)}
    </ol></nav>}
    <header className="ed-page-head">
      <div><h1>{title}</h1>{lead && <p className="ed-lead">{lead}</p>}</div>
      {actions && <div className="ed-actions">{actions}</div>}
    </header>
  </>;
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={'ed-badge ed-tone-' + tone}>{children}</span>;
}

export function Empty({ children, unavailable = false }: { children: ReactNode; unavailable?: boolean }) {
  return <p className={'ed-empty' + (unavailable ? ' ed-unavailable' : '')}>{children}</p>;
}

export function SectionHead({ id, title, meta, action }: { id?: string; title: ReactNode; meta?: ReactNode; action?: ReactNode }) {
  return <header className="ed-section-head">
    <div><h2 id={id}>{title}</h2>{meta && <p>{meta}</p>}</div>{action}
  </header>;
}

const kyiv = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Kyiv' });
export function KyivTime({ value }: { value: string | Date | null | undefined }) {
  if (!value) return <span className="ed-meta">—</span>;
  const date = new Date(value);
  return <time dateTime={date.toISOString()} title="Час за Києвом" suppressHydrationWarning>{kyiv.format(date)}</time>;
}

export function Thumb({ youtubeId, vertical = false, label }: { youtubeId: string | null | undefined; vertical?: boolean; label?: string }) {
  // The fallback text sits under the image, so it stays visible when YouTube has no thumbnail.
  return <span className={'ed-thumb' + (vertical ? ' ed-thumb-vertical' : '')}>
    <span aria-hidden={youtubeId ? true : undefined}>Немає прев’ю</span>
    {youtubeId &&
      /* eslint-disable-next-line @next/next/no-img-element -- public YouTube thumbnail, no referrer */
      <img src={`https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/mqdefault.jpg`} alt={label ?? ''} loading="lazy" referrerPolicy="no-referrer" />}
  </span>;
}
