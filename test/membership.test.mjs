import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  acceptInvitation, activeMember, bootstrapAdmin, cancelInvitation, changeAccess, createInvitation, listAccess,
} from '../src/access/membership.mjs';

test('editorial access is invite-only, revocable, role-scoped and audited', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('../drizzle/0001_editorial_access.sql', import.meta.url), 'utf8'));
    const owner = await bootstrapAdmin(db, { clerkId: 'owner', verifiedEmail: 'owner@example.test' });
    await assert.rejects(bootstrapAdmin(db, { clerkId: 'outsider', verifiedEmail: 'outside@example.test' }), /ALREADY_INITIALIZED/);
    assert.deepEqual((await activeMember(db, 'owner')).roles, ['admin']);
    assert.equal(await activeMember(db, 'outsider'), null);
    const invite = email => createInvitation(db, 'owner', { email, requestedRoles: ['author'] });
    const accept = (token, clerkId, verifiedEmails) => acceptInvitation(db, { token, clerkId, verifiedEmails });
    await assert.rejects(createInvitation(db, 'outsider', { email: 'x@example.test', requestedRoles: ['admin'] }), /FORBIDDEN/);
    await assert.rejects(changeAccess(db, 'owner', owner, ['editor']), /LAST_ADMIN/);
    await assert.rejects(changeAccess(db, 'owner', owner, null), /LAST_ADMIN/);

    const email = 'author@example.test';
    const old = await invite(email);
    const token = await invite(email);
    await assert.rejects(accept(old, 'author', [email]), /INVITATION_DENIED/);
    await assert.rejects(accept(token, 'outsider', []), /INVITATION_DENIED/);
    await assert.rejects(accept(token, 'outsider', ['wrong@example.test']), /INVITATION_DENIED/);
    assert.equal((await listAccess(db, 'owner')).invitations[0].email, email);
    const results = await Promise.allSettled([accept(token, 'author', [email.toUpperCase()]), accept(token, 'copy', [email])]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    const user = await activeMember(db, 'author') ?? await activeMember(db, 'copy');
    const clerkId = await activeMember(db, 'author') ? 'author' : 'copy';
    assert.deepEqual(user.roles, ['author']);
    await assert.rejects(listAccess(db, clerkId), /FORBIDDEN/);
    await changeAccess(db, 'owner', user.id, ['publisher', 'factchecker']);
    assert.deepEqual((await activeMember(db, clerkId)).roles, ['factchecker', 'publisher']);
    await changeAccess(db, 'owner', user.id, null);
    assert.equal(await activeMember(db, clerkId), null);
    await assert.rejects(invite(email), /MEMBER_EXISTS/);

    const cancelled = await invite('cancelled@example.test');
    await cancelInvitation(db, 'owner', 'cancelled@example.test');
    await assert.rejects(accept(cancelled, 'cancelled', ['cancelled@example.test']), /INVITATION_DENIED/);
    const expired = await invite('expired@example.test');
    await db.query("UPDATE invitations SET expires_at = now() - interval '1 second' WHERE email = 'expired@example.test'");
    await assert.rejects(accept(expired, 'expired', ['expired@example.test']), /INVITATION_DENIED/);
    assert.equal((await listAccess(db, 'owner')).invitations.length, 0);
    const { rows } = await db.query('SELECT action FROM access_events ORDER BY id');
    assert.deepEqual(rows.map(row => row.action), [
      'bootstrap', 'invite', 'invite', 'accept', 'roles', 'revoke', 'invite', 'cancel', 'invite',
    ]);
    assert.equal((await db.query('SELECT 1 FROM invitations WHERE token_hash = $1', [token])).rows.length, 0);
  } finally {
    await db.close();
  }
});
