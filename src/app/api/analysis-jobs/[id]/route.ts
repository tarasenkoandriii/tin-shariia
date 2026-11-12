import { analysisError, analysisIdentity, analysisResponse } from '../../../../access/analysis-http';
import { analysisStatus } from '../../../../analysis/queue.mjs';
import { database } from '../../../../db/runtime.mjs';

export async function GET(_request: Request,{params}: {params:Promise<{id:string}>}) {
  try {
    const identity=await analysisIdentity();
    return analysisResponse(await analysisStatus(await database(),identity,{id:(await params).id}));
  } catch(error) { return analysisError(error); }
}
