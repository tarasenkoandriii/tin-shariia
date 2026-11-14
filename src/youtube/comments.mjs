import {claimCommentLinkUpdate,finishCommentLinkUpdate} from '../db/youtube-comment-steps.mjs';
import {requestGrokDirect} from '../analysis/grok-direct.mjs';
import {verifyYouTubeCommentTarget} from './comment-target.mjs';
import {decryptYouTubeSecret,fetchYouTubeChannel,refreshYouTubeAccessToken,youtubeOAuthConfig} from './oauth.mjs';
import {claimScheduledYouTubeComment,completeYouTubeCommentDraftBatch,queueYouTubeCommentDrafts,
  recordYouTubeCommentFailure,recordYouTubeCommentPublished,completeYouTubeCommentDirect,
  verifyPendingYouTubeCommentDrafts} from '../db/youtube-comments.mjs';
import {grokBatchConfigured,readGrokBatch,readGrokBatchResults} from '../analysis/grok-batch.mjs';

const API='https://www.googleapis.com/youtube/v3';
const system=`Write one concise, factual Ukrainian YouTube comment (1-2 sentences) under the specified target video, explaining what its related Short adds or illustrates. Use only the supplied approved script and claim context; do not add facts, accusations, hashtags, calls for likes, or external links. Keep it specific to these videos and natural, never a repeated template. Return JSON only: {"comment":"..."}. The application will append a tracked Short link after an editor reviews and approves the exact final comment.`;
const bounded=value=>{const text=JSON.stringify(value);return text.length>10000?text.slice(0,10000)+'…':text;};

const defaultAccessToken=row=>refreshYouTubeAccessToken(decryptYouTubeSecret(row.refresh_token_encrypted),youtubeOAuthConfig());

const authCodes=new Set(['YOUTUBE_OAUTH_NOT_CONFIGURED','YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED',
  'YOUTUBE_TOKEN_INVALID','YOUTUBE_TOKEN_REFRESH_FAILED','YOUTUBE_TOKEN_REFRESH_REVOKED','YOUTUBE_TOKEN_REFRESH_CLIENT']);

export function youtubeCommentPreflightCode(error){
  const code=error?.message;
  if(authCodes.has(code)||['YOUTUBE_COMMENT_AUTH_FAILED','YOUTUBE_COMMENT_APPROVAL_CHANGED',
    'YOUTUBE_COMMENT_SCOPE_REQUIRED','YOUTUBE_COMMENT_TARGET_UNVERIFIED','YOUTUBE_COMMENT_WRONG_TARGET_CHANNEL',
    'YOUTUBE_COMMENT_SHORT_NOT_PUBLIC'].includes(code)) return code;
  return 'YOUTUBE_COMMENT_AUTH_FAILED';
}

export async function checkYouTubeCommentOAuth(db){
  const {rows:[row]}=await db.query(`SELECT channel_id,scopes,refresh_token_encrypted FROM youtube_connections
    WHERE disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1`);
  if(!row) return {code:'YOUTUBE_CHANNEL_NOT_CONNECTED'};
  if(!row.scopes?.includes('https://www.googleapis.com/auth/youtube.force-ssl'))
    return {code:'YOUTUBE_COMMENT_SCOPE_REQUIRED'};
  try{
    const token=await defaultAccessToken(row);
    const {channelId}=await fetchYouTubeChannel(token);
    return {code:channelId===row.channel_id?'OK':'YOUTUBE_COMMENT_APPROVAL_CHANGED'};
  }catch(error){return {code:youtubeCommentPreflightCode(error)};}
}

export async function checkPublishedYouTubeComment(db,id,{apiKey=process.env.YOUTUBE_API_KEY,fetchImpl=fetch}={}){
  const {rows:[row]}=await db.query(`SELECT youtube_comment_id,parent_video_id,approved_channel_id
    FROM youtube_short_comments WHERE id=$1 AND state='published'`,[id]);
  if(!row?.youtube_comment_id) return {code:'YOUTUBE_COMMENT_NOT_READY'};
  if(!apiKey) return {code:'YOUTUBE_COMMENT_LOOKUP_FAILED'};
  const url=new URL(`${API}/comments`);
  url.search=new URLSearchParams({part:'snippet',id:row.youtube_comment_id});
  try {
    const response=await fetchImpl(url,{headers:{'x-goog-api-key':apiKey},cache:'no-store',signal:AbortSignal.timeout(10000)});
    const body=await response.json();
    if(response.status===404&&body.error?.errors?.some(error=>error.reason==='commentNotFound'))
      return {code:'YOUTUBE_COMMENT_NOT_VISIBLE'};
    if(!response.ok||!Array.isArray(body.items)) return {code:'YOUTUBE_COMMENT_LOOKUP_FAILED'};
    const comment=body.items.find(item=>item.id===row.youtube_comment_id);
    if(!comment) return {code:'YOUTUBE_COMMENT_NOT_VISIBLE'};
    const valid=comment.snippet?.videoId===row.parent_video_id&&
      (!row.approved_channel_id||comment.snippet?.authorChannelId?.value===row.approved_channel_id);
    return {code:valid?'OK':'YOUTUBE_COMMENT_LOOKUP_MISMATCH'};
  }catch{return {code:'YOUTUBE_COMMENT_LOOKUP_FAILED'};}
}

export async function publishOne(db,{verify=verifyYouTubeCommentTarget,fetchImpl=fetch,accessToken=defaultAccessToken}={}){
  const row=await claimScheduledYouTubeComment(db);if(!row)return {published:0};
  let targetChannelId,token;
  try {
    if(row.approved_channel_id && row.approved_channel_id!==row.channel_id) throw Error('YOUTUBE_COMMENT_APPROVAL_CHANGED');
    targetChannelId=await verify(row);
    token=await accessToken(row);
  } catch(error){
    const code=youtubeCommentPreflightCode(error);
    await recordYouTubeCommentFailure(db,row.id,code);
    return {published:0,failed:1};
  }
  let response,body;
  try{
    const url=new URL(`${API}/commentThreads`);url.searchParams.set('part','snippet');
    response=await fetchImpl(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({snippet:{channelId:targetChannelId,videoId:row.parent_video_id,topLevelComment:{snippet:{textOriginal:row.plain_text??row.final_text}}}}),cache:'no-store',signal:AbortSignal.timeout(20000)});
    body=await response.json().catch(()=>null);
  }catch{
    await recordYouTubeCommentFailure(db,row.id,'YOUTUBE_COMMENT_OUTCOME_UNKNOWN',{unknown:true});
    return {published:0,unknown:1};
  }
  if(!response.ok){
    const code=typeof body?.error?.errors?.[0]?.reason==='string'?`YOUTUBE_${body.error.errors[0].reason.toUpperCase().replace(/[^A-Z0-9]+/g,'_')}`:'YOUTUBE_COMMENT_REJECTED';
    await recordYouTubeCommentFailure(db,row.id,code,{unknown:(response.status>=500||response.status===408||response.status===429)});
    return {published:0,failed:(response.status>=500||response.status===408||response.status===429)?0:1,unknown:(response.status>=500||response.status===408||response.status===429)?1:0};
  }
  const thread=body?.items?.[0]??body,comment=thread?.snippet?.topLevelComment;
  if(typeof thread?.id!=='string'||typeof comment?.id!=='string'){
    await recordYouTubeCommentFailure(db,row.id,'YOUTUBE_COMMENT_RESPONSE_INVALID',{unknown:true});
    return {published:0,unknown:1};
  }
  await recordYouTubeCommentPublished(db,row.id,{threadId:thread.id,commentId:comment.id,
    publishedAt:comment.snippet?.publishedAt??new Date().toISOString()});
  return {published:1};
}

export async function appendVisibleCommentLink(db,{verify=verifyYouTubeCommentTarget,accessToken=defaultAccessToken,fetchImpl=fetch}={}){
  const row=await claimCommentLinkUpdate(db);
  if(!row)return {edited:0};
  try{
    if(row.approved_channel_id!==row.channel_id)throw Error('YOUTUBE_COMMENT_APPROVAL_CHANGED');
    await verify(row);
    const token=await accessToken(row);
    const response=await fetchImpl(API+'/comments?part=snippet',{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({id:row.youtube_comment_id,snippet:{textOriginal:row.linked_text}}),
      cache:'no-store',signal:AbortSignal.timeout(20000),
    });
    const body=await response.json().catch(()=>null);
    const ok=response.ok&&body?.id===row.youtube_comment_id;
    await finishCommentLinkUpdate(db,row,ok?null:'YOUTUBE_COMMENT_EDIT_UNCONFIRMED');
    return {edited:ok?1:0};
  }catch{
    await finishCommentLinkUpdate(db,row,'YOUTUBE_COMMENT_EDIT_UNCONFIRMED');
    return {edited:0};
  }
}

export async function dispatchYouTubeComments(db){
  let polled=0,submitted=0,completed=0,failed=0;
  const verification=await verifyPendingYouTubeCommentDrafts(db);
  if(grokBatchConfigured()){
  const {rows:batches}=await db.query(`SELECT DISTINCT batch_id FROM youtube_short_comments WHERE state='submitted'
    AND batch_id IS NOT NULL ORDER BY batch_id LIMIT 20`);
  for(const {batch_id} of batches){
    const status=await readGrokBatch(batch_id);if(!status||status.pending!==0)continue;
    const results=await readGrokBatchResults(batch_id);if(!results.complete)continue;
    completed+=await completeYouTubeCommentDraftBatch(db,batch_id,results.results);polled++;
  }
  }
  const jobs=await queueYouTubeCommentDrafts(db,{autoGenerate:grokBatchConfigured()});
  for(const job of jobs){
    const result=await requestGrokDirect({system,input:bounded(job.input_snapshot)});
    await completeYouTubeCommentDirect(db,job.id,result);
    if(result.error)failed++;else completed++;
  }
  const editing=await appendVisibleCommentLink(db);
  const publication=await publishOne(db);
  return {polled,submitted,completed,failed,...editing,...verification,skipped:!grokBatchConfigured()?'GROK_NOT_CONFIGURED':null,...publication};
}
