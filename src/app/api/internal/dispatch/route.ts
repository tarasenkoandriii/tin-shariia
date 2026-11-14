import { createHash, timingSafeEqual } from 'node:crypto';
import { dispatchMontages } from '../../../../workflows/montage-dispatch';
import { dispatchShortRenders } from '../../../../workflows/shorts-dispatch';
import { dispatchSources } from '../../../../workflows/dispatch';
import {database} from '../../../../db/runtime.mjs';
import {syncYouTubePublicationStats} from '../../../../youtube/publication-stats.mjs';
import {dispatchEpisodeGrokReviews} from '../../../../analysis/episode-grok-review.mjs';
import {dispatchYouTubeComments,youtubeCommentPreflightCode} from '../../../../youtube/comments.mjs';

const hash=(value: string)=>createHash('sha256').update(value).digest();
const headers={'Cache-Control':'private, no-store'};
export async function GET(request: Request) {
  const secret=process.env.CRON_SECRET;
  const authorization=request.headers.get('authorization')??'';
  if(!secret||!timingSafeEqual(hash(authorization),hash('Bearer '+secret))) {
    return Response.json({error:'UNAUTHORIZED'},{status:401,headers});
  }
  const db=await database();
  const [sources,montages,shorts,publicationStats,grokReviews,youtubeComments]=await Promise.allSettled([
    dispatchSources(),dispatchMontages(),dispatchShortRenders(),syncYouTubePublicationStats(db),dispatchEpisodeGrokReviews(db),dispatchYouTubeComments(db),
  ]);
  const failed=[sources,montages,shorts,publicationStats,grokReviews,youtubeComments].some(item=>item.status==='rejected');
  console.info('CRON_DISPATCH_RESULT',JSON.stringify({
    failed,
    sources:sources.status==='fulfilled'?sources.value:{failed:true},
    montages:montages.status==='fulfilled'?montages.value:{failed:true},
    shorts:shorts.status==='fulfilled'?shorts.value:{failed:true},
    publicationStats:publicationStats.status==='fulfilled'?publicationStats.value:{failed:true,code:youtubeCommentPreflightCode(publicationStats.reason)},
    grokReviews:grokReviews.status==='fulfilled'?grokReviews.value:{failed:true},
    youtubeComments:youtubeComments.status==='fulfilled'?youtubeComments.value:{failed:true},
  }));
  return Response.json({sources:sources.status==='fulfilled'?sources.value:null,
    montages:montages.status==='fulfilled'?montages.value:null,
    shorts:shorts.status==='fulfilled'?shorts.value:null,
    publicationStats:publicationStats.status==='fulfilled'?publicationStats.value:null,
    grokReviews:grokReviews.status==='fulfilled'?grokReviews.value:null,
    youtubeComments:youtubeComments.status==='fulfilled'?youtubeComments.value:null},{status:failed?503:200,headers});
}
