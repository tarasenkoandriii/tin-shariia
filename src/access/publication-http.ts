import { randomUUID } from 'node:crypto';
import { appOrigin } from './clerk-config';
import { clerkId } from './session';

export const privateHeaders = { 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff' };
const statuses: Record<string,number> = {
  AUTH_REQUIRED:401, FORBIDDEN:403, ORIGIN_DENIED:403, SELF_APPROVAL:403, NOT_FOUND:404,
  APPROVAL_REQUIRED:409, CLAIM_STALE:409, PUBLICATION_CONFLICT:409, EPISODE_PUBLISHED:409,
  RELEASE_APPROVAL_REQUIRED:409, AUDIT_REQUIRED:409, FINDINGS_OPEN:409, REVIEW_CLOSED:409,
  METRIC_CONFLICT:409, METRIC_TOO_EARLY:422, INVALID_TRANSITION:409, REVISION_CONFLICT:409,
  MONTAGE_DISABLED:503, MONTAGE_SIZE_INVALID:422, MONTAGE_OBJECT_MISMATCH:422, MONTAGE_OBJECT_MISSING:409,
  MONTAGE_STORAGE_LIMIT:429, MONTAGE_UPLOAD_PENDING:409, MONTAGE_UPLOAD_EXPIRED:409,
  MEDIA_NOT_READY:409, MEDIA_STALE:409, VIDEO_AUDIT_DISABLED:503, ANALYSIS_DISABLED:503,
  BUDGET_EXHAUSTED:429, CONCURRENCY_LIMIT:429, ACKNOWLEDGMENT_REQUIRED:409,
  ATTEMPT_CONFLICT:409, RETRY_NOT_AVAILABLE:409,
  INVALID_INPUT:422, PACKAGE_TOO_LARGE:413, BODY_TOO_LARGE:413,
};

export function publicationReply(data: unknown, status=200) {
  return Response.json({data},{status,headers:privateHeaders});
}

export function publicationError(error: unknown) {
  const code=error instanceof Error&&Object.hasOwn(statuses,error.message)?error.message:'PUBLICATION_FAILED';
  return Response.json({error:{code,requestId:randomUUID()}},{status:statuses[code]??500,headers:privateHeaders});
}

export async function publicationIdentity(request?: Request) {
  const id=await clerkId();
  if(!id) throw Error('AUTH_REQUIRED');
  if(request&&request.headers.get('origin')!==appOrigin()) throw Error('ORIGIN_DENIED');
  return id;
}

export async function publicationInput(request: Request) {
  const limit=128*1024;
  if(Number(request.headers.get('content-length'))>limit) throw Error('BODY_TOO_LARGE');
  const reader=request.body?.getReader();
  if(!reader) throw Error('INVALID_INPUT');
  const chunks=[];
  let size=0;
  try {
    for(;;){
      const {value,done}=await reader.read();
      if(done) break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel().catch(()=>{});throw Error('BODY_TOO_LARGE');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  try{
    const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
    if(!input||typeof input!=='object'||Array.isArray(input)) throw Error();
    return input;
  }catch{throw Error('INVALID_INPUT');}
}
