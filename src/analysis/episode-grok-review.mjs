import {claimDirectGrokReviews,claimGrokReviewBatch,completeDirectGrokReview,completeGrokReviewBatch,failDirectGrokReview,
  saveGrokReviewSubmission} from '../db/episode-grok.mjs';
import {grokBatchConfigured,readGrokBatch,readGrokBatchResults,submitGrokBatch} from './grok-batch.mjs';
import {requestGrokDirect} from './grok-direct.mjs';

export const GROK_REVIEW_SYSTEM=`You are an editorial development reviewer for a Ukrainian-language fact-checking video channel. Review a proposed script BEFORE any video is generated. Compare the draft with the claim/source material and the channel's own prior YouTube performance. Do not assert plagiarism or factual truth from similarity alone. Identify what is genuinely distinctive, what is derivative or vague, and what could make the story clearer and more compelling. Return JSON only: {"originalityScore":0-100,"interestScore":0-100,"summary":"...","strengths":["..."],"recommendations":[{"change":"specific edit","reason":"why it helps","priority":"high|medium|low"}],"factRisks":["..."],"limits":"..."}. Give 3-5 concrete changes that the editor can apply manually. Scores are editorial estimates, not objective measurements. Do not rewrite the full script. Keep all recommendations in Ukrainian.`;
const bounded=value=>{
  const text=JSON.stringify(value);
  return text.length>12000?text.slice(0,12000)+'…[обрізано для лиміту]':text;
};

// Direct mode: one synchronous chat-completions call per review. With id it runs the review just queued
// by the editor (called from after()); without id the cron tick picks up anything after() did not finish.
export async function runDirectGrokReviews(db,{id=null,limit=3,request=requestGrokDirect}={}){
  const jobs=await claimDirectGrokReviews(db,{id,limit});
  let completed=0,failed=0;
  for(const job of jobs){
    const response=await request({system:GROK_REVIEW_SYSTEM,input:bounded(job.input_snapshot)});
    if(response.error){await failDirectGrokReview(db,job.id,response.error,response.outcomeUnknown===true);failed++;continue;}
    if(await completeDirectGrokReview(db,job.id,response.text)==='failed')failed++;else completed++;
  }
  return {claimed:jobs.length,completed,failed};
}

export async function dispatchEpisodeGrokReviews(db){
  if(!grokBatchConfigured())return {skipped:'GROK_NOT_CONFIGURED'};
  const direct=await runDirectGrokReviews(db);
  let polled=0,submitted=0,completed=0,failed=0;
  const {rows:batches}=await db.query(`SELECT DISTINCT batch_id FROM episode_grok_reviews WHERE state='submitted'
    AND batch_id IS NOT NULL ORDER BY batch_id LIMIT 20`);
  for(const {batch_id} of batches){
    const status=await readGrokBatch(batch_id);
    if(!status||status.pending!==0)continue;
    const results=await readGrokBatchResults(batch_id);
    if(!results.complete)continue;
    completed+=await completeGrokReviewBatch(db,batch_id,results.results);polled++;
  }
  const jobs=await claimGrokReviewBatch(db);
  if(jobs.length){
    const items=jobs.map(row=>({id:row.batch_request_id,system:GROK_REVIEW_SYSTEM,input:bounded(row.input_snapshot)}));
    const result=await submitGrokBatch('tin-shariia-editorial-preflight',items);
    const ids=jobs.map(row=>row.id);
    await saveGrokReviewSubmission(db,ids,result.batchId??null,result.error??null,result.unknown===true);
    if(result.error)failed+=jobs.length;else submitted=jobs.length;
  }
  return {direct,polled,submitted,completed,failed};
}
