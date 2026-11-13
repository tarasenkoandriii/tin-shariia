import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../src/db/runtime.mjs';
import {changeEditorial} from '../src/db/editorial-workflow.mjs';
import {registerVideo} from '../src/db/editorial-import.mjs';
import {claimGrokReviewBatch,queueEpisodeGrokReview,readGrokSettings,updateGrokSettings,updateGrokAutoAcceptScore} from '../src/db/episode-grok.mjs';
import {runDirectGrokReviews} from '../src/analysis/episode-grok-review.mjs';
import {requestGrokDirect} from '../src/analysis/grok-direct.mjs';

const migrations=['0000_editorial_import','0001_editorial_access','0002_editorial_workflow','0003_analysis_queue','0004_publication_records',
  '0005_episode_media','0006_video_audits','0007_video_release_approval','0008_shorts','0009_shorts_audit','0010_youtube_uploads',
  '0011_youtube_short_proposals','0012_soniox_requests','0013_ai_disclosures','0014_publication_insights','0015_youtube_comment_campaign',
  '0016_montage_plan_library','0017_tiktok_manual_publications','0018_grok_direct_mode'];
const review=(originality,interest,factRisks=[])=>JSON.stringify({originalityScore:originality,interestScore:interest,summary:'Підсумок',
  strengths:['Конкретика'],recommendations:[{change:'Додати дату',reason:'Ясність',priority:'high'}],factRisks,limits:'Оцінка'});

test('direct Grok mode is the default, runs immediately and applies the same auto-accept rule',async()=>{
  const native=process.env.RUN_EDITORIAL_POSTGRES_TESTS==='1';
  const db=native?await database():new PGlite();
  try{
    if(!native) for(const name of migrations.slice(0,-1)) await db.exec(await readFile(new URL('../drizzle/'+name+'.sql',import.meta.url),'utf8'));
    for(const [id,roles] of [['grok-author',['author']],['grok-review',['factchecker','editor']],['grok-admin',['admin']]]){
      const {rows:[member]}=await db.query('INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) RETURNING id',[id,id+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])',[member.id,roles]);
    }
    const video=await registerVideo(db,'https://youtu.be/QAgrokdir01');
    const change=(identity,kind,action,item,extra={})=>changeEditorial(db,identity,kind,{...extra,action,id:item?.id,version:item?.version,expectedRevision:item?.revision});
    let claim=await change('grok-author','claim','create',null,{parentId:video.id,quote:'Quote',question:'Question?',verdict:'confirmed',explanation:'Test',
      evidence:[{title:'Report',url:'https://example.test/grok',accessedOn:'2026-11-13',locator:'1',coverage:'Fact'}]});
    claim=await change('grok-author','claim','submit',claim);claim=await change('grok-review','claim','approve',claim);
    const episodes=[];
    for(const title of ['One','Two','Three','Four']){
      let episode=await change('grok-author','episode','create',null,{parentId:claim.id,claimVersion:claim.version,title,script:'Script '+title,pinnedComment:'Pin'});
      episode=await change('grok-author','episode','submit',episode);episodes.push(await change('grok-review','episode','approve',episode));
    }

    // A pass queued before the migration (no batch yet) is moved to direct; an already submitted batch stays batch.
    const {rows:[legacy]}=await db.query(`INSERT INTO episode_grok_reviews(episode_id,episode_version,round,batch_request_id,input_snapshot,reserved_micros)
      VALUES($1,$2,1,'6f3b0a52-5f0e-4c63-9a55-0c2f3b8d7a11','{"draft":{"script":"Script Four"}}'::jsonb,50000) RETURNING id`,[episodes[3].id,episodes[3].version]);
    const {rows:[sent]}=await db.query(`INSERT INTO episode_grok_reviews(episode_id,episode_version,round,state,batch_id,batch_request_id,input_snapshot,reserved_micros)
      VALUES($1,$2,1,'submitted','batch_old','7a4c1b63-6a1f-4d74-8b66-1d3a4c9e8b22','{}'::jsonb,50000) RETURNING id`,[episodes[2].id,episodes[2].version]);
    await db.exec(await readFile(new URL('../drizzle/0018_grok_direct_mode.sql',import.meta.url),'utf8'));
    assert.equal((await db.query('SELECT mode FROM episode_grok_reviews WHERE id=$1',[legacy.id])).rows[0].mode,'direct');
    assert.equal((await db.query('SELECT mode FROM episode_grok_reviews WHERE id=$1',[sent.id])).rows[0].mode,'batch');
    await db.query(`UPDATE episode_grok_reviews SET state='failed' WHERE id=$1`,[sent.id]);

    assert.deepEqual(await readGrokSettings(db,'grok-admin'),{autoAcceptScore:80,grokMode:'direct'});
    await assert.rejects(readGrokSettings(db,'grok-author'),/FORBIDDEN/);

    // High scores without fact risks: auto-accepted at the 80 threshold, in one direct call.
    const first=await queueEpisodeGrokReview(db,'grok-author',episodes[0].id);
    assert.equal(first.mode,'direct');
    let calls=0;
    const outcome=await runDirectGrokReviews(db,{id:first.id,limit:1,request:async({system,input})=>{
      calls++;assert.match(system,/Return JSON only/);assert.match(input,/Script One/);return {text:review(85,90)};
    }});
    assert.deepEqual(outcome,{claimed:1,completed:1,failed:0});
    let {rows:[row]}=await db.query('SELECT state,auto_accepted,auto_accept_threshold,result,batch_id FROM episode_grok_reviews WHERE id=$1',[first.id]);
    assert.deepEqual([row.state,row.auto_accepted,row.auto_accept_threshold,row.result.originalityScore,row.batch_id],['accepted',true,80,85,null]);
    // Running again (cron after after()) never repeats a finished call.
    assert.deepEqual(await runDirectGrokReviews(db,{id:first.id,request:async()=>{throw Error('must not call');}}),{claimed:0,completed:0,failed:0});
    assert.equal(calls,1);

    // Low score: recommendations wait for the editor; a fact risk blocks auto-accept even at 100.
    const second=await queueEpisodeGrokReview(db,'grok-author',episodes[1].id);
    await runDirectGrokReviews(db,{id:second.id,request:async()=>({text:review(40,55)})});
    assert.equal((await db.query('SELECT state FROM episode_grok_reviews WHERE id=$1',[second.id])).rows[0].state,'succeeded');
    const risky=await queueEpisodeGrokReview(db,'grok-author',episodes[1].id);
    assert.equal(risky.round,2);
    await runDirectGrokReviews(db,{id:risky.id,request:async()=>({text:review(100,100,['Дата рішення не підтверджена'])})});
    ({rows:[row]}=await db.query('SELECT state,auto_accepted FROM episode_grok_reviews WHERE id=$1',[risky.id]));
    assert.deepEqual([row.state,row.auto_accepted],['succeeded',false]);

    // Provider failure releases the reserve and allows a rerun; an uncertain outcome keeps the reserve.
    const third=await queueEpisodeGrokReview(db,'grok-author',episodes[2].id);
    await runDirectGrokReviews(db,{id:third.id,request:async()=>({error:'GROK_DIRECT_FAILED',status:400})});
    ({rows:[row]}=await db.query('SELECT state,error_code,reserved_micros FROM episode_grok_reviews WHERE id=$1',[third.id]));
    assert.deepEqual([row.state,row.error_code,row.reserved_micros],['failed','GROK_DIRECT_FAILED',0]);
    const rerun=await queueEpisodeGrokReview(db,'grok-author',episodes[2].id);
    await runDirectGrokReviews(db,{id:rerun.id,request:async()=>({error:'GROK_DIRECT_TIMEOUT',outcomeUnknown:true})});
    ({rows:[row]}=await db.query('SELECT state,reserved_micros FROM episode_grok_reviews WHERE id=$1',[rerun.id]));
    assert.deepEqual([row.state,row.reserved_micros],['failed',50000]);
    const invalid=await queueEpisodeGrokReview(db,'grok-author',episodes[2].id);
    await runDirectGrokReviews(db,{id:invalid.id,request:async()=>({text:'not json'})});
    assert.equal((await db.query('SELECT error_code FROM episode_grok_reviews WHERE id=$1',[invalid.id])).rows[0].error_code,'GROK_RESULT_INVALID');

    // The legacy row switched to direct is picked up by the cron sweep.
    assert.deepEqual(await runDirectGrokReviews(db,{request:async()=>({text:review(10,10)})}),{claimed:1,completed:1,failed:0});

    // Batch mode stays selectable: new passes are left for the batch dispatcher, the direct runner ignores them.
    await assert.rejects(updateGrokSettings(db,'grok-admin',{grokMode:'fast'}),/INVALID_INPUT/);
    await assert.rejects(updateGrokSettings(db,'grok-author',{grokMode:'batch'}),/FORBIDDEN/);
    assert.deepEqual(await updateGrokSettings(db,'grok-admin',{grokMode:'batch'}),{autoAcceptScore:80,grokMode:'batch'});
    assert.equal(await updateGrokAutoAcceptScore(db,'grok-admin',75),75);
    assert.deepEqual(await readGrokSettings(db,'grok-admin'),{autoAcceptScore:75,grokMode:'batch'});
    const batched=await queueEpisodeGrokReview(db,'grok-author',episodes[2].id);
    assert.equal(batched.mode,'batch');
    assert.deepEqual(await runDirectGrokReviews(db,{request:async()=>{throw Error('must not call');}}),{claimed:0,completed:0,failed:0});
    assert.deepEqual((await claimGrokReviewBatch(db)).map(item=>item.id),[batched.id]);
    const {rows:events}=await db.query('SELECT old_auto_accept_score,new_auto_accept_score,old_grok_mode,new_grok_mode FROM editorial_ai_setting_events ORDER BY id');
    assert.deepEqual(events.map(event=>[event.old_auto_accept_score,event.new_auto_accept_score,event.old_grok_mode,event.new_grok_mode]),
      [[80,80,'direct','batch'],[80,75,'batch','batch']]);
  }finally{await db.close?.();}
});

test('direct client reports provider status and timeouts without leaking the key',async()=>{
  const saved=process.env.GROK_API_KEY;process.env.GROK_API_KEY='xai-test-key';
  const errors=[];const original=console.error;console.error=(...args)=>errors.push(JSON.stringify(args));
  try{
    let sent;
    const ok=await requestGrokDirect({system:'S',input:'I'},{fetchImpl:async(url,init)=>{sent={url,body:JSON.parse(init.body)};
      return new Response(JSON.stringify({choices:[{message:{content:'{"a":1}'}}]}),{status:200});}});
    assert.deepEqual(ok,{text:'{"a":1}'});
    assert.equal(sent.url,'https://api.x.ai/v1/chat/completions');
    assert.deepEqual([sent.body.model,sent.body.response_format.type,sent.body.messages.length],['grok-4.3','json_object',2]);
    const bad=await requestGrokDirect({system:'S',input:'I'},{fetchImpl:async()=>new Response(JSON.stringify({code:'Client specified an invalid argument',
      error:'Incorrect API key provided'}),{status:400})});
    assert.deepEqual(bad,{error:'GROK_DIRECT_FAILED',status:400});
    assert.equal((await requestGrokDirect({system:'S',input:'I'},{fetchImpl:async()=>new Response('{}',{status:429})})).error,'GROK_DIRECT_RATE_LIMIT');
    const keepAlive=setTimeout(()=>{},1000);// AbortSignal.timeout does not keep the test event loop alive
    const slow=await requestGrokDirect({system:'S',input:'I'},{timeoutMs:5,fetchImpl:(url,init)=>new Promise((_,reject)=>{
      init.signal.addEventListener('abort',()=>reject(init.signal.reason));})});
    clearTimeout(keepAlive);
    assert.deepEqual(slow,{error:'GROK_DIRECT_TIMEOUT',outcomeUnknown:true});
    assert.equal((await requestGrokDirect({system:'S',input:'I'},{fetchImpl:async()=>new Response(JSON.stringify({choices:[]}),{status:200})})).error,'GROK_RESULT_INVALID');
    assert.ok(errors.some(line=>line.includes('Incorrect API key provided')));
    assert.ok(!errors.some(line=>line.includes('xai-test-key')));
  }finally{console.error=original;if(saved===undefined)delete process.env.GROK_API_KEY;else process.env.GROK_API_KEY=saved;}
});
