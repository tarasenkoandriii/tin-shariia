import { analysisError, analysisIdentity, analysisResponse } from '../../../../../access/analysis-http';
import { checkYouTubeCaptions } from '../../../../../analysis/captions-check.mjs';
import { database } from '../../../../../db/runtime.mjs';

export const maxDuration = 60;

// Read-only check: no Gemini, no Soniox, no budget, no queue, no transcript write.
export async function POST(request: Request, { params }: { params: Promise<{ videoId: string }> }) {
  try {
    const identity = await analysisIdentity(request);
    return analysisResponse(await checkYouTubeCaptions(await database(), identity, (await params).videoId));
  } catch (error) { return analysisError(error); }
}
