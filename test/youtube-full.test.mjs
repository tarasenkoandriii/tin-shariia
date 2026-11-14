import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../src/db/runtime.mjs';
import {changeEditorial} from '../src/db/editorial-workflow.mjs';
import {registerVideo} from '../src/db/editorial-import.mjs';
import {analysisStatus,enqueueYouTubeAnalysis,processAnalysisStep} from '../src/analysis/queue.mjs';
import {splitYouTubeVideo,validateYouTubeDrafts,youtubeDurationSec,youtubeFps,youtubeGeminiProvider,youtubeReserve,youtubeTokensPerSecond} from '../src/analysis/youtube-full.mjs';
import {createClaimsFromDrafts} from '../src/db/claim-drafts.mjs';
import {generateScenarioDraft,scenarioWindow} from '../src/analysis/scenario-ai.mjs';

const migrations=['0000_editorial_import','0001_editorial_access','0002_editorial_workflow','0003_analysis_queue','0004_publication_records',
  '0005_episode_media','0006_video_audits','0007_video_release_approval','0008_shorts','0009_shorts_audit','0010_youtube_uploads',
  '0011_youtube_short_proposals','0012_soniox_requests','0013_ai_disclosures','0014_publication_insights','0015_youtube_comment_campaign',
  '0016_montage_plan_library','0017_tiktok_manual_publications','0018_grok_direct_mode','0019_youtube_full_analysis'];
const config={model:'gemini-test',inputRate:1,outputRate:1,monthlyMicros:50_000_000};

test('whole video is split into overlapping 8-minute windows and window times become absolute',()=>{
  const windows=splitYouTubeVideo('QAfullvid01',1800);
  assert.deepEqual(windows.map(w=>[w.startSec,w.endSec]),[[0,480],[465,945],[930,1410],[1395,1800]]);
  assert.equal(windows[0].url,'https://www.youtube.com/watch?v=QAfullvid01');
  assert.throws(()=>splitYouTubeVideo('QAfullvid01',5),/DURATION_REQUIRED/);
  assert.throws(()=>splitYouTubeVideo('QAfullvid01',12*3600),/TOO_LONG/);
  const drafts=validateYouTubeDrafts({proposals:[
    {kind:'fact',quote:'Q',paraphrase:false,startSec:10,endSec:20,question:'Чи так?'},
    {kind:'fact',quote:'Outside',paraphrase:false,startSec:600,endSec:610,question:'?'},
    {kind:'fact',quote:'Reversed',paraphrase:false,startSec:30,endSec:20,question:'?'},
  ]},windows[1]);
  assert.deepEqual(drafts,[{kind:'fact',quote:'Q',paraphrase:false,question:'Чи так?',segmentIds:[],verifiedQuote:false,startMs:475000,endMs:485000}]);
  assert.throws(()=>validateYouTubeDrafts({proposals:[],extra:1},windows[0]));
});

test('duration comes from the YouTube Data API and degrades to null',async()=>{
  const ok=async()=>new Response(JSON.stringify({items:[{contentDetails:{duration:'PT1H2M3S'}}]}),{status:200});
  assert.equal(await youtubeDurationSec('QAfullvid01',{apiKey:'k',fetchImpl:ok}),3723);
  const original=console.error;console.error=()=>{};
  try{
    assert.equal(await youtubeDurationSec('QAfullvid01',{apiKey:'k',fetchImpl:async()=>new Response('{}',{status:403})}),null);
    assert.equal(await youtubeDurationSec('QAfullvid01',{apiKey:''}),null);
  }finally{console.error=original;}
});

test('Gemini provider sends the YouTube window and maps failures',async()=>{
  const env={ANALYSIS_ENABLED:'true',GEMINI_API_KEY:'g'};
  const window=splitYouTubeVideo('QAfullvid01',600)[1];
  let request;
  const client={models:{generateContent:async body=>{request=body;return {text:JSON.stringify({proposals:[
    {kind:'prediction',quote:'Буде так',paraphrase:true,startSec:1,endSec:9,question:'Чи справдилось?',context:'Контекст'}]}),
    usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:5}};}}};
  const result=await youtubeGeminiProvider({env,client})('gemini-test',window);
  assert.equal(result.type,'success');
  assert.deepEqual(result.usage,{input:100,output:25});
  assert.equal(result.drafts[0].startMs,(465+1)*1000);
  assert.deepEqual(request.contents[0].parts[0],{fileData:{fileUri:window.url},videoMetadata:{startOffset:'465s',endOffset:'600s',fps:0.2}});
  const failing=status=>youtubeGeminiProvider({env,client:{models:{generateContent:async()=>{throw Object.assign(Error('x'),{status});}}}})('m',window);
  const original=console.error;console.error=()=>{};
  try{
    assert.equal((await failing(429)).type,'transient');
    assert.equal((await failing(400)).code,'PROVIDER_REJECTED');
    assert.equal((await failing(undefined)).type,'unknown');
  }finally{console.error=original;}
  assert.equal((await youtubeGeminiProvider({env:{}})('m',window)).code,'ANALYSIS_DISABLED');
});

test('whole-video analysis → draft claims (once) → approved claim → Gemini scenario draft',async()=>{
  const native=process.env.RUN_EDITORIAL_POSTGRES_TESTS==='1';
  const db=native?await database():new PGlite();
  try{
    if(!native) for(const name of migrations) await db.exec(await readFile(new URL('../drizzle/'+name+'.sql',import.meta.url),'utf8'));
    for(const [id,roles] of [['yt-author',['author']],['yt-checker',['factchecker','editor']]]){
      const {rows:[member]}=await db.query('INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) RETURNING id',[id,id+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])',[member.id,roles]);
    }
    const video=await registerVideo(db,'https://youtu.be/QAfullvid01');
    await assert.rejects(enqueueYouTubeAnalysis(db,'yt-author',video.id,{source:'youtube'},config,{duration:async()=>null}),/DURATION_REQUIRED/);
    await assert.rejects(enqueueYouTubeAnalysis(db,'yt-checker',video.id,{source:'youtube'},config,{duration:async()=>900}),/FORBIDDEN/);
    // API unavailable → the author's duration is used.
    const job=await enqueueYouTubeAnalysis(db,'yt-author',video.id,{source:'youtube',durationSec:900},config,{duration:async()=>null});
    assert.equal(job.status,'queued');
    assert.equal((await enqueueYouTubeAnalysis(db,'yt-author',video.id,{source:'youtube',durationSec:900},config,{duration:async()=>null})).id,job.id);

    const seen=[];
    const provider=async(model,input,context)=>{
      assert.equal(context.mode,'youtube');seen.push([input.startSec,input.endSec]);
      // The same statement is heard in the overlap of both windows: it must be merged.
      const proposals=input.startSec===0
        ?[{kind:'fact',quote:'Бюджет зріс удвічі',paraphrase:false,startSec:470,endSec:478,question:'Чи зріс бюджет удвічі?'}]
        :[{kind:'fact',quote:'Бюджет зріс удвічі',paraphrase:false,startSec:5,endSec:13,question:'Чи зріс бюджет удвічі?'},
          {kind:'opinion',quote:'Це провал',paraphrase:true,startSec:100,endSec:110,question:'На чому ґрунтується оцінка?',context:'Про реформу'}];
      return {type:'success',usage:{input:10,output:5},drafts:validateYouTubeDrafts({proposals},input)};
    };
    for(let i=0;i<10;i++){const step=await processAnalysisStep(db,job.id,1,provider);if(step.done)break;}
    assert.deepEqual(seen,[[0,480],[465,900]]);
    const status=await analysisStatus(db,'yt-author',{id:job.id});
    assert.equal(status.status,'succeeded');
    assert.equal(status.mode,'youtube');
    assert.deepEqual(status.drafts.map(d=>[d.quote,d.startMs,d.claimId]),[['Бюджет зріс удвічі',470000,null],['Це провал',565000,null]]);
    assert.equal((await analysisStatus(db,'yt-author',{videoId:video.id})).length,1);

    await assert.rejects(createClaimsFromDrafts(db,'yt-checker',job.id),/FORBIDDEN/);
    const created=await createClaimsFromDrafts(db,'yt-author',job.id);
    assert.equal(created.created,2);
    assert.deepEqual(await createClaimsFromDrafts(db,'yt-author',job.id),{created:0,claims:[],skipped:[]});
    assert.equal((await analysisStatus(db,'yt-author',{videoId:video.id}))[0].duration_sec,900);
    // A draft the claim validator rejects is skipped and released; the rest are still created.
    const {rows:[badDraft]}=await db.query(`INSERT INTO ai_claim_drafts(job_id,position,draft) VALUES($1,9,$2::text::jsonb) RETURNING position`,
      [job.id,JSON.stringify({kind:'fact',quote:'Ok',question:'',paraphrase:false,segmentIds:[],verifiedQuote:false,startMs:1,endMs:2})]);
    const partial=await createClaimsFromDrafts(db,'yt-author',job.id);
    assert.deepEqual([partial.created,partial.skipped],[0,[{position:badDraft.position,code:'INVALID_INPUT'}]]);
    assert.equal((await db.query('SELECT claiming_at FROM ai_claim_drafts WHERE job_id=$1 AND position=9',[job.id])).rows[0].claiming_at,null);
    await db.query('DELETE FROM ai_claim_drafts WHERE job_id=$1 AND position=9',[job.id]);
    const {rows:claims}=await db.query(`SELECT c.id,c.status,c.version,c.revision,cv.content,cv.transcript_id FROM claims c
      JOIN claim_versions cv ON cv.claim_id=c.id AND cv.version=c.version WHERE c.video_id=$1 ORDER BY (cv.content->>'startMs')::int`,[video.id]);
    assert.deepEqual(claims.map(c=>[c.status,c.content.quote,c.content.startMs,c.content.endMs,c.transcript_id]),
      [['draft','Бюджет зріс удвічі',470000,478000,null],['draft','Це провал',565000,575000,null]]);
    assert.match(claims[1].content.context,/Про реформу.*Переказ Gemini/);
    assert.equal((await analysisStatus(db,'yt-author',{id:job.id})).drafts[0].claimId,claims[0].id);

    // Scenario needs an approved claim: people add verdict and sources, another member approves.
    let claim=claims[0];
    await assert.rejects(generateScenarioDraft(db,'yt-author',claim.id,{requestId:crypto.randomUUID()},config,{client:{}}),/CLAIM_NOT_APPROVED/);
    const change=(identity,action,item,extra={})=>changeEditorial(db,identity,'claim',{...extra,action,id:item.id,version:item.version,expectedRevision:item.revision});
    claim=await change('yt-author','edit',claim,{quote:'Бюджет зріс удвічі',question:'Чи зріс бюджет удвічі?',startMs:470000,endMs:478000,
      verdict:'false',explanation:'За звітом бюджет зріс на 12%.',
      evidence:[{title:'Звіт',url:'https://example.test/budget',accessedOn:'2026-11-13',locator:'с. 4',coverage:'Зростання бюджету'}]});
    claim=await change('yt-author','submit',claim);
    claim=await change('yt-checker','approve',claim);

    let request;
    const client={models:{generateContent:async body=>{request=body;return {text:JSON.stringify({title:'Бюджет не зріс удвічі',
      script:'Хук. Автор сказав… Звіт показує 12%. Висновок: неправда.',description:'Перевірка заяви',pinnedComment:'Джерело: звіт',fragments:'07:50–07:58'}),
      usageMetadata:{promptTokenCount:1000,candidatesTokenCount:200}};}}};
    const requestId=crypto.randomUUID();
    const result=await generateScenarioDraft(db,'yt-author',claim.id,{requestId},config,{client});
    assert.equal(result.cached,false);
    assert.deepEqual(request.contents[0].parts[0].videoMetadata,{startOffset:'410s',endOffset:'538s',fps:0.2});
    assert.match(request.contents[0].parts[1].text,/12%/);
    const {rows:[episode]}=await db.query(`SELECT e.status,ev.content,ev.claim_version FROM episodes e
      JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=e.version WHERE e.id=$1`,[result.episodeId]);
    assert.deepEqual([episode.status,episode.content.title,episode.content.fragments,episode.claim_version],['draft','Бюджет не зріс удвічі','07:50–07:58',claim.version]);
    assert.deepEqual(await generateScenarioDraft(db,'yt-author',claim.id,{requestId},config,{client:{}}),{episodeId:result.episodeId,cached:true});
    const {rows:[call]}=await db.query('SELECT state,spent_micros FROM scenario_ai_calls WHERE request_key=$1',[requestId]);
    assert.deepEqual([call.state,Number(call.spent_micros)],['succeeded',1200]);

    // Invalid model output fails the call without creating an episode.
    const bad={models:{generateContent:async()=>({text:'{"title":""}',usageMetadata:{promptTokenCount:1,candidatesTokenCount:1}})}};
    await assert.rejects(generateScenarioDraft(db,'yt-author',claim.id,{requestId:crypto.randomUUID()},config,{client:bad}),/SCENARIO_FAILED/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM episodes WHERE claim_id=$1',[claim.id])).rows[0].n,1);
    assert.equal(scenarioWindow({startMs:null,endMs:null}),null);
  }finally{await db.close?.();}
});

test('Gemini watches YouTube at a low, configurable frame rate and reserves budget for it',()=>{
  assert.equal(youtubeFps({}),0.2);
  assert.equal(youtubeFps({GEMINI_YOUTUBE_FPS:'0.1'}),0.1);
  for(const bad of ['0','2','abc','-1','0.01']) assert.equal(youtubeFps({GEMINI_YOUTUBE_FPS:bad}),0.2);
  assert.equal(youtubeTokensPerSecond(1),128);
  assert.equal(youtubeTokensPerSecond(0.2),58);
  // A 12-minute video reserves less than half of what 1 fps needed.
  const windows=splitYouTubeVideo('QAfullvid01',720),config={inputRate:1,outputRate:0};
  assert.ok(youtubeReserve(windows,config)<0.5*windows.reduce((n,w)=>n+(w.endSec-w.startSec)*128+1500,0));
});
