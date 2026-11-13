import { after } from 'next/server';
import { analysisError, analysisIdentity, analysisInput, analysisResponse } from '../../../../../access/analysis-http';
import { analysisConfig } from '../../../../../analysis/config.mjs';
import { analysisStatus, enqueueAnalysis, enqueueYouTubeAnalysis } from '../../../../../analysis/queue.mjs';
import { database } from '../../../../../db/runtime.mjs';
import { dispatchSources } from '../../../../../workflows/dispatch';

type Context = { params: Promise<{ videoId: string }> };
export async function GET(_request: Request, {params}: Context) {
  try {
    const identity=await analysisIdentity();
    return analysisResponse(await analysisStatus(await database(),identity,{videoId:(await params).videoId}));
  } catch(error) { return analysisError(error); }
}
export const maxDuration=60;
export async function POST(request: Request, {params}: Context) {
  try {
    const identity=await analysisIdentity(request);
    const input=await analysisInput(request);
    const videoId=(await params).videoId,db=await database(),config=analysisConfig();
    const result=input.source==='youtube'?await enqueueYouTubeAnalysis(db,identity,videoId,input,config)
      :await enqueueAnalysis(db,identity,videoId,input,config);
    if(!result.deduplicated) after(async()=>{ try { await dispatchSources(); } catch { console.error('ANALYSIS_DISPATCH_FAILED'); } });
    return analysisResponse(result,202);
  } catch(error) { return analysisError(error); }
}
