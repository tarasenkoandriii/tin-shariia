import { appOrigin } from '../../../../access/clerk-config';
import { activeMember } from '../../../../access/membership.mjs';
import { clerkId } from '../../../../access/session';
import { database } from '../../../../db/runtime.mjs';
import { createEditorialImportHandler } from '../../../../http/editorial-import.mjs';

export async function POST(request: Request) {
  const identity = await clerkId();
  if (!identity) {
    return Response.json({ error: { code: 'AUTH_REQUIRED' } }, {
      status: 401, headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  const db = await database();
  return createEditorialImportHandler({
    db,
    allowedOrigin: appOrigin(),
    async authorize() {
      const member = await activeMember(db, identity);
      return { actorId: identity, canImport: member?.roles.includes('author') ?? false };
    },
  })(request);
}
