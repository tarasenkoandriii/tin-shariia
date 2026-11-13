import {decryptYouTubeSecret,refreshYouTubeAccessToken,youtubeOAuthConfig} from './oauth.mjs';
import {claimScheduledYouTubeComment,completeYouTubeCommentDraftBatch,queueYouTubeCommentDrafts,
  recordYouTubeCommentFailure,recordYouTubeCommentPublished,saveYouTubeCommentDraftSubmission} from '../db/youtube-comments.mjs';
import {grokBatchConfigured,readGrokBatch,readGrokBatchResults,submitGrokBatch} from '../analysis/grok-batch.mjs';

const API='https://www.googleapis.com/youtube/v3';
const system=`Write one concise, factual Ukrainian YouTube comment (1-2 sentences) under the main video, explaining what its related Short adds or illustrates. Use only the supplied approved script and claim context; do not add facts, accusations, hashtags, calls for likes, or external links. Keep it specific to these videos and natural, never a repeated template. Return JSON only: {"comment":"..."}. The application will append a tracked Short link after an editor reviews and approves the exact final comment.`;
const bounded=value=>{const text=JSON.stringify(value);return text.length>10000?text.slice(0,10000)+'…':text;};

async function publishOne(db){
  const row=await claimScheduledYouTubeComment(db);if(!row)return {published:0};
  let response,body;
  try{
    const token=await refreshYouTubeAccessToken(decryptYouTubeSecret(row.refresh_token_encrypted),youtubeOAuthConfig());
    const url=new URL(`${API}/commentThreads`);url.searchParams.set('part','snippet');
    response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({snippet:{videoId:row.parent_video_id,topLevelComment:{snippet:{textOriginal:row.final_text}}}}),cache:'no-store'});
    body=await response.json().catch(()=>null);
  }catch{
    await recordYouTubeCommentFailure(db,row.id,'YOUTUBE_COMMENT_OUTCOME_UNKNOWN',{unknown:true});
    return {published:0,unknown:1};
  }
  if(!response.ok){
    const code=typeof body?.error?.errors?.[0]?.reason==='string'?`YOUTUBE_${body.error.errors[0].reason.toUpperCase().replace(/[^A-Z0-9]+/g,'_')}`:'YOUTUBE_COMMENT_REJECTED';
    await recordYouTubeCommentFailure(db,row.id,code,{unknown:response.status>=500});
    return {published:0,failed:response.status>=500?0:1,unknown:response.status>=500?1:0};
  }
  const thread=body?.items?.[0],comment=thread?.snippet?.topLevelComment;
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
  const jobs=await queueYouTubeCommentDrafts(db);
  if(jobs.length){
    const result=await submitGrokBatch('tin-shariia-youtube-short-comments',jobs.map(row=>({id:row.batch_request_id,system,input:bounded(row.input_snapshot)})));
    await saveYouTubeCommentDraftSubmission(db,jobs.map(row=>row.id),result.batchId??null,result.error??null,result.unknown===true);
    if(result.error)failed=jobs.length;else submitted=jobs.length;
  }
  }
  const publication=await publishOne(db);
  return {polled,submitted,completed,failed,skipped:!grokBatchConfigured()?'GROK_NOT_CONFIGURED':null,...publication};
}
