import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { strFromU8, unzipSync } from 'fflate';
import { database } from '../src/db/runtime.mjs';
import { registerVideo } from '../src/db/editorial-import.mjs';
import { changeEditorial } from '../src/db/editorial-workflow.mjs';
import { changeCorrection, loadPublications, publicationPackage, recordMetrics, registerPublication } from '../src/db/publications.mjs';
import { packageZip } from '../src/editorial/publication-zip.mjs';
import { reviewVideoAudit } from '../src/db/video-audit.mjs';

const sql=['0000_editorial_import','0001_editorial_access','0002_editorial_workflow','0003_analysis_queue',
  '0004_publication_records','0005_episode_media','0006_video_audits','0007_video_release_approval','0008_shorts','0009_shorts_audit','0010_youtube_uploads',
  '0011_youtube_short_proposals','0012_soniox_requests','0013_ai_disclosures','0014_publication_insights','0015_youtube_comment_campaign','0016_montage_plan_library','0017_tiktok_manual_publications','0018_grok_direct_mode','0019_youtube_full_analysis'];
const time=days=>new Date(Date.now()-days*86400000).toISOString();

test('publication requires a current approval and freezes the package, metrics and corrections',async()=>{
  const native=process.env.RUN_EDITORIAL_POSTGRES_TESTS==='1';
  const db=native?await database():new PGlite();
  try{
    if(!native) for(const file of sql) await db.exec(await readFile(new URL('../drizzle/'+file+'.sql',import.meta.url),'utf8'));
    for(const [identity,roles] of [['pub-author',['author','editor']],['pub-review',['factchecker','editor']],['pub-publisher',['publisher']]]){
      const {rows:[user]}=await db.query('INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) RETURNING id',[identity,identity+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])',[user.id,roles]);
    }
    const video=await registerVideo(db,'https://youtu.be/QAPubTest01');
    const claimInput={parentId:video.id,quote:'Цитата',question:'Що підтверджено?',verdict:'confirmed',
      explanation:'Є первинний документ.',evidence:[{title:'Джерело',url:'https://example.test/pub',accessedOn:'2026-11-12',locator:'1',coverage:'Факт'}]};
    const change=(identity,kind,action,item,extra={})=>changeEditorial(db,identity,kind,
      {...extra,action,id:item?.id,version:item?.version,expectedRevision:item?.revision});
    let claim=await change('pub-author','claim','create',null,claimInput);
    claim=await change('pub-author','claim','submit',claim);
    claim=await change('pub-review','claim','approve',claim);
    const script={parentId:claim.id,claimVersion:claim.version,title:'Перевірка',script:'Вступ та висновок',subtitles:'1\nПідзаголовок'};
    let episode=await change('pub-author','episode','create',null,script);
    const publishedAt=time(35);
    const publication={url:'https://youtu.be/QAPubTest02',version:episode.version,publishedAt,confirmed:true,aiDisclosureConfirmed:true,
      mediaRevisionId:'00000000-0000-4000-8000-000000000000'};
    const register=(data=publication)=>registerPublication(db,'pub-publisher',episode.id,data);
    await assert.rejects(register(),/APPROVAL_REQUIRED/);
    await assert.rejects(publicationPackage(db,'pub-author',episode.id,1),/FORBIDDEN/);
    episode=await change('pub-author','episode','submit',episode);
    episode=await change('pub-review','episode','approve',episode);
    await db.query(`INSERT INTO episode_grok_reviews(episode_id,episode_version,round,state,batch_request_id,input_snapshot,accepted_by,accepted_at)
      VALUES($1,$2,1,'accepted','f74bd7b0-822e-48fa-8b1e-d67488213c41','{}'::jsonb,
        (SELECT id FROM members WHERE clerk_user_id='pub-review'),now())`,[episode.id,episode.version]);
    const archive=unzipSync(packageZip(await publicationPackage(db,'pub-publisher',episode.id,1)));
    assert.equal(strFromU8(archive['script.txt']).trim(),script.script);
    assert.ok(archive['subtitles.txt']);
    assert.equal(JSON.parse(strFromU8(archive['manifest.json'])).format,'16:9');
    const {rows:[media]}=await db.query(`INSERT INTO episode_media_revisions
      (episode_id,episode_version,uploaded_by,ordinal,pathname,expected_bytes,upload_until,expires_at,state,sha256,snapshot)
      VALUES($1,$2,(SELECT id FROM members WHERE clerk_user_id='pub-author'),1,'montage/pub.mp4',600,now()+interval '1 hour',
        now()+interval '1 day','passed',repeat('a',64),$3::text::jsonb) RETURNING id`,
      [episode.id,episode.version,JSON.stringify({episodeVersion:episode.version})]);
    publication.mediaRevisionId=media.id;
    await assert.rejects(register(),/RELEASE_APPROVAL_REQUIRED/);
    const {rows:[job]}=await db.query(`INSERT INTO ai_jobs(video_id,requested_by,dedupe_key,model,prompt_version,status,mode,media_revision_id)
      VALUES($1,(SELECT id FROM members WHERE clerk_user_id='pub-author'),'pub-audit','gemini-test','v1','succeeded','video',$2) RETURNING id`,
      [video.id,media.id]);
    await db.query("INSERT INTO ai_attempts(job_id,attempt,status) VALUES($1,1,'succeeded')",[job.id]);
    await db.query(`INSERT INTO prepublication_audits(job_id,attempt,media_revision_id,coverage,summary)
      VALUES($1,1,$2,'[]'::jsonb,'No findings')`,[job.id,media.id]);
    await reviewVideoAudit(db,'pub-review',episode.id,media.id,{action:'approve'});
    await assert.rejects(register({...publication,confirmed:false}),/INVALID_INPUT/);
    const [first,retry]=await Promise.all([register(),register()]);
    assert.equal(first.id,retry.id);
    assert.equal([first,retry].filter(row=>row.deduplicated).length,1);
    await assert.rejects(register({...publication,url:'https://youtu.be/QAPubTest03'}),/PUBLICATION_CONFLICT/);
    await assert.rejects(change('pub-author','episode','edit',episode,script),/EPISODE_PUBLISHED/);
    const second=await change('pub-author','episode','create',null,script);
    const newVersion=await change('pub-author','claim','edit',claim,{...claimInput,quote:'Оновлена цитата'});
    assert.equal(newVersion.version,2);
    assert.equal((await publicationPackage(db,'pub-publisher',episode.id,1)).claim.quote,'Цитата');
    await assert.rejects(change('pub-author','episode','submit',second),/CLAIM_NOT_APPROVED/);
    const metrics={day:7,measuredAt:time(28),views:100,averageViewPercent:101.2,source:'YouTube Studio'};
    await assert.rejects(recordMetrics(db,null,first.id,metrics),/AUTH_REQUIRED/);
    await assert.rejects(recordMetrics(db,'pub-review',first.id,{...metrics,day:28}),/METRIC_TOO_EARLY/);
    await recordMetrics(db,'pub-review',first.id,metrics);
    assert.equal((await recordMetrics(db,'pub-review',first.id,metrics)).deduplicated,true);
    await assert.rejects(recordMetrics(db,'pub-review',first.id,{...metrics,views:101}),/METRIC_CONFLICT/);
    await recordMetrics(db,'pub-publisher',first.id,{...metrics,day:28,measuredAt:time(3),views:350});
    const correction=await changeCorrection(db,'pub-author',first.id,{
      action:'propose',kind:'quote',original:'Неповна цитата',replacement:'Повна цитата',reason:'Відновлено фразу',
    });
    const approve={action:'approve',id:correction.id,expectedRevision:correction.revision};
    await assert.rejects(changeCorrection(db,'pub-author',first.id,approve),/SELF_APPROVAL/);
    const approved=await changeCorrection(db,'pub-review',first.id,approve);
    await assert.rejects(changeCorrection(db,'pub-review',first.id,approve),/REVISION_CONFLICT/);
    await changeCorrection(db,'pub-publisher',first.id,{
      action:'post',id:approved.id,expectedRevision:approved.revision,location:'Закріплений коментар',
    });
    const [row]=await loadPublications(db,'pub-publisher',video.id);
    assert.deepEqual(row.metrics.map(item=>item.day),[7,28]);
    assert.equal(row.corrections[0].status,'posted');
    const {rows}=await db.query('SELECT action FROM publication_events WHERE publication_id=$1 ORDER BY id',[first.id]);
    assert.deepEqual(rows.map(row=>row.action),['register','metrics','metrics','propose','approve','post']);
  }finally{if(!native) await db.close();}
});
