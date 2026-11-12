import { appOrigin } from './clerk-config';
import { clerkId } from './session';
import { database } from '../db/runtime.mjs';
import { editorialMutation } from '../http/editorial-workflow.mjs';

export async function mutate(request: Request, collection: string, id?: string, review = false) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (collection !== 'claims' && collection !== 'episodes') {
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404, headers });
  }
  const identity = await clerkId();
  if (!identity) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers });
  return editorialMutation(request, { db: await database(), identity, collection, id, review, origin: appOrigin() });
}
