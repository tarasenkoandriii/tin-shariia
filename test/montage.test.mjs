import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../src/db/runtime.mjs';
import {initMontage,confirmMontage,readMontage,listMontage} from '../src/db/montage.mjs';
import {changeEditorial} from '../src/db/editorial-workflow.mjs';
import {registerVideo} from '../src/db/editorial-import.mjs';
import {montageJob,montageReport} from '../src/media/montage-ffmpeg.mjs';
import {enqueueVideoAudit,processAnalysisStep} from '../src/analysis/queue.mjs';
import {validateVideoAudit} from '../src/analysis/video-input.mjs';
import {videoAuditStatus} from '../src/analysis/video-status.mjs';
import {reviewVideoAudit} from '../src/db/video-audit.mjs';
import {registerPublication} from '../src/db/publications.mjs';
import {montageStep} from '../src/media/montage-queue.mjs';
import {createShortAuditMedia,initShortRender,listShortRenders,prepareTikTokPublication,readTikTokPackageMedia,updateShortRender,failTikTokPublication,registerTikTokPublication} from '../src/db/shorts.mjs';

const sha256='a'.repeat(64),ffmpegId='1a0b32d8-9cd7-4f01-bff4-68a767c1e77a';
const audioReport='frame:0 pts:0 pts_time:0.1\nlavfi.r128.I=-21.4\nlavfi.r128.true_peak=0.100\n'
  +'frame:9 pts:9 pts_time:1\nlavfi.silence_start=0.4\n'
  +'frame:19 pts:19 pts_time:2\nlavfi.r128.I=-22.6\nlavfi.r128.true_peak=0.200\nlavfi.silence_end=1.1\n';
const sample={id:ffmpegId,status:'succeeded',ffmpeg_version:'5.1',inputs_metadata:[{
  key:'src',bytes:600,sha256,format:'mov,mp4,m4a,3gp,3g2,mj2',durationSec:2,
  streams:[{type:'video',width:1920,height:1080,codec:'h264'},{type:'audio',codec:'aac',durationSec:2}],
}]};

test('strict report requires the right file, both tracks, full audio and a measurable peak',()=>{
  assert.match(montageJob('https://private.example.test/a.mp4').ffmpeg_commands[0],/^-xerror .* -map 0:v:0 /);
  const {report}=montageReport(sample,audioReport,600);
  assert.deepEqual(report.silence,[{startMs:400,endMs:1100}]);
  assert.equal(report.durationMs,2000);
  assert.equal(report.truePeakDbtp,-13.98);
  assert.throws(()=>montageReport(sample,audioReport,601),/INVALID_MEDIA/);
  assert.throws(()=>montageReport(sample,audioReport.replace('pts_time:2','pts_time:1'),600),/AUDIO_INCOMPLETE/);
  assert.throws(()=>montageReport(sample,audioReport.replaceAll(/true_peak=0\.\d+/g,'true_peak=0'),600),/AUDIO_SILENT/);
});

test('montage binds to approved snapshot and recovers ambiguous FFmpeg submission by key',async()=>{
  const native=process.env.RUN_EDITORIAL_POSTGRES_TESTS==='1';
  const db=native?await database():new PGlite();
  try{
    if(!native) for(const name of ['0000_editorial_import','0001_editorial_access','0002_editorial_workflow','0003_analysis_queue','0004_publication_records','0005_episode_media','0006_video_audits','0007_video_release_approval','0008_shorts','0009_shorts_audit','0010_youtube_uploads','0011_youtube_short_proposals','0012_soniox_requests','0013_ai_disclosures','0014_publication_insights','0015_youtube_comment_campaign','0016_montage_plan_library','0017_tiktok_manual_publications','0018_grok_direct_mode','0019_youtube_full_analysis']){
      await db.exec(await readFile(new URL('../drizzle/'+name+'.sql',import.meta.url),'utf8'));
    }
    for(const [id,roles] of [['media-author',['author']],['media-review',['factchecker','editor']],['media-publisher',['publisher']],['other-author',['author']]]){
      const {rows:[member]}=await db.query('INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) RETURNING id',[id,id+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])',[member.id,roles]);
    }
    const video=await registerVideo(db,'https://youtu.be/QAmontage01');
    const change=(identity,kind,action,item,extra={})=>changeEditorial(db,identity,kind,{
      ...extra,action,id:item?.id,version:item?.version,expectedRevision:item?.revision,
    });
    let claim=await change('media-author','claim','create',null,{
      parentId:video.id,quote:'Quote',question:'Question?',verdict:'confirmed',explanation:'Test',
      evidence:[{title:'Report',url:'https://example.test/montage',accessedOn:'2026-11-12',locator:'1',coverage:'Fact'}],
    });
    claim=await change('media-author','claim','submit',claim);
    claim=await change('media-review','claim','approve',claim);
    let episode=await change('media-author','episode','create',null,{
      parentId:claim.id,claimVersion:claim.version,title:'Master',script:'Script',pinnedComment:'Exact package',
    });
    const reserve=(identity,bytes=600)=>initMontage(db,identity,episode.id,{version:episode.version,bytes});
    await assert.rejects(reserve('media-author'),/GROK_PREFLIGHT_REQUIRED/);
    episode=await change('media-author','episode','submit',episode);
    episode=await change('media-review','episode','approve',episode);
    await db.query(`INSERT INTO episode_grok_reviews(episode_id,episode_version,round,state,batch_request_id,input_snapshot,accepted_by,accepted_at)
      VALUES($1,$2,1,'accepted','39d1bb4a-8a8a-4b54-a5a3-8c7d14334f10','{}'::jsonb,
        (SELECT id FROM members WHERE clerk_user_id='media-review'),now())`,[episode.id,episode.version]);
    await assert.rejects(reserve('media-review'),/FORBIDDEN/);
    await assert.rejects(reserve('media-author',129*1024*1024),/SIZE_INVALID/);
    const row=await reserve('media-author');
    assert.equal((await reserve('media-author')).id,row.id);
    assert.equal(row.snapshot.episode.pinnedComment,'Exact package');
    const object={pathname:row.pathname,size:600,contentType:'video/mp4'};
    await assert.rejects(readMontage(db,'media-review',episode.id,row.id),/NOT_FOUND/);
    await assert.rejects(confirmMontage(db,'other-author',episode.id,row.id,object),/FORBIDDEN/);
    await assert.rejects(confirmMontage(db,'media-author',episode.id,row.id,{...object,size:599}),/OBJECT_MISMATCH/);
    assert.equal((await confirmMontage(db,'media-author',episode.id,row.id,object)).state,'queued');
    const token='2ebd8d1b-44c1-49f1-a44f-0b3398bb00bf';
    await db.query("UPDATE episode_media_revisions SET state='checking',run_token=$2,run_lease=now()+interval '3 minutes' WHERE id=$1",[row.id,token]);
    let sent=0;
    const client={
      lookup:async key=>{assert.equal(key,'tin-montage-'+row.id);return sent?sample:null;},
      submit:async()=>{sent++;throw Error('Connection lost after acceptance');},
      report:async()=>audioReport,
    };
    const sign=async()=> 'https://private.example.test/media.mp4';
    assert.deepEqual(await montageStep(db,row.id,token,{client,sign}),{done:false});
    assert.deepEqual(await montageStep(db,row.id,token,{client,sign}),{done:true});
    assert.equal(sent,1);
    const stored=await readMontage(db,'media-review',episode.id,row.id);
    assert.equal(stored.sha256,sha256);
    assert.equal(stored.state,'passed');
    assert.equal(stored.report.width,1920);
    assert.equal((await listMontage(db,'media-author',video.id))[0].owned,true);
    await db.query("UPDATE episode_media_revisions SET report=jsonb_set(report,'{durationMs}','60000'::jsonb) WHERE id=$1",[row.id]);
    const shortInput={mediaId:row.id,manifest:{hook:'Hook',title:'Short title',description:'Short description',
      clips:[{startMs:0,endMs:31_000},{startMs:40_000,endMs:50_000}]}};
    const short=await initShortRender(db,'media-author',episode.id,shortInput);
    assert.equal(short.state,'queued');
    assert.equal((await initShortRender(db,'media-author',episode.id,shortInput)).id,short.id);
    assert.equal((await listShortRenders(db,'media-review',episode.id))[0].manifest.durationMs,41_000);
    await assert.rejects(initShortRender(db,'media-review',episode.id,shortInput),/FORBIDDEN/);
    const renderToken='43827335-2e6c-42f4-a972-4269cb419d81';
    await db.query(`UPDATE shorts_renders SET state='technical_check',run_token=$2,run_lease=now()+interval '3 minutes',
      pathname=$3,expected_bytes=600,sha256=$4 WHERE id=$1`,[short.id,renderToken,`shorts/${episode.id}/${short.id}.mp4`,sha256]);
    const shortReport={durationMs:41_000,width:1080,height:1920,videoCodec:'h264',audioCodec:'aac',
      integratedLufs:-20,truePeakDbtp:-8,silence:[]};
    const auditMediaId=await createShortAuditMedia(db,short.id,renderToken,shortReport);
    const {rows:[auditMedia]}=await db.query('SELECT kind,snapshot,report FROM episode_media_revisions WHERE id=$1',[auditMediaId]);
    assert.equal(auditMedia.kind,'short');
    assert.equal(auditMedia.snapshot.short.title,'Short title');
    assert.equal(auditMedia.report.width,1080);
    assert.equal((await listMontage(db,'media-author',video.id)).length,1,'Short audit source stays out of regular montage list');
    const shortAuditJob=await enqueueVideoAudit(db,'media-author',episode.id,auditMediaId,{},
      {model:'gemini-test',inputRate:2,outputRate:10,monthlyMicros:1000000});
    let shortProviderCalls=0;
    const shortProvider=async(_model,input,{state})=>{
      assert.equal(input.snapshot.short.title,'Short title');
      assert.equal(input.durationMs,41_000);
      if(!state){shortProviderCalls++;return {type:'waiting',delay:0,state:{interactionId:'short-audit'}};}
      const report={audioAvailable:true,visualAvailable:true,summary:'Short test',
        coverage:[{interval:0,audio:'Голос чіткий',visual:'Вертикальне відео'}],findings:[]};
      return {type:'success',drafts:validateVideoAudit(report,input,[{modality:'video',tokens:20}]),usage:{input:30,output:10}};
    };
    for(let step=0;step<3;step++) await processAnalysisStep(db,shortAuditJob.id,1,shortProvider);
    assert.equal((await videoAuditStatus(db,'media-review',episode.id,auditMediaId))[0].status,'succeeded');
    assert.equal(shortProviderCalls,1);
    await updateShortRender(db, short.id, renderToken, {state:'ready', auditMediaRevisionId:auditMediaId});
    const downloadTikTok = (identity = 'media-publisher') => readTikTokPackageMedia(db, identity, episode.id, short.id);
    await assert.rejects(downloadTikTok(), /NOT_FOUND/);
    await reviewVideoAudit(db, 'media-review', episode.id, auditMediaId, {action:'approve'});
    const prepareTikTok = () => prepareTikTokPublication(db, 'media-publisher', episode.id, short.id, {
      confirmed:true, aiDisclosureConfirmed:true, reviewedSha256:sha256,
    });
    const [tiktok, repeatedPackage] = await Promise.all([prepareTikTok(), prepareTikTok()]);
    assert.equal(tiktok.id, repeatedPackage.id);
    assert.deepEqual([tiktok.deduplicated, repeatedPackage.deduplicated].sort(), [false, true]);
    assert.equal((await downloadTikTok()).pathname, `shorts/${episode.id}/${short.id}.mp4`);
    await assert.rejects(downloadTikTok('media-author'), /FORBIDDEN/);
    await db.query('UPDATE tiktok_short_publications SET sha256=$2 WHERE id=$1', [tiktok.id, 'b'.repeat(64)]);
    await assert.rejects(downloadTikTok(), /NOT_FOUND/);
    await db.query('UPDATE tiktok_short_publications SET sha256=$2 WHERE id=$1', [tiktok.id, sha256]);
    await db.query('UPDATE shorts_renders SET pathname=$2 WHERE id=$1', [short.id, 'shorts/changed.mp4']);
    await assert.rejects(downloadTikTok(), /NOT_FOUND/);
    await db.query('UPDATE shorts_renders SET pathname=$2 WHERE id=$1', [short.id, `shorts/${episode.id}/${short.id}.mp4`]);
    await failTikTokPublication(db, 'media-publisher', episode.id, short.id, {
      note:'Manual upload failed', confirmed:true,
    });
    await assert.rejects(downloadTikTok(), /NOT_FOUND/);
    assert.equal((await prepareTikTok()).id, tiktok.id);
    const tiktokInput = {
      url:'https://www.tiktok.com/@editorial/video/1234567890123456789',
      publishedAt:new Date().toISOString(), confirmed:true, aiDisclosureConfirmed:true, reviewedSha256:sha256,
    };
    const registerTikTok = (input = tiktokInput) =>
      registerTikTokPublication(db, 'media-publisher', episode.id, short.id, input);
    await assert.rejects(registerTikTok({...tiktokInput, aiDisclosureConfirmed:false}), /TIKTOK_DISCLOSURE_REQUIRED/);
    assert.equal((await registerTikTok()).state, 'published');
    assert.equal((await registerTikTok()).deduplicated, true);
    await assert.rejects(registerTikTok({...tiktokInput, url:tiktokInput.url + '0'}), /TIKTOK_PUBLICATION_CONFLICT/);
    await assert.rejects(downloadTikTok(), /NOT_FOUND/);
    const {rows: publicationEvents} = await db.query(
      'SELECT action FROM tiktok_short_publication_events WHERE publication_id=$1 ORDER BY id', [tiktok.id],
    );
    assert.deepEqual(publicationEvents.map(event => event.action), ['prepared','failed','retry_prepared','published']);


    await db.query("UPDATE episode_media_revisions SET report=jsonb_set(report,'{durationMs}','2000'::jsonb) WHERE id=$1",[row.id]);
    const config={model:'gemini-test',inputRate:2,outputRate:10,monthlyMicros:1000000};
    const run=(identity,input={},limits=config)=>enqueueVideoAudit(db,identity,episode.id,row.id,input,limits);
    await assert.rejects(run('media-review'),/FORBIDDEN/);
    await assert.rejects(run('media-author',{}, {...config,monthlyMicros:1}),/BUDGET_EXHAUSTED/);
    const job=await run('media-author');
    assert.equal((await run('media-author')).id,job.id);
    let submissions=0;
    const provider=async(_model,input,{mode,state})=>{
      assert.equal(mode,'video');
      assert.equal(input.sha256,sha256);
      if(!state){
        submissions++;
        return {type:'waiting',delay:0,state:{interactionId:'test-interaction'}};
      }
      assert.equal(state.interactionId,'test-interaction');
      const output={audioAvailable:true,visualAvailable:true,summary:'Test',
        coverage:[{interval:0,audio:'Speech',visual:'Blue screen'}],findings:[{
          category:'speech',severity:'major',startMs:0,endMs:1000,field:null,sourceIndex:null,
          observation:'Test finding',fix:'Adjust the first phrase',
        }]};
      const modalities=[{modality:'video',tokens:100}];
      assert.throws(()=>validateVideoAudit({...output,coverage:[{...output.coverage[0],interval:1}]},input,modalities),/VIDEO_COVERAGE_INCOMPLETE/);
      assert.throws(()=>validateVideoAudit({...output,audioAvailable:false},input,modalities),/VIDEO_INPUT_UNCONFIRMED/);
      return {type:'success',drafts:validateVideoAudit(output,input,modalities),usage:{input:100,output:20}};
    };
    for(let step=0;step<3;step++) await processAnalysisStep(db,job.id,1,provider);
    const [result]=await videoAuditStatus(db,'media-review',episode.id,row.id);
    assert.equal(result.status,'succeeded');
    assert.equal(result.reports[0].coverage[0].endMs,2000);
    assert.equal(result.reports[0].findings[0].finding.observation,'Test finding');
    const publish={url:'https://youtu.be/QAstg8test0',version:episode.version,publishedAt:new Date().toISOString(),confirmed:true,aiDisclosureConfirmed:true,mediaRevisionId:row.id};
    await assert.rejects(registerPublication(db,'media-publisher',episode.id,publish),/RELEASE_APPROVAL_REQUIRED/);
    await assert.rejects(reviewVideoAudit(db,'media-author',episode.id,row.id,{action:'approve'}),/FORBIDDEN/);
    await assert.rejects(reviewVideoAudit(db,'media-review',episode.id,row.id,{action:'approve'}),/FINDINGS_OPEN/);
    await reviewVideoAudit(db,'media-review',episode.id,row.id,{action:'finding',attempt:1,position:0,
      disposition:'resolved',comment:'Виправлено першу фразу у монтажі.'});
    const reviewed=await videoAuditStatus(db,'media-review',episode.id,row.id);
    assert.equal(reviewed[0].reports[0].findings[0].review.disposition,'resolved');
    const approval=await reviewVideoAudit(db,'media-review',episode.id,row.id,{action:'approve'});
    assert.equal(approval.media_revision_id,row.id);
    assert.equal((await videoAuditStatus(db,'media-review',episode.id,row.id))[0].reports[0].reviewedByMe,true);
    await assert.rejects(reviewVideoAudit(db,'media-review',episode.id,row.id,{action:'finding',attempt:1,position:0,
      disposition:'accepted',comment:'Не змінювати.'}),/REVIEW_CLOSED/);
    const {rows:[newRevision]}=await db.query(`INSERT INTO episode_media_revisions
      (id,episode_id,episode_version,uploaded_by,ordinal,pathname,expected_bytes,upload_until,expires_at,state,sha256,report,snapshot)
      SELECT gen_random_uuid(),m.episode_id,m.episode_version,m.uploaded_by,
        (SELECT MAX(ordinal)+1 FROM episode_media_revisions WHERE episode_id=m.episode_id),'montage/revised.mp4',m.expected_bytes,
        m.upload_until,m.expires_at,'passed',m.sha256,m.report,m.snapshot FROM episode_media_revisions m WHERE m.id=$1 RETURNING id`,[row.id]);
    assert.equal((await listMontage(db,'media-review',video.id)).find(item=>item.id===newRevision.id).release_approved,false);
    await assert.rejects(registerPublication(db,'media-publisher',episode.id,{...publish,mediaRevisionId:newRevision.id,
      url:'https://youtu.be/QAstg8test1'}),/RELEASE_APPROVAL_REQUIRED/);
    const publication=await registerPublication(db,'media-publisher',episode.id,publish);
    assert.equal(publication.media_revision_id,row.id);
    assert.equal(submissions,1);
    await assert.rejects(run('media-author',{retry:true,expectedAttempt:1}),/MEDIA_STALE/);
    assert.equal((await videoAuditStatus(db,'media-review',episode.id,row.id))[0].reports.length,1);

  }finally{if(!native)await db.close();}
});
