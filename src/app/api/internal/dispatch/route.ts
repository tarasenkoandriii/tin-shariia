import { createHash, timingSafeEqual } from 'node:crypto';
import { dispatchMontages } from '../../../../workflows/montage-dispatch';
import { dispatchShortRenders } from '../../../../workflows/shorts-dispatch';
import { dispatchSources } from '../../../../workflows/dispatch';

const hash=(value: string)=>createHash('sha256').update(value).digest();
const headers={'Cache-Control':'private, no-store'};
export async function GET(request: Request) {
  const secret=process.env.CRON_SECRET;
  const authorization=request.headers.get('authorization')??'';
  if(!secret||!timingSafeEqual(hash(authorization),hash('Bearer '+secret))) {
    return Response.json({error:'UNAUTHORIZED'},{status:401,headers});
  }
  const [sources,montages,shorts]=await Promise.allSettled([dispatchSources(),dispatchMontages(),dispatchShortRenders()]);
  const failed=sources.status==='rejected'||montages.status==='rejected'||shorts.status==='rejected';
  console.info('CRON_DISPATCH_RESULT',JSON.stringify({
    failed,
    sources:sources.status==='fulfilled'?sources.value:{failed:true},
    montages:montages.status==='fulfilled'?montages.value:{failed:true},
    shorts:shorts.status==='fulfilled'?shorts.value:{failed:true},
  }));
  return Response.json({sources:sources.status==='fulfilled'?sources.value:null,
    montages:montages.status==='fulfilled'?montages.value:null,
    shorts:shorts.status==='fulfilled'?shorts.value:null},{status:failed?503:200,headers});
}
