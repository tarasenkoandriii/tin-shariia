import {NextResponse} from 'next/server';
import {database} from '../../../../db/runtime.mjs';
import {recordYouTubeShortCommentClick} from '../../../../db/youtube-comments.mjs';

export const dynamic='force-dynamic';
export const runtime='nodejs';

export async function GET(_request:Request,{params}:{params:Promise<{token:string}>}){
  const {token}=await params;
  try{
    const target=await recordYouTubeShortCommentClick(await database(),token);
    if(!target)return new Response('Link not found',{status:404,headers:{'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'}});
    return NextResponse.redirect(target,{status:302,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}});
  }catch{return new Response('Temporarily unavailable',{status:503,headers:{'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'}});}
}
