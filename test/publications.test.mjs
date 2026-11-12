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

const sql=['0000_editorial_import','0001_editorial_access','0002_editorial_workflow','0004_publication_records'];
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
    const publication={url:'https://youtu.be/QAPubTest02',version:episode.version,publishedAt,confirmed:true};
    const register=(data=publication)=>registerPublication(db,'pub-publisher',episode.id,data);
    await assert.rejects(register(),/APPROVAL_REQUIRED/);
    await assert.rejects(publicationPackage(db,'pub-author',episode.id,1),/FORBIDDEN/);
    episode=await change('pub-author','episode','submit',episode);
    episode=await change('pub-review','episode','approve',episode);
    const archive=unzipSync(packageZip(await publicationPackage(db,'pub-publisher',episode.id,1)));
    assert.equal(strFromU8(archive['script.txt']).trim(),script.script);
    assert.ok(archive['subtitles.txt']);
    assert.equal(JSON.parse(strFromU8(archive['manifest.json'])).format,'16:9');
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
