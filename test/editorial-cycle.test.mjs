import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cycleStages,tickEditorialCycle,validateCycleOutput} from '../src/automation/editorial-cycle.mjs';
import {fileCycleStore} from '../src/automation/file-cycle-store.mjs';

const sourceVideoId='NW9nJlYM0XU', sourceChannelId='UC'+'a'.repeat(22), ownChannelId='UC'+'b'.repeat(22);
const policy={sourceChannelId,ownChannelId,scoreThreshold:75,publishApproved:true,maxCandidates:1};
const hash='a'.repeat(64);
function outputs(){return {
 discover:{videoId:sourceVideoId,channelId:sourceChannelId,commentsHttp:200},
 captions:{videoId:sourceVideoId,segments:[{startMs:1000,endMs:3000,text:'Дослівна перевірювана цитата.'}]},
 factcheck:{discrepancy:true,kind:'fact',paraphrase:false,confirmed:true,verdict:'false',startMs:1000,endMs:3000,
  quote:'Дослівна перевірювана цитата.',evidence:[{primary:true,url:'https://example.org/doc',excerpt:'Первинне джерело'},{primary:false,url:'https://example.com/doc',excerpt:'Незалежне джерело'}]},
 scenario:{episodeId:'episode',scenarioHash:hash,sourceVideoId,claimApproved:true,episodeApproved:true},
 grok:{mode:'direct',scenarioHash:hash,originalityScore:55,interestScore:78,factRisks:[]},
 render:{sourceVideoId,scenarioHash:hash,mediaHash:hash,quotePlaybackRate:1,quoteOriginalAudio:true,audioContinuous:true,
  narration:{provider:'soniox',model:'tts-rt-v2',voice:'Maya',language:'uk',speed:1.15},collagesContainQuote:false,finalPhotoCount:1,verdictPaddingVerified:true},
 audit:{mediaHash:hash,passed:true,unresolvedFindings:0},
 upload:{youtubeId:'TBBj5PBD2rk',channelId:ownChannelId,mediaHash:hash,privacy:'public',publishedAt:'2026-11-15T06:00:00.000Z',processing:'processed',youtubeAudioVerified:true},
 comment:{sourceVideoId,shortVideoId:'TBBj5PBD2rk',channelId:ownChannelId,commentId:'comment',trackingToken:'unique',shortLink:'https://is.gd/example',trackingVerified:true},
 visibility:{commentId:'comment',reloaded:true,visible:true,linkPresent:true,screenshotPath:'proof.png'},
};}
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'editorial-cycle-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=fileCycleStore(dir);return {store,job:await store.create(policy)};}

test('one command tick sequence preserves results through store reload, no repeated stage',async t=>{
 const {store,job}=await setup(t), result=outputs(),calls=[];
 const handlers=Object.fromEntries(cycleStages.map(s=>[s,async({idempotencyKey})=>{calls.push([s,idempotencyKey]);return result[s];}]));
 for(const stage of cycleStages)assert.equal((await tickEditorialCycle(store,job.id,handlers)).stage,stage);
 assert.equal((await store.load(job.id)).state,'completed');
 assert.equal((await tickEditorialCycle(store,job.id,handlers)).claimed,false);
 assert.equal(calls.length,10);assert.equal(new Set(calls.map(x=>x[1])).size,10);
});
test('parallel dispatcher claims the source only once',async t=>{
 const {store,job}=await setup(t);let calls=0;
 const handlers={discover:async()=>{calls++;return outputs().discover;}};
 await Promise.all([tickEditorialCycle(store,job.id,handlers),tickEditorialCycle(store,job.id,handlers)]);
 assert.equal(calls,1);
});
test('no discrepancy terminates before scenario, voice or upload',async t=>{
 const {store,job}=await setup(t),o=outputs();let writes=0;
 const handlers={discover:async()=>o.discover,captions:async()=>o.captions,factcheck:async()=>({discrepancy:false}),scenario:async()=>{writes++;}};
 for(let i=0;i<3;i++)await tickEditorialCycle(store,job.id,handlers);
 assert.equal((await store.load(job.id)).state,'skipped');assert.equal(writes,0);
});
test('wait resumes at the same stage and uses the same idempotency key',async t=>{
 const {store,job}=await setup(t);let clock=Date.now(),count=0;const keys=[];
 const handlers={discover:async({idempotencyKey})=>{keys.push(idempotencyKey);return ++count===1?{wait:true}:outputs().discover;}};
 await tickEditorialCycle(store,job.id,handlers,{now:()=>clock});clock+=16000;
 await tickEditorialCycle(store,job.id,handlers,{now:()=>clock});assert.equal(keys[0],keys[1]);
});
test('unknown post outcome is not automatically retried',async t=>{
 const {store,job}=await setup(t),o=outputs(),handlers=Object.fromEntries(cycleStages.map(s=>[s,async()=>o[s]]));
 for(let i=0;i<8;i++)await tickEditorialCycle(store,job.id,handlers);
 let sent=0;handlers.comment=async()=>{sent++;throw Error('OUTCOME_UNKNOWN');};
 const result=await tickEditorialCycle(store,job.id,handlers);
 assert.equal(result.state,'completed');assert.equal(result.promotionState,'unknown');assert.equal(result.releaseState,'published');
 await tickEditorialCycle(store,job.id,handlers);assert.equal(sent,1);
});
test('approval absent blocks before network',async t=>{
 const {store,job}=await setup(t),o=outputs(),handlers=Object.fromEntries(cycleStages.map(s=>[s,async()=>o[s]]));
 for(let i=0;i<7;i++)await tickEditorialCycle(store,job.id,handlers);
 const lease=await store.claim(job.id,'token',Date.now());lease.job.policy.publishApproved=false;
 await store.finish(job.id,lease.token,{state:'queued',policy:lease.job.policy});
 let sent=false;handlers.upload=async()=>{sent=true;return o.upload;};
 assert.equal((await tickEditorialCycle(store,job.id,handlers)).state,'blocked');assert.equal(sent,false);
});
test('rejects a repost, invented quote, no evidence, predictions and stale Grok result',()=>{
 const o=outputs();
 assert.throws(()=>validateCycleOutput('discover',{...o.discover,channelId:ownChannelId},{},policy),/SOURCE_INVALID/);
 assert.throws(()=>validateCycleOutput('factcheck',{...o.factcheck,quote:'Чужі слова'},o,policy),/QUOTE_MISMATCH/);
 assert.throws(()=>validateCycleOutput('factcheck',{...o.factcheck,evidence:[]},o,policy),/EVIDENCE_REQUIRED/);
 assert.throws(()=>validateCycleOutput('factcheck',{...o.factcheck,kind:'prediction'},o,policy),/EVIDENCE_REQUIRED/);
 assert.throws(()=>validateCycleOutput('grok',{...o.grok,scenarioHash:'other'},o,policy),/GROK_NOT_ACCEPTED/);
});
test('one score strictly above 75 suffices, equal to threshold does not',()=>{
 const o=outputs();assert.doesNotThrow(()=>validateCycleOutput('grok',o.grok,o,policy));
 assert.throws(()=>validateCycleOutput('grok',{...o.grok,interestScore:75},o,policy),/GROK_NOT_ACCEPTED/);
});
test('media cannot substitute voice, lower quote speed, contain discontinuous sound or stale scenario',()=>{
 const o=outputs();
 for(const patch of [{narration:{...o.render.narration,voice:'Other'}},{quotePlaybackRate:0.2},{audioContinuous:false},{scenarioHash:'other'},{collagesContainQuote:true},{finalPhotoCount:2}])
  assert.throws(()=>validateCycleOutput('render',{...o.render,...patch},o,policy),/MEDIA_INVALID/);
});
test('public release and reloaded screenshot are required',()=>{
 const o=outputs();
 assert.throws(()=>validateCycleOutput('upload',{...o.upload,privacy:'private'},o,policy),/UPLOAD_NOT_VERIFIED/);
 assert.throws(()=>validateCycleOutput('comment',{...o.comment,shortLink:'https://youtube.com/shorts/TBBj5PBD2rk'},o,policy),/COMMENT_INVALID/);
 assert.throws(()=>validateCycleOutput('visibility',{...o.visibility,reloaded:false},o,policy),/COMMENT_NOT_VISIBLE/);
});

test('closed comments never prevent a Short release',async t=>{
 const {store,job}=await setup(t),o=outputs();o.discover.commentsHttp=403;o.discover.commentsError='commentsDisabled';
 const handlers=Object.fromEntries(cycleStages.map(s=>[s,async()=>o[s]]));
 for(let i=0;i<9;i++)await tickEditorialCycle(store,job.id,handlers);
 const final=await store.load(job.id);assert.equal(final.state,'completed');assert.equal(final.releaseState,'published');
 assert.equal(final.promotionState,'skipped');assert.equal(final.artifacts.comment,undefined);
});
test('failure to see a promotional comment does not erase the published Short',async t=>{
 const {store,job}=await setup(t),o=outputs();o.visibility.visible=false;
 const handlers=Object.fromEntries(cycleStages.map(s=>[s,async()=>o[s]]));
 for(let i=0;i<10;i++)await tickEditorialCycle(store,job.id,handlers);
 const final=await store.load(job.id);assert.equal(final.releaseState,'published');
 assert.equal(final.promotionState,'blocked');assert.equal(final.youtubeId,'TBBj5PBD2rk');
});

test('unconfirmed source advances to another candidate without generating a video',async t=>{
 const {store,job}=await setup(t),o=outputs();
 const lease=await store.claim(job.id,'change-policy',Date.now());
 await store.finish(job.id,lease.token,{state:'queued',policy:{...policy,maxCandidates:3}});
 const handlers={discover:async()=>o.discover,captions:async()=>o.captions,factcheck:async()=>({discrepancy:false})};
 for(let i=0;i<3;i++)await tickEditorialCycle(store,job.id,handlers);
 const next=await store.load(job.id);assert.equal(next.state,'queued');assert.equal(next.stageIndex,0);
 assert.deepEqual(next.artifacts.checkedSources,[{videoId:sourceVideoId,code:'NO_CONFIRMED_DISCREPANCY'}]);
 assert.equal(next.artifacts.discover,undefined);assert.equal(next.artifacts.render,undefined);
});
