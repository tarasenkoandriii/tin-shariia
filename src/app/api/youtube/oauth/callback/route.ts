import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { appOrigin } from '../../../../../access/clerk-config';
import { clerkId } from '../../../../../access/session';
import { database } from '../../../../../db/runtime.mjs';
import { consumeOAuthState, getYouTubeConnectionSecret, saveYouTubeConnection } from '../../../../../db/youtube-uploads.mjs';
import { decryptYouTubeSecret, encryptYouTubeSecret, exchangeYouTubeCode, fetchYouTubeChannel, revokeYouTubeToken, youtubeOAuthConfig, YOUTUBE_COMMENT_SCOPE, YOUTUBE_SCOPES } from '../../../../../youtube/oauth.mjs';

export const dynamic='force-dynamic';

function finish(origin:string,result:string){
  const url=new URL('/editorial',origin);url.searchParams.set('youtube',result);
  return NextResponse.redirect(url,303);
}

export async function GET(request:Request){
  let origin:string;
  try{origin=appOrigin();}catch{return Response.json({error:'APP_ORIGIN_INVALID'},{status:503});}
  try{
    const identity=await clerkId();
    if(!identity) return NextResponse.redirect(new URL('/sign-in',origin));
    const url=new URL(request.url);
    const state=url.searchParams.get('state')??'';
    const code=url.searchParams.get('code')??'';
    if(url.searchParams.has('error')) return finish(origin,'connect_failed');
    if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!code||code.length>4096) return finish(origin,'connect_failed');
    const config=youtubeOAuthConfig({...process.env,APP_ORIGIN:origin});
    const db=await database();
    const flow=await consumeOAuthState(db,identity,createHash('sha256').update(state).digest('hex'));
    const requiredScopes=flow.requestCommentScope?[...YOUTUBE_SCOPES,YOUTUBE_COMMENT_SCOPE]:YOUTUBE_SCOPES;
    const token=await exchangeYouTubeCode({code,codeVerifier:flow.codeVerifier,config,requiredScopes});
    const channel=await fetchYouTubeChannel(token.accessToken);
    const current=await getYouTubeConnectionSecret(db,identity);
    await saveYouTubeConnection(db,identity,{channelId:channel.channelId,channelTitle:channel.title,
      refreshTokenEncrypted:encryptYouTubeSecret(token.refreshToken),scopes:token.scopes});
    if(current?.refresh_token_encrypted){
      const oldToken=decryptYouTubeSecret(current.refresh_token_encrypted);
      if(oldToken!==token.refreshToken)try{await revokeYouTubeToken(oldToken);}catch{/* New connection already saved; no provider details are logged. */}
    }
    return finish(origin,'connected');
  }catch(error){
    const message=(error as Error)?.message;
    const result=message==='FORBIDDEN'?'forbidden':message==='YOUTUBE_OAUTH_NOT_CONFIGURED'||message==='YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED'
      ?'not_configured':message==='YOUTUBE_SCOPE_REQUIRED'?'comment_scope_required':'connect_failed';
    return finish(origin,result);
  }
}
