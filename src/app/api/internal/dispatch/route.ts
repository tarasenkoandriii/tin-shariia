import { createHash, timingSafeEqual } from 'node:crypto';
import { dispatchSources } from '../../../../workflows/dispatch';

const hash=(value: string)=>createHash('sha256').update(value).digest();
const headers={'Cache-Control':'private, no-store'};
export async function GET(request: Request) {
  const secret=process.env.CRON_SECRET;
  const authorization=request.headers.get('authorization')??'';
  if(!secret||!timingSafeEqual(hash(authorization),hash('Bearer '+secret))) {
    return Response.json({error:'UNAUTHORIZED'},{status:401,headers});
  }
  try { return Response.json(await dispatchSources(),{headers}); }
  catch { return Response.json({error:'DISPATCH_FAILED'},{status:503,headers}); }
}
