import { analysisError, analysisIdentity, analysisInput, analysisResponse } from '../../../../access/analysis-http';
import { createClaimsFromDrafts } from '../../../../db/claim-drafts.mjs';
import { analysisStatus } from '../../../../analysis/queue.mjs';
import { database } from '../../../../db/runtime.mjs';

export async function GET(_request: Request,{params}: {params:Promise<{id:string}>}) {
  try {
    const identity=await analysisIdentity();
    return analysisResponse(await analysisStatus(await database(),identity,{id:(await params).id}));
  } catch(error) { return analysisError(error); }
}

// {"action":"create-claims"} turns every Gemini draft of this analysis into a draft claim (idempotent).
export async function POST(request: Request,{params}: {params:Promise<{id:string}>}) {
  try {
    const identity=await analysisIdentity(request);
    const input=await analysisInput(request);
    if(input.action!=='create-claims') throw Error('INVALID_INPUT');
    return analysisResponse(await createClaimsFromDrafts(await database(),identity,(await params).id),201);
  } catch(error) { return analysisError(error); }
}
