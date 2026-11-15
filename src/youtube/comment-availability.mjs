import {activeMember} from '../access/membership.mjs';
import {decryptYouTubeSecret,refreshYouTubeAccessToken,youtubeOAuthConfig} from './oauth.mjs';
export function classifyCommentAvailability(httpStatus,body){
 const reason=body?.error?.errors?.[0]?.reason??null;
 return {canComment:httpStatus===200?true:reason==='commentsDisabled'?false:null,httpStatus,reason,message:body?.error?.message??null};
}
export async function checkCommentAvailability(db,identity,videoId,fetchImpl=fetch){
 const member=await activeMember(db,identity);
 if(!member?.roles.some(role=>['editor','publisher','admin'].includes(role)))throw Error(identity?'FORBIDDEN':'AUTH_REQUIRED');
 if(!/^[\w-]{11}$/.test(videoId??''))throw Error('INVALID_INPUT');
 const {rows:[c]}=await db.query('SELECT channel_id,refresh_token_encrypted FROM youtube_connections WHERE disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1');
 if(!c)throw Error('YOUTUBE_NOT_CONNECTED');
 const token=await refreshYouTubeAccessToken(decryptYouTubeSecret(c.refresh_token_encrypted),youtubeOAuthConfig(),fetchImpl);
 const url=new URL('https://www.googleapis.com/youtube/v3/commentThreads');
 url.search=new URLSearchParams({part:'id',videoId,maxResults:'1'}).toString();
 const r=await fetchImpl(url,{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(15000)});
 return {videoId,channelId:c.channel_id,checkedAt:new Date().toISOString(),...classifyCommentAvailability(r.status,await r.json().catch(()=>null))};
}
