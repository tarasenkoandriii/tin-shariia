import {requestGrokDirect} from '../analysis/grok-direct.mjs';
import {verifyYouTubeCommentTarget} from './comment-target.mjs';
import {decryptYouTubeSecret,refreshYouTubeAccessToken,youtubeOAuthConfig} from './oauth.mjs';
import {claimScheduledYouTubeComment,completeYouTubeCommentDraftBatch,queueYouTubeCommentDrafts,
  recordYouTubeCommentFailure,recordYouTubeCommentPublished,completeYouTubeCommentDirect} from '../db/youtube-comments.mjs';
import {grokBatchConfigured,readGrokBatch,readGrokBatchResults} from '../analysis/grok-batch.mjs';

const API='https://www.googleapis.com/youtube/v3';
const system=`Write one concise, factual Ukrainian YouTube comment (1-2 sentences) under the specified target video, explaining what its related Short adds or illustrates. Use only the supplied approved script and claim context; do not add facts, accusations, hashtags, calls for likes, or external links. Keep it specific to these videos and natural, never a repeated template. Return JSON only: {"comment":"..."}. The application will append a tracked Short link after an editor reviews and approves the exact final comment.`;
const bounded=value=>{const text=JSON.stringify(value);return text.length>10000?text.slice(0,10000)+'…':text;};

const defaultAccessToken=row=>refreshYouTubeAccessToken(decryptYouTubeSecret(row.refresh_token_encrypted),youtubeOAuthConfig());

export async function publishOne(db,{verify=verifyYouTubeCommentTarget,fetchImpl=fetch,accessToken=defaultAccessToken}={}){
  const row=await claimScheduledYouTubeComment(db);if(!row)return {published:0};
  let targetChannelId,token;
  try {
    if(row.approved_channel_id && row.approved_channel_id!==row.channel_id) throw Error('YOUTUBE_COMMENT_APPROVAL_CHANGED');
    targetChannelId=await verify(row);
    token=await accessToken(row);
  } catch(error){
    const code=/^YOUTUBE_COMMENT_[A-Z_]+$/.test(error?.message)?error.message:'YOUTUBE_COMMENT_AUTH_FAILED';
    await recordYouTubeCommentFailure(db,row.id,code);
    return {published:0,failed:1};
  }
  let response,body;
  try{
    const url=new URL(`${API}/commentThreads`);url.searchParams.set('part','snippet');
    response=await fetchImpl(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({snippet:{channelId:targetChannelId,videoId:row.parent_video_id,topLevelComment:{snippet:{textOriginal:row.final_text}}}}),cache:'no-store',signal:AbortSignal.timeout(20000)});
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

export async function dispatchYouTubeComments(db){
  let polled=0,submitted=0,completed=0,failed=0;
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
  const publication=await publishOne(db);
  return {polled,submitted,completed,failed,skipped:!grokBatchConfigured()?'GROK_NOT_CONFIGURED':null,...publication};
}
