import { createHash, timingSafeEqual } from 'node:crypto';
import { dispatchMontages } from '../../../../workflows/montage-dispatch';
import { dispatchSources } from '../../../../workflows/dispatch';

const hash=(value: string)=>createHash('sha256').update(value).digest();
const headers={'Cache-Control':'private, no-store'};
export async function GET(request: Request) {
  const secret=process.env.CRON_SECRET;
  const authorization=request.headers.get('authorization')??'';
  if(!secret||!timingSafeEqual(hash(authorization),hash('Bearer '+secret))) {
    return Response.json({error:'UNAUTHORIZED'},{status:401,headers});
  }
  const [sources,montages]=await Promise.allSettled([dispatchSources(),dispatchMontages()]);
  const failed=sources.status==='rejected'||montages.status==='rejected';
  return Response.json({sources:sources.status==='fulfilled'?sources.value:null,
    montages:montages.status==='fulfilled'?montages.value:null},{status:failed?503:200,headers});
}
