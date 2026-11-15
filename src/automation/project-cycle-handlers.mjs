import {decryptYouTubeSecret,refreshYouTubeAccessToken,youtubeOAuthConfig} from '../youtube/oauth.mjs';
import {registerVideo} from '../db/editorial-import.mjs';
import {captionsImportStatus} from '../db/captions-import.mjs';

const pause = code => ({wait:true,code});
const before = code => Object.assign(Error(code),{beforeSend:true});

// Source discovery is channel-specific and reads the real comment endpoint with our OAuth.
// Never silently falls back to another channel, a repost or a paid video analysis.
export function projectSourceHandlers(db,identity,{fetchImpl=fetch}={}) {
 const api=async(path,token)=>{
  const response=await fetchImpl('https://www.googleapis.com/youtube/v3/'+path,{headers:{Authorization:'Bearer '+token},
   cache:'no-store',signal:AbortSignal.timeout(15000)});
  return {status:response.status,body:await response.json()};
 };
 return {
  async discover({policy,artifacts}) {
   const {rows:[connection]}=await db.query('SELECT channel_id,refresh_token_encrypted FROM youtube_connections WHERE disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1');
   if(connection?.channel_id!==policy.ownChannelId)throw before('CYCLE_OWN_CHANNEL_CHANGED');
   const token=await refreshYouTubeAccessToken(decryptYouTubeSecret(connection.refresh_token_encrypted),youtubeOAuthConfig());
   const channel=await api('channels?part=contentDetails&id='+policy.sourceChannelId,token);
   if(channel.status!==200)throw before('CYCLE_SOURCE_UNAVAILABLE');
   const playlist=channel.body.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
   if(!playlist)throw before('CYCLE_SOURCE_UNAVAILABLE');
   const list=await api('playlistItems?part=snippet,contentDetails&maxResults=20&playlistId='+playlist,token);
   if(list.status!==200)throw before('CYCLE_SOURCE_UNAVAILABLE');
   const checks=[];
   for(const item of list.body.items??[]) {
    const videoId=item.contentDetails.videoId;
    if((artifacts.checkedSources??[]).some(s=>s.videoId===videoId))continue;
    if(item.snippet.videoOwnerChannelId!==policy.sourceChannelId)continue;
    const comments=await api('commentThreads?part=id&maxResults=1&videoId='+videoId,token);
    const reason=comments.body.error?.errors?.[0]?.reason??null;
    checks.push({videoId,http:comments.status,reason});
    // Comment availability is promotional metadata, never a condition for making a Short.
    // A failed check is retained for a later promotion check; do not mistake it for disabled comments.
    const {rows:existing}=await db.query(`SELECT 1 FROM claims c JOIN videos v ON v.id=c.video_id
      WHERE v.youtube_id=$1 AND c.status<>'withdrawn' LIMIT 1`,[videoId]);
    if(existing.length)continue;
    const video=await registerVideo(db,'https://www.youtube.com/watch?v='+videoId);
    return {videoId,videoRecordId:video.id,channelId:policy.sourceChannelId,title:item.snippet.title,
     publishedAt:item.contentDetails.videoPublishedAt,commentsHttp:comments.status,commentsError:reason,checks};
   }
   return {skip:true,code:'NO_NEW_SOURCE',checks};
  },
  async captions({artifacts}) {
   const source=artifacts.discover;
   const {rows:[transcript]}=await db.query('SELECT id FROM transcripts WHERE video_id=$1 ORDER BY version DESC LIMIT 1',[source.videoRecordId]);
   if(transcript) {
    const {rows:segments}=await db.query('SELECT start_ms AS "startMs",end_ms AS "endMs",body AS text FROM transcript_segments WHERE transcript_id=$1 ORDER BY position',[transcript.id]);
    return {videoId:source.videoId,transcriptId:transcript.id,segments:segments.map(s=>({...s,startMs:Number(s.startMs),endMs:Number(s.endMs)}))};
   }
   const status=await captionsImportStatus(db,identity,source.videoRecordId);
   if(status.status==='failed')throw before(status.errorCode==='NO_CAPTIONS'?'CYCLE_CAPTIONS_UNAVAILABLE':'CYCLE_READER_UNAVAILABLE');
   if(!status.status)await captionsImportStatus(db,identity,source.videoRecordId,true);
   return pause('YOUTUBE_CAPTIONS_PENDING');
  },
 };
}
