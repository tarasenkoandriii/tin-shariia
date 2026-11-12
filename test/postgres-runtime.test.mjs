import assert from 'node:assert/strict';
import test from 'node:test';
import { database } from '../src/db/runtime.mjs';
import { activeMember, bootstrapAdmin, createInvitation, acceptInvitation, changeAccess } from '../src/access/membership.mjs';

test('native PostgreSQL migration and driver support the membership lifecycle', {
  skip: process.env.RUN_POSTGRES_TESTS !== '1',
}, async () => {
  const db = await database();
  await bootstrapAdmin(db, { clerkId: 'ci-owner', verifiedEmail: 'ci-owner@example.test' });
  const email = 'ci-author@example.test';
  const token = await createInvitation(db, 'ci-owner', { email, requestedRoles: ['author', 'editor'] });
  const id = await acceptInvitation(db, { clerkId: 'ci-author', verifiedEmails: [email], token });
  assert.deepEqual((await activeMember(db, 'ci-author')).roles, ['author', 'editor']);
  await changeAccess(db, 'ci-owner', id, null);
  assert.equal(await activeMember(db, 'ci-author'), null);
});
