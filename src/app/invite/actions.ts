'use server';

import { redirect } from 'next/navigation';
import { acceptInvitation } from '../../access/membership.mjs';
import { verifiedIdentity } from '../../access/session';
import { database } from '../../db/runtime.mjs';

export async function accept(_: string, form: FormData) {
  const identity = await verifiedIdentity();
  if (!identity) redirect('/sign-in');
  try {
    await acceptInvitation(await database(), { ...identity, token: String(form.get('token') ?? '').trim() });
  } catch {
    return 'Запрошення недійсне або не відповідає підтвердженій адресі облікового запису.';
  }
  redirect('/editorial');
}
