import {SHARIY_CHANNEL_ID} from './shariy-channel.mjs';

const COMMENT_SCOPE='https://www.googleapis.com/auth/youtube.force-ssl';

export async function verifyYouTubeCommentTarget(row, {fetchImpl=fetch,apiKey=process.env.YOUTUBE_API_KEY}={}){
  if(!row.scopes?.includes(COMMENT_SCOPE)) throw Error('YOUTUBE_COMMENT_SCOPE_REQUIRED');
  if(!apiKey) throw Error('YOUTUBE_COMMENT_TARGET_UNVERIFIED');
  const url=new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search=new URLSearchParams({part:'snippet,status',id:[...new Set([row.parent_video_id,row.short_video_id])].join(','),key:apiKey});
  let videos;
  try {
    const response=await fetchImpl(url,{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(response.ok) videos=(await response.json()).items;
  } catch { /* The editor can retry verification. */ }
  if(!Array.isArray(videos)) throw Error('YOUTUBE_COMMENT_TARGET_UNVERIFIED');
  const target=videos.find(video=>video.id===row.parent_video_id);
  const short=videos.find(video=>video.id===row.short_video_id);
  if(!target?.snippet?.channelId || target.status?.privacyStatus!=='public') throw Error('YOUTUBE_COMMENT_TARGET_UNVERIFIED');
  const expected=row.target_kind==='source'?SHARIY_CHANNEL_ID:row.channel_id;
  if(target.snippet.channelId!==expected) throw Error('YOUTUBE_COMMENT_WRONG_TARGET_CHANNEL');
  if(short?.snippet?.channelId!==row.channel_id||short.status?.privacyStatus!=='public') throw Error('YOUTUBE_COMMENT_SHORT_NOT_PUBLIC');
  return target.snippet.channelId;
}
