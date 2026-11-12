import { appOrigin } from './clerk-config';
import { clerkId } from './session';

const status: Record<string,number> = {
  AUTH_REQUIRED:401, FORBIDDEN:403, ORIGIN_DENIED:403, NOT_FOUND:404,
  ATTEMPT_CONFLICT:409, RETRY_NOT_AVAILABLE:409, ACKNOWLEDGMENT_REQUIRED:409,
  INVALID_INPUT:422, TRANSCRIPT_REQUIRED:422, TRANSCRIPT_TOO_LARGE:422, SEGMENT_TOO_LARGE:422,
  BUDGET_EXHAUSTED:429, CONCURRENCY_LIMIT:429, ANALYSIS_DISABLED:503,
};
export function analysisResponse(data: unknown, code=200) {
  return Response.json({data},{status:code,headers:{'Cache-Control':'private, no-store'}});
}
export function analysisError(error: unknown) {
  const code=error instanceof Error&&Object.hasOwn(status,error.message)?error.message:'ANALYSIS_FAILED';
  return Response.json({error:{code,requestId:crypto.randomUUID()}},
    {status:status[code]??500,headers:{'Cache-Control':'private, no-store'}});
}
export async function analysisIdentity(request?: Request) {
  const id=await clerkId();
  if(!id) throw Error('AUTH_REQUIRED');
  if(request&&request.headers.get('origin')!==appOrigin()) throw Error('ORIGIN_DENIED');
  return id;
}
export async function analysisInput(request: Request) {
  const reader=request.body?.getReader();
  if(!reader) throw Error('INVALID_INPUT');
  const chunks=[];
  let total=0;
  try {
    for(;;){
      const {value,done}=await reader.read();
      if(done) break;
      total+=value.byteLength;
      if(total>4096){ await reader.cancel(); throw Error('INVALID_INPUT'); }
      chunks.push(value);
    }
    const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total)));
    if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.transcriptId!=='string'
      ||(data.retry!==undefined&&typeof data.retry!=='boolean')
      ||(data.acknowledgeUnknown!==undefined&&typeof data.acknowledgeUnknown!=='boolean')) throw Error('INVALID_INPUT');
    return data;
  } catch { throw Error('INVALID_INPUT'); }
  finally { reader.releaseLock(); }
}
