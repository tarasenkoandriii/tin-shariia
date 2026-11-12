import { clerkId } from '../../../../access/session';
import { activeMember } from '../../../../access/membership.mjs';
import { database } from '../../../../db/runtime.mjs';
import { listShariyChannelVideos } from '../../../../youtube/shariy-channel.mjs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    const identity = await clerkId();
    if (!identity) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers });
    if (!await activeMember(await database(), identity)) {
      return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403, headers });
    }
    const token = new URL(request.url).searchParams.get('pageToken') ?? undefined;
    return Response.json({ data: await listShariyChannelVideos(token) }, { headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status = code === 'YOUTUBE_API_NOT_CONFIGURED' ? 503
      : code === 'INVALID_PAGE_TOKEN' ? 422
      : code === 'YOUTUBE_CHANNEL_NOT_FOUND' ? 404
      : code === 'AUTH_REQUIRED' ? 401
      : code === 'FORBIDDEN' ? 403
      : (error as { reason?: string })?.reason === 'quotaExceeded' ? 429 : 502;
    const known = ['YOUTUBE_API_NOT_CONFIGURED', 'INVALID_PAGE_TOKEN', 'YOUTUBE_CHANNEL_NOT_FOUND', 'AUTH_REQUIRED', 'FORBIDDEN'];
    return Response.json({ error: { code: known.includes(code) ? code
      : status === 429 ? 'YOUTUBE_QUOTA_EXCEEDED' : 'YOUTUBE_READ_FAILED' } }, { status, headers });
  }
}
