'use client';

import { useActionState } from 'react';
import { accept } from './actions';

export function AcceptInvite() {
  const [message, action, pending] = useActionState(accept, '');
  return <form action={action}>
    <label>Код запрошення <input name="token" required maxLength={43} autoComplete="off" /></label>
    <button disabled={pending}>Прийняти запрошення</button>
    {message && <output>{message}</output>}
  </form>;
}
