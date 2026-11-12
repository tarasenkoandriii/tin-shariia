import { createHash, randomBytes } from 'node:crypto';

export const roles = ['author', 'factchecker', 'editor', 'publisher', 'admin'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

function validatedRoles(requested) {
  if (!Array.isArray(requested) || !requested.length || requested.some(role => !roles.includes(role))) {
    throw new Error('INVALID_ROLES');
  }
  return [...new Set(requested)];
}

export async function activeMember(db, clerkId) {
  if (!clerkId) return null;
  const { rows: [member] } = await db.query(
    `SELECT m.id, m.email, ARRAY(SELECT role FROM member_roles WHERE member_id = m.id ORDER BY role) AS roles
     FROM members m WHERE clerk_user_id = $1 AND revoked_at IS NULL`, [clerkId],
  );
  return member ?? null;
}

async function serialized(db, operation) {
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(72036591)');
    return operation(tx);
  });
}

async function log(tx, action, actor, member = null, invitation = null, assigned = null) {
  await tx.query(
    'INSERT INTO access_events (action, actor_id, member_id, invitation_hash, roles) VALUES ($1,$2,$3,$4,$5)',
    [action, actor, member, invitation, assigned],
  );
}

async function assign(tx, id, assigned) {
  await tx.query('DELETE FROM member_roles WHERE member_id = $1', [id]);
  await tx.query('INSERT INTO member_roles SELECT $1, unnest($2::text[])', [id, assigned]);
}

async function admin(tx, clerkId) {
  const actor = await activeMember(tx, clerkId);
  if (!actor?.roles.includes('admin')) throw new Error('FORBIDDEN');
  return actor;
}

export function bootstrapAdmin(db, { clerkId, verifiedEmail }) {
  return serialized(db, async tx => {
    const email = normalizeEmail(verifiedEmail);
    if (!clerkId || !email) throw new Error('VERIFIED_EMAIL_REQUIRED');
    const { rows } = await tx.query('SELECT id FROM members LIMIT 1');
    if (rows.length) throw new Error('ALREADY_INITIALIZED');
    const { rows: [{ id }] } = await tx.query(
      'INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) RETURNING id', [clerkId, email],
    );
    await assign(tx, id, ['admin']);
    await log(tx, 'bootstrap', id, id, null, ['admin']);
    return id;
  });
}

export function createInvitation(db, clerkId, { email, requestedRoles }) {
  return serialized(db, async tx => {
    const actor = await admin(tx, clerkId);
    email = normalizeEmail(email);
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('INVALID_EMAIL');
    const assigned = validatedRoles(requestedRoles);
    const { rows } = await tx.query('SELECT id FROM members WHERE email = $1', [email]);
    if (rows.length) throw new Error('MEMBER_EXISTS');
    await tx.query(
      'UPDATE invitations SET revoked_at = now() WHERE email = $1 AND accepted_by IS NULL AND revoked_at IS NULL',
      [email],
    );
    const token = randomBytes(32).toString('base64url');
    const digest = hash(token);
    await tx.query(
      "INSERT INTO invitations (token_hash,email,roles,invited_by,expires_at) VALUES ($1,$2,$3,$4,now()+interval '48 hours')",
      [digest, email, assigned, actor.id],
    );
    await log(tx, 'invite', actor.id, null, digest, assigned);
    return token;
  });
}

export function acceptInvitation(db, { clerkId, verifiedEmails, token }) {
  return serialized(db, async tx => {
    if (!clerkId || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('INVITATION_DENIED');
    const digest = hash(token);
    const { rows: [invitation] } = await tx.query(
      `SELECT email, roles FROM invitations WHERE token_hash = $1 AND accepted_by IS NULL
       AND revoked_at IS NULL AND expires_at > now()`, [digest],
    );
    if (!invitation || !verifiedEmails.map(normalizeEmail).includes(invitation.email)) {
      throw new Error('INVITATION_DENIED');
    }
    const { rows } = await tx.query(
      'INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id',
      [clerkId, invitation.email],
    );
    if (!rows.length) throw new Error('INVITATION_DENIED');
    const { id } = rows[0];
    await assign(tx, id, invitation.roles);
    await tx.query('UPDATE invitations SET accepted_by = $2 WHERE token_hash = $1', [digest, id]);
    await log(tx, 'accept', id, id, digest, invitation.roles);
    return id;
  });
}

export async function listAccess(db, clerkId) {
  return serialized(db, async tx => {
    await admin(tx, clerkId);
    const { rows: members } = await tx.query(
      `SELECT m.id, m.email, m.revoked_at,
       ARRAY(SELECT role FROM member_roles WHERE member_id = m.id ORDER BY role) AS roles
       FROM members m ORDER BY m.email`,
    );
    const { rows: invitations } = await tx.query(
      `SELECT email, expires_at, roles FROM invitations WHERE accepted_by IS NULL
       AND revoked_at IS NULL AND expires_at > now() ORDER BY email`,
    );
    return { members, invitations };
  });
}

export function cancelInvitation(db, clerkId, email) {
  return serialized(db, async tx => {
    const actor = await admin(tx, clerkId);
    const { rows: [invitation] } = await tx.query(
      `UPDATE invitations SET revoked_at = now() WHERE email = $1
       AND accepted_by IS NULL AND revoked_at IS NULL RETURNING token_hash`, [normalizeEmail(email)],
    );
    if (invitation) await log(tx, 'cancel', actor.id, null, invitation.token_hash);
  });
}

export function changeAccess(db, clerkId, memberId, requestedRoles) {
  return serialized(db, async tx => {
    const actor = await admin(tx, clerkId);
    const assigned = requestedRoles === null ? null : validatedRoles(requestedRoles);
    const { rows: [member] } = await tx.query(
      'SELECT revoked_at FROM members WHERE id = $1', [memberId],
    );
    if (!member || member.revoked_at) throw new Error('MEMBER_UNAVAILABLE');
    if (!assigned?.includes('admin')) {
      const { rows } = await tx.query(
        `SELECT m.id FROM members m JOIN member_roles r ON r.member_id = m.id
         WHERE m.id <> $1 AND m.revoked_at IS NULL AND r.role = 'admin' LIMIT 1`, [memberId],
      );
      if (!rows.length) {
        const { rows: target } = await tx.query(
          "SELECT role FROM member_roles WHERE member_id = $1 AND role = 'admin'", [memberId],
        );
        if (target.length) throw new Error('LAST_ADMIN');
      }
    }
    if (assigned) await assign(tx, memberId, assigned);
    else await tx.query('UPDATE members SET revoked_at = now() WHERE id = $1', [memberId]);
    await log(tx, assigned ? 'roles' : 'revoke', actor.id, memberId, null, assigned);
  });
}
