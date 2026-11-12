'use client';

import { useActionState } from 'react';
import { issueInvite, revokeInvitation, updateMember } from './actions';

const labels = {
  author: 'Автор', factchecker: 'Фактчекер', editor: 'Редактор', publisher: 'Публікатор', admin: 'Адміністратор',
};

function RoleFields({ selected = [] }: { selected?: string[] }) {
  return <fieldset><legend>Ролі</legend>{Object.entries(labels).map(([role, label]) =>
    <label key={role}><input type="checkbox" name="roles" value={role} defaultChecked={selected.includes(role)} /> {label}</label>
  )}</fieldset>;
}

export function InviteForm() {
  const [result, action, pending] = useActionState(issueInvite, '');
  return <form action={action}>
    <label>Електронна пошта <input type="email" name="email" required maxLength={254} /></label>
    <RoleFields />
    <button disabled={pending}>Створити запрошення</button>
    {result && <output>{/^[A-Za-z0-9_-]{43}$/.test(result) ? <>Код діє 48 годин. Передайте його запрошеному учаснику. <code>{result}</code></> : result}</output>}
  </form>;
}

export function MemberForm({ id, roles }: { id: string, roles: string[] }) {
  const [result, action, pending] = useActionState(updateMember, '');
  return <form action={action}>
    <input type="hidden" name="memberId" value={id} />
    <RoleFields selected={roles} />
    <div>
      <button name="operation" value="roles" disabled={pending}>Зберегти ролі</button>{' '}
      <button name="operation" value="revoke" disabled={pending}>Відкликати доступ</button>
    </div>
    {result && <output>{result}</output>}
  </form>;
}

export function CancelInviteForm({ email }: { email: string }) {
  const [result, action, pending] = useActionState(revokeInvitation, '');
  return <form action={action}>
    <input type="hidden" name="email" value={email} />
    <button disabled={pending}>Скасувати запрошення</button>
    {result && <output>{result}</output>}
  </form>;
}
