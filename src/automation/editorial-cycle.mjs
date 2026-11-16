import {createHash, randomUUID} from 'node:crypto';

export const cycleStages = ['discover','captions','factcheck','scenario','grok','render','audit','upload','comment','visibility'];
const terminal = new Set(['completed','skipped','unknown','blocked']);
const publicationStages = new Set(['upload','comment']);
const normal = value => String(value).normalize('NFC').replace(/\s+/gu,' ').trim();
const idPattern = /^[\w-]{11}$/;
const fail = code => { throw Error(code); };

// The hash binds the publication authorization to this exact source and release.
export function cycleAuthorization({sourceVideoId,sourceChannelId,scenarioHash,mediaHash,commentText,shortLink}) {
  return createHash('sha256').update(JSON.stringify([sourceVideoId,sourceChannelId,scenarioHash,mediaHash,commentText,shortLink])).digest('hex');
}

export function validateCycleOutput(stage, output, artifacts, policy) {
  if (!output || typeof output !== 'object') fail('CYCLE_RESULT_INVALID');
  if (output.wait === true || output.skip === true) return output;
  const source = artifacts.discover;
  if (stage === 'discover') {
    if (!idPattern.test(output.videoId??'') || !/^UC[\w-]{22}$/.test(output.channelId??'')
      || output.channelId !== policy.sourceChannelId) fail('CYCLE_SOURCE_INVALID');
  }
  if (stage === 'captions') {
    if (output.videoId !== source.videoId || !Array.isArray(output.segments) || !output.segments.length
      || output.segments.length > 12000 || !output.segments.every(s => typeof s.text === 'string'
        && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.startMs >= 0 && s.endMs > s.startMs)) fail('CYCLE_TRANSCRIPT_INVALID');
  }
  if (stage === 'factcheck') {
    // No-source and unconfirmed results are never converted to a negative verdict.
    if (output.discrepancy !== true) return {...output,skip:true,code:'NO_CONFIRMED_DISCREPANCY'};
    if (output.kind !== 'fact' || output.paraphrase !== false || output.confirmed !== true
      || !['false','missing_context','partially_confirmed'].includes(output.verdict)
      || !Array.isArray(output.evidence) || output.evidence.length < 2
      || !(output.evidence.some(e => e.primary === true)
        || (output.verdict === 'missing_context'
          && new Set(output.evidence.map(e => new URL(e.url).hostname)).size >= 2))
      || !output.evidence.every(e => /^https:\/\//.test(e.url??'') && typeof e.excerpt === 'string' && e.excerpt.trim())) fail('CYCLE_EVIDENCE_REQUIRED');
    if (!Number.isFinite(output.startMs) || !Number.isFinite(output.endMs)
      || output.startMs < 0 || output.endMs <= output.startMs || output.endMs-output.startMs > 30000) fail('CYCLE_QUOTE_INVALID');
    const context=artifacts.captions.segments.filter(s=>s.endMs>output.startMs&&s.startMs<output.endMs).map(s=>s.text).join(' ');
    if (!normal(context).includes(normal(output.quote))) fail('CYCLE_QUOTE_MISMATCH');
  }
  if (stage === 'scenario') {
    if (!output.episodeId || !output.scenarioHash || output.sourceVideoId !== source.videoId
      || output.claimApproved !== true || output.episodeApproved !== true) fail('CYCLE_SCENARIO_NOT_APPROVED');
  }
  if (stage === 'grok') {
    if (output.mode !== 'direct' || output.scenarioHash !== artifacts.scenario.scenarioHash
      || !Array.isArray(output.factRisks) || output.factRisks.length
      || ![output.originalityScore,output.interestScore].every(n=>Number.isFinite(n)&&n>=0&&n<=100)
      || Math.max(output.originalityScore,output.interestScore) <= policy.scoreThreshold) fail('CYCLE_GROK_NOT_ACCEPTED');
  }
  if (stage === 'render') {
    if (output.sourceVideoId !== source.videoId || output.quotePlaybackRate !== 1
      || output.quoteOriginalAudio !== true || output.audioContinuous !== true
      || output.scenarioHash !== artifacts.scenario.scenarioHash || !/^[a-f0-9]{64}$/.test(output.mediaHash??'')
      || output.narration?.provider !== 'soniox' || output.narration.model !== 'tts-rt-v2'
      || output.narration.voice !== 'Maya' || output.narration.language !== 'uk' || output.narration.speed !== 1.15
      || output.collagesContainQuote !== false || output.finalPhotoCount !== 1 || output.verdictPaddingVerified !== true) fail('CYCLE_MEDIA_INVALID');
  }
  if (stage === 'audit') {
    if (output.mediaHash !== artifacts.render.mediaHash || output.passed !== true || output.unresolvedFindings !== 0) fail('CYCLE_AUDIT_REQUIRED');
  }
  if (stage === 'upload') {
    if (!idPattern.test(output.youtubeId??'') || output.mediaHash !== artifacts.render.mediaHash
      || output.privacy !== 'public' || output.processing !== 'processed'
      || output.channelId !== policy.ownChannelId || output.youtubeAudioVerified !== true
      || !Number.isFinite(Date.parse(output.publishedAt??''))) fail('CYCLE_UPLOAD_NOT_VERIFIED');
  }
  if (stage === 'comment') {
    if (output.sourceVideoId !== source.videoId || output.shortVideoId !== artifacts.upload.youtubeId
      || output.channelId !== policy.ownChannelId || !output.commentId
      || !((output.linkMode==='direct' && output.shortLink==='youtube.com/shorts/'+artifacts.upload.youtubeId)
        || (output.trackingToken && /^https:\/\/(share\.google|is\.gd|v\.gd|tinyurl\.com)\//.test(output.shortLink??'') && output.trackingVerified===true))) fail('CYCLE_COMMENT_INVALID');
  }
  if (stage === 'visibility') {
    if (output.commentId !== artifacts.comment.commentId || output.reloaded !== true
      || output.visible !== true || output.linkPresent !== true
      || !(output.screenshotPath || output.verificationMethod==='incognito-reload')) fail('CYCLE_COMMENT_NOT_VISIBLE');
  }
  return output;
}

// Store owns atomic leases. Handlers reuse project services; never persist secrets in artifacts.
// One tick does one stage. The dispatcher can restart without reconstructing a chat.
export async function tickEditorialCycle(store, id, handlers, {now=()=>Date.now()}={}) {
  const lease=await store.claim(id,randomUUID(),now());
  if (!lease) return {claimed:false};
  const job=lease.job, stage=cycleStages[job.stageIndex];
  if (terminal.has(job.state) || !stage) return {claimed:false};
  const key=createHash('sha256').update(`${job.id}:${stage}:${JSON.stringify(job.artifacts)}`).digest('hex');
  try {
    if ((stage==='comment'||stage==='visibility') && job.policy.promotionEnabled===false) {
      await store.finish(id,lease.token,{state:'completed',promotionState:'skipped',code:'PROMOTION_DISABLED'});
      return {stage,state:'completed',releaseState:job.releaseState};
    }
    if (stage==='comment' && job.artifacts.discover.commentsError==='commentsDisabled') {
      await store.finish(id,lease.token,{state:'completed',promotionState:'skipped',code:'SOURCE_COMMENTS_DISABLED'});
      return {stage,state:'completed',releaseState:job.releaseState};
    }
    if (typeof handlers[stage] !== 'function') throw Object.assign(Error('CYCLE_HANDLER_UNAVAILABLE'),{beforeSend:true});
    if (publicationStages.has(stage) && job.policy.publishApproved !== true) throw Object.assign(Error('CYCLE_PUBLICATION_NOT_AUTHORIZED'),{beforeSend:true});
    const raw=await handlers[stage]({job,artifacts:job.artifacts,policy:job.policy,idempotencyKey:key});
    const output=validateCycleOutput(stage,raw,job.artifacts,job.policy);
    if (output.wait === true) {
      await store.finish(id,lease.token,{state:'waiting',code:output.code??'WAITING',retryAt:now()+15000});
      return {stage,state:'waiting'};
    }
    if (stage==='factcheck' && output.skip===true) {
      const checkedSources=[...(job.artifacts.checkedSources??[]),{videoId:job.artifacts.discover.videoId,code:output.code??'NO_CONFIRMED_DISCREPANCY'}];
      const exhausted=checkedSources.length>=(job.policy.maxCandidates??10);
      await store.finish(id,lease.token,{state:exhausted?'skipped':'queued',stageIndex:0,artifacts:{checkedSources},code:output.code??null});
      return {stage,state:exhausted?'skipped':'queued',nextSource:!exhausted};
    }
    const artifacts={...job.artifacts,[stage]:output};
    const release=stage==='upload'?{releaseState:'published',youtubeId:output.youtubeId,publishedAt:output.publishedAt}:{};
    const state=output.skip===true?'skipped':job.stageIndex===cycleStages.length-1?'completed':'queued';
    await store.finish(id,lease.token,{state,artifacts,...release,stageIndex:job.stageIndex+(output.skip?0:1),code:output.code??null});
    return {stage,state};
  } catch (error) {
    // Handler errors after a mutating request are uncertain unless explicitly certified pre-send.
    const state=error.outcomeUnknown===true||(publicationStages.has(stage)&&error.beforeSend!==true)?'unknown':'blocked';
    const code=/^[A-Z][A-Z0-9_]{1,99}$/.test(error.message??'')?error.message:'CYCLE_STAGE_FAILED';
    const promotion=job.releaseState==='published' && (stage==='comment'||stage==='visibility');
    await store.finish(id,lease.token,{state:promotion?'completed':state,code,...(promotion?{promotionState:state}:{})});
    return {stage,state:promotion?'completed':state,code,...(promotion?{releaseState:'published',promotionState:state}:{})};
  }
}
