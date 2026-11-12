import { changeEditorial } from '../db/editorial-workflow.mjs';

const errors = {
  AUTH_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404, REVISION_CONFLICT: 409,
  CLAIM_STALE: 409, CLAIM_NOT_APPROVED: 409, INVALID_TRANSITION: 409,
  INVALID_INPUT: 422, TRANSCRIPT_MISMATCH: 422, REVIEW_INCOMPLETE: 422, SELF_APPROVAL: 403,
};

export async function editorialMutation(request, { db, identity, collection, id, review, origin }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  const reply = (status, code) => Response.json({ error: { code } }, { status, headers });
  const kind = collection === 'claims' ? 'claim' : collection === 'episodes' ? 'episode' : null;
  if (!kind) return reply(404, 'NOT_FOUND');
  if (!identity) return reply(401, 'AUTH_REQUIRED');
  if (request.headers.get('origin') !== origin) return reply(403, 'ORIGIN_DENIED');
  const limit = 512 * 1024;
  if (Number(request.headers.get('content-length')) > limit) return reply(413, 'BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) return reply(422, 'INVALID_INPUT');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return reply(413, 'BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let input;
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    return reply(422, 'INVALID_INPUT');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(422, 'INVALID_INPUT');
  const allowed = review ? ['approve','return'] : id ? (request.method === 'PATCH' ? ['edit'] : ['submit','withdraw']) : ['create'];
  if (!allowed.includes(input.action)) return reply(422, 'INVALID_INPUT');
  try {
    const data = await changeEditorial(db, identity, kind, { ...input, id });
    return Response.json({ data }, { status: input.action === 'create' ? 201 : 200, headers });
  } catch (error) {
    const code = Object.hasOwn(errors, error?.message) ? error.message : 'WORKFLOW_FAILED';
    return reply(errors[code] ?? 500, code);
  }
}
