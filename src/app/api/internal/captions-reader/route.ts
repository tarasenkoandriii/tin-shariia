import {claimCommentVisibility,finishCommentVisibility} from '../../../../db/youtube-comment-steps.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { claimCaptionsImport, finishCaptionsImport } from '../../../../db/captions-import.mjs';
import { database } from '../../../../db/runtime.mjs';

const digest = (value: string) => createHash('sha256').update(value).digest();

export async function POST(request: Request) {
  const token = process.env.YOUTUBE_READER_TOKEN;
  if (!token || !timingSafeEqual(digest('Bearer ' + token), digest(request.headers.get('authorization') ?? ''))) {
    return new Response(null, { status: 403 });
  }
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 3 * 1024 * 1024) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (input?.action === 'claim-comment') return Response.json(await claimCommentVisibility(await database()));
    if (input?.action === 'finish-comment') return Response.json({ accepted: await finishCommentVisibility(await database(), input) });
    if (input?.action === 'claim') return Response.json(await claimCaptionsImport(await database()));
    if (input?.action === 'finish') return Response.json({ accepted: await finishCaptionsImport(await database(), input) });
    return new Response(null, { status: 400 });
  } catch (error) {
    const invalid = error instanceof SyntaxError || (error instanceof Error && error.message === 'INVALID_INPUT');
    return new Response(null, { status: invalid ? 400 : 500 });
  } finally { reader.releaseLock(); }
}
