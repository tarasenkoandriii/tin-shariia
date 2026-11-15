import { redirect } from 'next/navigation';
import { activeMember, listAccess } from '../../../access/membership.mjs';
import { clerkId } from '../../../access/session';
import { database } from '../../../db/runtime.mjs';
import { readGrokSettings } from '../../../db/episode-grok.mjs';
import { CancelInviteForm, InviteForm, MemberForm } from '../forms';
import { GrokSettings } from '../grok-settings';
import { Badge, Empty, PageHeader, SectionHead } from '../ui';

export const dynamic = 'force-dynamic';

const roleLabels: Record<string, string> = {
  author: 'Автор', factchecker: 'Фактчекер', editor: 'Редактор', publisher: 'Публікатор', admin: 'Адміністратор',
};
type Member = { id: string; email: string; revoked_at: string | null; roles: string[] };

export default async function TeamPage() {
  const identity = await clerkId();
  if (!identity) redirect('/sign-in');
  const db = await database();
  const member = await activeMember(db, identity);
  if (!member?.roles.includes('admin')) redirect('/editorial');
  const [access, grok] = await Promise.all([listAccess(db, identity), readGrokSettings(db, identity)]);
  const members: Member[] = access.members;
  const active = members.filter(item => !item.revoked_at);

  return <main className="ed-team">
    <PageHeader title="Команда" lead="Учасники редакції, їхні ролі та запрошення. Адміністратор має всі редакційні ролі." />
    <section className="ed-section ed-card" aria-labelledby="team-invite">
      <SectionHead id="team-invite" title="Запросити учасника" meta="Запрошення діє 48 годин." />
      <InviteForm />
    </section>
    <section className="ed-section" aria-labelledby="team-members">
      <SectionHead id="team-members" title="Учасники" meta={`${active.length} активних · ${members.length - active.length} з відкликаним доступом`} />
      <ul className="ed-member-list">{members.map(item => <li key={item.id} className="ed-card">
        <div className="ed-member-head">
          <strong>{item.email}</strong>
          {item.revoked_at ? <Badge tone="neutral">Доступ відкликано</Badge>
            : <span className="ed-member-roles">{item.roles.map(role => <Badge key={role} tone="active">{roleLabels[role] ?? role}</Badge>)}</span>}
        </div>
        {!item.revoked_at && <details className="ed-details"><summary>Змінити ролі</summary>
          <MemberForm key={item.roles.join(',')} id={item.id} roles={item.roles} />
        </details>}
      </li>)}</ul>
    </section>
    <section className="ed-section" aria-labelledby="team-invites">
      <SectionHead id="team-invites" title="Активні запрошення" meta={String(access.invitations.length)} />
      {access.invitations.length === 0 ? <Empty>Активних запрошень немає.</Empty>
        : <ul className="ed-member-list">{access.invitations.map((invite: { email: string }) => <li key={invite.email} className="ed-card">
          <div className="ed-member-head"><strong>{invite.email}</strong><CancelInviteForm email={invite.email} /></div>
        </li>)}</ul>}
    </section>
    {/* Admin-only editorial setting; it lived on the old main page next to the team block. */}
    <div className="ed-section">
      <GrokSettings initialScore={grok.autoAcceptScore} initialMode={grok.grokMode === 'batch' ? 'batch' : 'direct'} />
    </div>
  </main>;
}
