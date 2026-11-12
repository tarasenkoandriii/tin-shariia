'use server';

import { revalidatePath } from 'next/cache';
import { changeAccess, cancelInvitation, createInvitation } from '../../access/membership.mjs';
import { clerkId } from '../../access/session';
import { database } from '../../db/runtime.mjs';

export async function issueInvite(_: string, form: FormData) {
  const id = await clerkId();
  if (!id) return 'Потрібно увійти.';
  try {
    const token = await createInvitation(await database(), id, {
      email: form.get('email'), requestedRoles: form.getAll('roles'),
    });
    revalidatePath('/editorial');
    return token;
  } catch (error) {
    if (error instanceof Error && error.message === 'MEMBER_EXISTS') return 'Ця адреса вже належить учаснику.';
    return 'Запрошення не створено. Перевірте адресу, ролі та доступ.';
  }
}

export async function updateMember(_: string, form: FormData) {
  const id = await clerkId();
  const memberId = String(form.get('memberId') ?? '');
  if (!id || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(memberId)) return 'Дію відхилено.';
  try {
    await changeAccess(await database(), id, memberId, form.get('operation') === 'revoke' ? null : form.getAll('roles'));
    revalidatePath('/editorial');
    return 'Доступ оновлено.';
  } catch (error) {
    if (error instanceof Error && error.message === 'LAST_ADMIN') return 'Потрібен принаймні один активний адміністратор.';
    return 'Дію відхилено. Перевірте ролі та доступ.';
  }
}

export async function revokeInvitation(_: string, form: FormData) {
  const id = await clerkId();
  if (!id) return 'Потрібно увійти.';
  try {
    await cancelInvitation(await database(), id, form.get('email'));
    revalidatePath('/editorial');
    return 'Запрошення скасовано.';
  } catch {
    return 'Дію відхилено.';
  }
}
