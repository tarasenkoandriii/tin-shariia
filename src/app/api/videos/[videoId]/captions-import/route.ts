import { analysisError, analysisIdentity, analysisResponse } from '../../../../../access/analysis-http';
import { captionsImportStatus } from '../../../../../db/captions-import.mjs';
import { database } from '../../../../../db/runtime.mjs';

type Context = { params: Promise<{ videoId: string }> };

async function handle(request: Request, context: Context, enqueue: boolean) {
  try {
    const identity = await analysisIdentity(enqueue ? request : undefined);
    if (!process.env.YOUTUBE_READER_TOKEN) throw Error('ANALYSIS_DISABLED');
    const { videoId } = await context.params;
    return analysisResponse(await captionsImportStatus(await database(), identity, videoId, enqueue));
  } catch (error) { return analysisError(error); }
}

export const GET = (request: Request, context: Context) => handle(request, context, false);
export const POST = (request: Request, context: Context) => handle(request, context, true);
