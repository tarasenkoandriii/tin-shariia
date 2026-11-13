import { NextResponse } from 'next/server';
import { appOrigin } from '../../../../../access/clerk-config';
import { clerkId } from '../../../../../access/session';
import { database } from '../../../../../db/runtime.mjs';
import { createOAuthState } from '../../../../../db/youtube-uploads.mjs';
import { createYouTubeAuthorization, youtubeOAuthConfig } from '../../../../../youtube/oauth.mjs';

export const dynamic='force-dynamic';

export async function GET(request:Request){
  try{
    const identity=await clerkId();
    if(!identity) return NextResponse.redirect(new URL('/sign-in',appOrigin()));
    const origin=appOrigin();
    const config=youtubeOAuthConfig({...process.env,APP_ORIGIN:origin});
    const requestCommentScope=new URL(request.url).searchParams.get('comments')==='1';
    const flow=createYouTubeAuthorization({memberId:identity,origin,clientId:config.clientId,includeCommentScope:requestCommentScope});
    await createOAuthState(await database(),identity,flow);
    return NextResponse.redirect(flow.authorizationUrl,302);
  }catch(error){
    const code=(error as Error)?.message;
    const status=code==='FORBIDDEN'?403:code==='YOUTUBE_OAUTH_NOT_CONFIGURED'||code==='YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED'?503:500;
    return Response.json({error:status===403?'FORBIDDEN':status===503?'YOUTUBE_OAUTH_NOT_CONFIGURED':'YOUTUBE_OAUTH_FAILED'},
      {status,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
  }
}
