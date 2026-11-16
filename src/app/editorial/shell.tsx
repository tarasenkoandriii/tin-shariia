'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { groups, sectionForPath, visibleSections } from './sections';

// The menu only shows sections whose own server check would let this member in (see sections.ts).
export function EditorialShell({ roles, account, children }: { roles: string[]; account: ReactNode; children: ReactNode }) {
  const pathname = usePathname() ?? '/editorial';
  // The menu remembers the page it was opened on, so any navigation (links, Back/Forward) closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (value: boolean) => setOpenOn(value ? pathname : null);
  const items = visibleSections(roles);
  const current = sectionForPath(pathname);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const links = menu.current?.querySelectorAll<HTMLElement>('.ed-nav-link');
    (menu.current?.querySelector<HTMLElement>('.ed-nav-link[aria-current="page"]') ?? links?.[0])?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenOn(null);
      button.current?.focus();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  return <div className="ed-shell" data-menu={open ? 'open' : 'closed'}>
    <a className="ed-skip" href="#ed-main">Перейти до змісту</a>
    <aside className="ed-sidebar" id="ed-menu" aria-label="Меню редакції" ref={menu}>
      <Link className="ed-brand" href="/editorial" onClick={() => setOpen(false)}>
        <span className="ed-brand-mark" aria-hidden="true">ТШ</span>
        <span><strong>Тінь Шарія</strong><small>Редакція</small></span>
      </Link>
      <nav className="ed-nav" aria-label="Розділи редакції">
        {groups.map(group => {
          const links = items.filter(item => item.group === group);
          if (!links.length) return null;
          return <div className="ed-nav-group" key={group}>
            <p className="ed-nav-label" id={'ed-group-' + group}>{group}</p>
            <ul aria-labelledby={'ed-group-' + group}>{links.map(item => <li key={item.key}>
              <Link className="ed-nav-link" href={item.href} onClick={() => setOpen(false)} aria-current={current?.key === item.key ? 'page' : undefined}>
                {item.label}
              </Link>
            </li>)}</ul>
          </div>;
        })}
      </nav>
    </aside>
    {/* While the mobile menu covers the page, the content behind it is out of the tab order. */}
    <div className="ed-body">
      <header className="ed-topbar">
        <button type="button" ref={button} className="ed-menu-button" aria-expanded={open} aria-controls="ed-menu"
          onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '✕' : '☰'}</span> {open ? 'Закрити' : 'Меню'}
        </button>
        <p className="ed-topbar-title">{current?.label ?? 'Редакція'} <span>· Тінь Шарія</span></p>
        {account}
      </header>
      <div className="ed-content" id="ed-main" tabIndex={-1} inert={open}>{children}</div>
    </div>
  </div>;
}
