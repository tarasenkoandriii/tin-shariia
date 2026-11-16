import { UserButton } from '@clerk/nextjs';
import type { ReactNode } from 'react';
import { activeMember } from '../../access/membership.mjs';
import { clerkId } from '../../access/session';
import { database } from '../../db/runtime.mjs';
import { EditorialShell } from './shell';
import './editorial.css';

// Shared frame for every /editorial page. Pages keep their own access checks; the layout only decides
// which menu items to show. Visitors without membership see the page alone (it explains the closed access).
export default async function EditorialLayout({ children }: { children: ReactNode }) {
  const identity = await clerkId();
  const member = identity ? await activeMember(await database(), identity) : null;
  if (!member) return <>{children}</>;
  return <EditorialShell roles={member.roles} account={<UserButton />}>{children}</EditorialShell>;
}
