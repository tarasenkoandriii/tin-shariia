// One source of truth for the editorial menu. Each `roles` list mirrors the server check that guards the
// page itself (see the file named in `guard`), so a link is shown exactly when the page will open.
// Admins hold every role (activeMember), so admin-only pages list just 'admin'.

export type Role = 'author' | 'factchecker' | 'editor' | 'publisher' | 'admin';
export type Section = {
  key: string; href: string; label: string; group: 'Редакція' | 'Виробництво' | 'Керування';
  roles: Role[] | 'member'; guard: string;
};

export const sections: Section[] = [
  { key: 'overview', href: '/editorial', label: 'Огляд', group: 'Редакція', roles: 'member', guard: 'activeMember' },
  { key: 'videos', href: '/editorial/videos', label: 'Відео редакції', group: 'Редакція', roles: 'member', guard: 'loadWorkflow → actor' },
  { key: 'channel', href: '/editorial/youtube-channel', label: 'Випуски з YouTube', group: 'Редакція', roles: 'member', guard: 'youtube-channel/page.tsx' },
  { key: 'montage', href: '/editorial/montage-plans', label: 'Монтажні плани', group: 'Виробництво', roles: ['admin'], guard: 'listMontagePlans → adminFor' },
  // Production-only route (its source is not in this repository); the current Production menu shows it to admins.
  { key: 'cycles', href: '/editorial/cycles', label: 'Автоматичні випуски', group: 'Виробництво', roles: ['admin'], guard: 'Production /editorial/cycles' },
  { key: 'comments', href: '/editorial/youtube-comments', label: 'Коментарі та переходи', group: 'Виробництво', roles: ['admin', 'editor', 'publisher'], guard: 'youtube-comments/page.tsx' },
  { key: 'logs', href: '/editorial/logs', label: 'Журнал проєкту', group: 'Керування', roles: ['admin'], guard: 'loadProjectLog' },
  { key: 'youtube', href: '/editorial/youtube', label: 'Підключення YouTube', group: 'Керування', roles: ['publisher'], guard: 'getYouTubeConnection → publisher' },
  { key: 'team', href: '/editorial/team', label: 'Команда', group: 'Керування', roles: ['admin'], guard: 'listAccess → admin' },
];

export const groups = ['Редакція', 'Виробництво', 'Керування'] as const;

export function canOpen(section: Section | string, roles: readonly string[]) {
  const item = typeof section === 'string' ? sections.find(s => s.key === section) : section;
  if (!item) return false;
  return item.roles === 'member' || item.roles.some(role => roles.includes(role));
}

export function visibleSections(roles: readonly string[]) {
  return sections.filter(section => canOpen(section, roles));
}

// Longest matching prefix wins, so /editorial/videos/<id> belongs to «Відео редакції».
export function sectionForPath(pathname: string) {
  return [...sections].sort((a, b) => b.href.length - a.href.length)
    .find(section => pathname === section.href || (section.href !== '/editorial' && pathname.startsWith(section.href + '/')))
    ?? (pathname === '/editorial' ? sections[0] : undefined);
}

// Who may do what on the pages (mirrors the API checks; used to hide buttons, never to grant access).
export const can = {
  addVideo: (roles: readonly string[]) => roles.includes('author'),           // api/videos → canImport
  reviewClaims: (roles: readonly string[]) => roles.includes('factchecker'),  // editorial-workflow config.reviewer
  reviewEpisodes: (roles: readonly string[]) => roles.includes('editor'),
  publish: (roles: readonly string[]) => roles.includes('publisher'),
  approveComments: (roles: readonly string[]) => roles.includes('editor'),
  manageComments: (roles: readonly string[]) => roles.includes('admin'),
};
