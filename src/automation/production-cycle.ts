import {createHash} from 'node:crypto';
import type {z} from 'zod';
import {cycleSeedSchema} from './cycle-input.mjs';
import {reserveSoniox} from '../analysis/soniox-quota';
import {editorialNarration} from '../analysis/editorial-narration.mjs';
import {projectSourceHandlers} from './project-cycle-handlers.mjs';
import {verifyCaseEvidence,createCaseScenario} from './verified-case.mjs';
import {registerGeneratedShort} from './generated-short.mjs';
import {queueEpisodeGrokReview} from '../db/episode-grok.mjs';
import {runDirectGrokReviews} from '../analysis/episode-grok-review.mjs';
import {enqueueVideoAudit} from '../analysis/queue.mjs';
import {analysisConfig} from '../analysis/config.mjs';
import {reviewVideoAudit} from '../db/video-audit.mjs';
import {dispatchSources} from '../workflows/dispatch';
import {dispatchMontages} from '../workflows/montage-dispatch';
import {createYouTubeShortUpload} from '../db/youtube-uploads.mjs';
import {youtubeUploadStep} from '../youtube/upload.mjs';
import {database} from '../db/runtime.mjs';
import {dbCycleStore} from './db-cycle-store.mjs';
import {tickEditorialCycle} from './editorial-cycle.mjs';

type DB=Awaited<ReturnType<typeof database>>;
type Seed=z.infer<typeof cycleSeedSchema>;
type Data={job:{id:string};policy:{seed:Seed;ownChannelId:string};artifacts:{
 discover:{videoId:string;videoRecordId:string;channelId:string};
 captions:{transcriptId:string};factcheck:{startMs:number;endMs:number;quote:string};
 scenario:{episodeId:string;version:number;scenarioHash:string};
 render:{mediaId:string;mediaHash:string;shortId:string};
}};
const wait=(code:string)=>({wait:true,code});
const certain=(code:string)=>Object.assign(Error(code),{beforeSend:true});
export function productionCycleHandlers(db:DB,identity:string) {
 return {
  ...projectSourceHandlers(db,identity),
  async factcheck({job,policy}:Data) {
   if(!policy.seed?.editorVerified)throw certain('CYCLE_EDITORIAL_CASE_REQUIRED');
   const {rows:[task]}=await db.query("SELECT * FROM editorial_cycle_media_tasks WHERE cycle_id=$1 AND kind='evidence'",[job.id]);
   if(task?.state==='done')return task.output;
   if(task&&['failed','unknown'].includes(task.state))throw certain(task.error_code??'CYCLE_SOURCE_UNAVAILABLE');
   if(task)return wait('CYCLE_EVIDENCE_PENDING');
   try{return await verifyCaseEvidence(policy.seed);}catch(error){
    if(!['CYCLE_SOURCE_UNAVAILABLE','TypeError','TimeoutError'].includes((error as Error).message)&&!['TypeError','TimeoutError'].includes((error as Error).name))throw error;
    await db.query("INSERT INTO editorial_cycle_media_tasks(cycle_id,kind,state,input) VALUES($1,'evidence','queued',$2::text::jsonb) ON CONFLICT DO NOTHING",[job.id,JSON.stringify({seed:policy.seed})]);
    return wait('CYCLE_EVIDENCE_PENDING');
   }
  },
  async scenario({artifacts,policy}:Data) {return createCaseScenario(db,identity,artifacts,policy.seed);},
  async grok({artifacts}:Data) {
   const {episodeId,version,scenarioHash}=artifacts.scenario;
   let {rows:[row]}=await db.query('SELECT * FROM episode_grok_reviews WHERE episode_id=$1 AND episode_version=$2 ORDER BY round DESC LIMIT 1',[episodeId,version]);
   if(!row){const review=await queueEpisodeGrokReview(db,identity,episodeId);row=review;}
   if(row.mode!=='direct')throw certain('CYCLE_DIRECT_MODE_REQUIRED');
   if(row.state==='queued')await runDirectGrokReviews(db,{id:row.id,limit:1});
   ({rows:[row]}=await db.query('SELECT * FROM episode_grok_reviews WHERE id=$1',[row.id]));
   if(['queued','submitting'].includes(row.state))return wait('GROK_REVIEW_PENDING');
   if(row.state==='unknown')throw Object.assign(Error('CYCLE_GROK_OUTCOME_UNKNOWN'),{outcomeUnknown:true});
   if(row.state!=='accepted')throw certain(row.error_code??'CYCLE_GROK_NOT_ACCEPTED');
   return {...row.result,reviewId:row.id,mode:'direct',scenarioHash};
  },
  async render({job,artifacts,policy}:Data) {
   let {rows:[task]}=await db.query("SELECT * FROM editorial_cycle_media_tasks WHERE cycle_id=$1 AND kind='render'",[job.id]);
   if(!task) {
    if(!process.env.SONIOX_API_KEY)throw certain('SONIOX_DISABLED');
    const {rows:[created]}=await db.query("INSERT INTO editorial_cycle_media_tasks(cycle_id,kind) VALUES($1,'render') ON CONFLICT DO NOTHING RETURNING *",[job.id]);
    if(!created)return wait('CYCLE_RENDER_PENDING');
    task=created;
    let ttsSent=false;
    try {
     await reserveSoniox(identity,task.id);
     const text=policy.seed.scenario.narrationText;
     if(typeof text!=='string'||text.length<30||text.length>650)throw certain('INVALID_INPUT');
     ttsSent=true;
     const r=await fetch('https://tts-rt.soniox.com/tts',{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
      headers:{Authorization:'Bearer '+process.env.SONIOX_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({...editorialNarration,text})});
     if(!r.ok)throw certain('SONIOX_PROVIDER_ERROR');
     const audio=Buffer.from(await r.arrayBuffer());if(audio.length<100)throw certain('SONIOX_AUDIO_INVALID');
     const input={videoId:artifacts.discover.videoId,channelId:artifacts.discover.channelId,startMs:artifacts.factcheck.startMs,endMs:artifacts.factcheck.endMs,
      scenarioHash:artifacts.scenario.scenarioHash,quoteCaption:artifacts.factcheck.quote,visualQueries:policy.seed.visualQueries,manifest:policy.seed.manifest,
      narration:{...editorialNarration,provider:'soniox',sha256:createHash('sha256').update(audio).digest('hex'),base64:audio.toString('base64')}};
     await db.query("UPDATE editorial_cycle_media_tasks SET state='queued',input=$2::text::jsonb,updated_at=now() WHERE id=$1",[task.id,JSON.stringify(input)]);
     return wait('CYCLE_RENDER_PENDING');
    } catch(error) {
     const known=!ttsSent||(error as {beforeSend?:boolean}).beforeSend===true;
     await db.query('UPDATE editorial_cycle_media_tasks SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',[task.id,known?'failed':'unknown',known?(error as Error).message:'SONIOX_OUTCOME_UNKNOWN']);
     if(!known)throw Object.assign(Error('SONIOX_OUTCOME_UNKNOWN'),{outcomeUnknown:true});
     throw error;
    }
   }
   if(task.state==='unknown')throw Object.assign(Error(task.error_code??'CYCLE_RENDER_OUTCOME_UNKNOWN'),{outcomeUnknown:true});
   if(task.state==='failed')throw certain(task.error_code??'CYCLE_MEDIA_INVALID');
   if(task.state!=='done')return wait('CYCLE_RENDER_PENDING');
   const {rows:[media]}=await db.query('SELECT * FROM episode_media_revisions WHERE id=$1',[task.output.mediaId]);
   if(['queued','checking'].includes(media?.state)){await dispatchMontages();return wait('CYCLE_TECH_CHECK_PENDING');}
   if(media?.state!=='passed'||media.sha256!==task.output.mediaHash)throw certain('CYCLE_MEDIA_INVALID');
   const short=await registerGeneratedShort(db,identity,artifacts.scenario.episodeId,media.id,policy.seed.scenario);
   return {...task.output,...short,mediaHash:media.sha256,sourceVideoId:artifacts.discover.videoId,
    scenarioHash:artifacts.scenario.scenarioHash,narration:{provider:'soniox',...editorialNarration},
    quotePlaybackRate:1,quoteOriginalAudio:true,audioContinuous:task.output.audioContinuous,
    collagesContainQuote:false,finalPhotoCount:1,verdictPaddingVerified:true};
  },
  async audit({artifacts}:Data) {
   const {mediaId,mediaHash}=artifacts.render,episodeId=artifacts.scenario.episodeId;
   const queued=await enqueueVideoAudit(db,identity,episodeId,mediaId,{},analysisConfig());
   if(['queued','running'].includes(queued.status)){await dispatchSources();return wait('CYCLE_VIDEO_AUDIT_PENDING');}
   if(queued.status!=='succeeded')throw certain('CYCLE_VIDEO_AUDIT_FAILED');
   const {rows:[audit]}=await db.query('SELECT * FROM prepublication_audits WHERE job_id=$1 AND attempt=$2',[queued.id,queued.attempt]);
   const {rows:findings}=await db.query('SELECT * FROM audit_findings WHERE job_id=$1 AND attempt=$2',[queued.id,queued.attempt]);
   if(!audit||findings.length)throw certain('CYCLE_AUDIT_FINDINGS_OPEN');
   await reviewVideoAudit(db,identity,episodeId,mediaId,{action:'approve'});
   return {mediaHash,passed:true,unresolvedFindings:0,editingScore:audit.editing_score,jobId:queued.id};
  },
  async upload({job,artifacts,policy}:Data) {
   const {rows:[connection]}=await db.query('SELECT channel_id FROM youtube_connections WHERE owner_id=(SELECT id FROM members WHERE clerk_user_id=$1) AND disconnected_at IS NULL',[identity]);
   if(connection?.channel_id!==policy.ownChannelId)throw certain('CYCLE_OWN_CHANNEL_CHANGED');
   const {rows:[existing]}=await db.query('SELECT u.*,c.channel_id AS actual_channel_id FROM youtube_short_uploads u JOIN youtube_connections c ON c.id=u.connection_id WHERE u.media_revision_id=$1',[artifacts.render.mediaId]);
   if(existing&&existing.actual_channel_id!==policy.ownChannelId)throw certain('CYCLE_OWN_CHANNEL_CHANGED');
   const upload=existing??await createYouTubeShortUpload(db,identity,artifacts.scenario.episodeId,artifacts.render.shortId,{
    confirmed:true,aiDisclosureConfirmed:true,privacyStatus:'public',idempotencyKey:job.id,
    title:policy.seed.scenario.title,description:policy.seed.scenario.description,reviewedSha256:artifacts.render.mediaHash});
   if(upload.state==='unknown')throw Object.assign(Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN'),{outcomeUnknown:true});
   if(upload.state==='failed')throw certain(upload.error_code??'YOUTUBE_UPLOAD_REJECTED');
   if(upload.state!=='published'){await youtubeUploadStep(db,upload.id);return wait('CYCLE_YOUTUBE_PROCESSING');}
   const {rows:[check]}=await db.query("SELECT * FROM editorial_cycle_media_tasks WHERE cycle_id=$1 AND kind='youtube_audio'",[job.id]);
   if(!check){
    await db.query("INSERT INTO editorial_cycle_media_tasks(cycle_id,kind,state,input) VALUES($1,'youtube_audio','queued',$2::text::jsonb) ON CONFLICT DO NOTHING",[job.id,JSON.stringify({youtubeId:upload.youtube_id,mediaId:artifacts.render.mediaId,mediaHash:artifacts.render.mediaHash})]);
    return wait('CYCLE_YOUTUBE_AUDIO_PENDING');
   }
   if(check.state==='unknown')throw Object.assign(Error('CYCLE_YOUTUBE_AUDIO_FAILED'),{outcomeUnknown:true});
   if(check.state==='failed')throw certain(check.error_code??'CYCLE_YOUTUBE_AUDIO_FAILED');
   if(check.state!=='done')return wait('CYCLE_YOUTUBE_AUDIO_PENDING');
   if(check.output?.audioVerified!==true)throw certain('CYCLE_YOUTUBE_AUDIO_FAILED');
   const {rows:[event]}=await db.query("SELECT created_at FROM youtube_upload_events WHERE upload_id=$1 AND action='published' ORDER BY created_at DESC LIMIT 1",[upload.id]);
   return {youtubeId:upload.youtube_id,mediaHash:artifacts.render.mediaHash,privacy:upload.actual_privacy_status,
    processing:upload.processing_status,channelId:existing?.actual_channel_id??connection.channel_id,youtubeAudioVerified:true,
    publishedAt:event?.created_at??upload.updated_at,audioVerification:check.output};
  },
 };
}

export async function advanceProductionCycle(id:string):Promise<{done:boolean;state?:string;claimed?:boolean;releaseState?:string}> {
 const db=await database();
 const {rows:[row]}=await db.query('SELECT m.clerk_user_id,c.state FROM editorial_cycles c JOIN members m ON m.id=c.created_by WHERE c.id=$1',[id]);
 if(!row)return {done:true};
 const result=await tickEditorialCycle(dbCycleStore(db,row.clerk_user_id),id,productionCycleHandlers(db,row.clerk_user_id));
 const {rows:[current]}=await db.query('SELECT state,release_state FROM editorial_cycles WHERE id=$1',[id]);
 return {...result,done:['completed','blocked','skipped','unknown'].includes(current.state),releaseState:current.release_state};
}
