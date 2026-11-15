'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { groups, sectionForPath, visibleSections } from './sections';

// The menu only shows sections whose own server check would let this member in (see sections.ts).
export function EditorialShell({ roles, account, children }: { roles: string[]; account: ReactNode; children: ReactNode }) {
  const pathname = usePathname() ?? '/editorial';
  const [open, setOpen] = useState(false);
  const items = visibleSections(roles);
  const current = sectionForPath(pathname);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  return <div className="ed-shell" data-menu={open ? 'open' : 'closed'}>
    <aside className="ed-sidebar" id="ed-menu" aria-label="Меню редакції">
      <Link className="ed-brand" href="/editorial">
        <span className="ed-brand-mark" aria-hidden="true">ТШ</span>
        <span><strong>Тінь Шарія</strong><small>Редакція</small></span>
      </Link>
      <nav className="ed-nav" aria-label="Розділи редакції">
        {groups.map(group => {
          const links = items.filter(item => item.group === group);
          if (!links.length) return null;
          return <section className="ed-nav-group" key={group} aria-labelledby={'ed-group-' + group}>
            <h2 id={'ed-group-' + group}>{group}</h2>
            <ul>{links.map(item => <li key={item.key}>
              <Link className="ed-nav-link" href={item.href} aria-current={current?.key === item.key ? 'page' : undefined}>
                {item.label}
              </Link>
            </li>)}</ul>
          </section>;
        })}
      </nav>
    </aside>
    <div className="ed-body">
      <header className="ed-topbar">
        <button type="button" className="ed-menu-button" aria-expanded={open} aria-controls="ed-menu"
          onClick={() => setOpen(value => !value)}>
          <span aria-hidden="true">{open ? '✕' : '☰'}</span> {open ? 'Закрити' : 'Меню'}
        </button>
        <p className="ed-topbar-title">{current?.label ?? 'Редакція'} <span>· Тінь Шарія</span></p>
        {account}
      </header>
      <div className="ed-content">{children}</div>
    </div>
  </div>;
}
