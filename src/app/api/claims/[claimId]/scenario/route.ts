import { publicationError, publicationIdentity, publicationInput, publicationReply } from '../../../../../access/publication-http';
import { analysisConfig } from '../../../../../analysis/config.mjs';
import { generateScenarioDraft } from '../../../../../analysis/scenario-ai.mjs';
import { database } from '../../../../../db/runtime.mjs';

export const maxDuration = 120;

// {"requestId":"<uuid>"} → Gemini drafts a scenario for the approved claim and saves it as an episode draft.
export async function POST(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  try {
    const identity = await publicationIdentity(request);
    const input = await publicationInput(request);
    const result = await generateScenarioDraft(await database(), identity, (await params).claimId, input, analysisConfig());
    return publicationReply(result, result.cached ? 200 : 201);
  } catch (error) { return publicationError(error); }
}
