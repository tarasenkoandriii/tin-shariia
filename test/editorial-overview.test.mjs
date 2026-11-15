import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {episodeStage,listEditorialVideos,loadEditorialOverview} from '../src/db/editorial-overview.mjs';

test('episodeStage maps the latest artefact to one status and next action',()=>{
  const base={status:'approved',stale:false,published:false,grokState:null,mediaState:null,releaseApproved:false,renderState:null,uploadState:null};
  const cases=[
    [{status:'draft'},'script','Сценарій · чернетка','neutral','script'],
    [{status:'review'},'script','Сценарій · чекає рішення редактора','warning','script'],
    [{stale:true,grokState:'accepted'},'script','Потрібне повторне погодження','warning','script'],
    [{},'grok','Перевірка Grok · не запускалася','info','grok'],
    [{grokState:'submitted'},'grok','Перевірка Grok · виконується','active','grok'],
    [{grokState:'succeeded'},'grok','Перевірка Grok · чекає рішення','warning','grok'],
    [{grokState:'failed'},'grok','Перевірка Grok · помилка','danger','grok'],
    [{grokState:'unknown'},'grok','Перевірка Grok · результат невідомий','warning','grok'],
    [{grokState:'accepted'},'montage','Монтаж · очікує відео','info','montage'],
    [{grokState:'accepted',mediaState:'checking'},'montage','Монтаж · технічна перевірка','active','montage'],
    [{grokState:'accepted',mediaState:'failed'},'montage','Монтаж · помилка','danger','montage'],
    [{grokState:'accepted',mediaState:'passed'},'montage','Монтаж · чекає погодження','warning','montage'],
    [{mediaState:'passed',releaseApproved:true},'shorts','Shorts · очікує збірки','info','shorts'],
    [{mediaState:'passed',releaseApproved:true,renderState:'rendering'},'shorts','Shorts · рендер','active','shorts'],
    [{mediaState:'passed',renderState:'failed'},'shorts','Shorts · помилка рендеру','danger','shorts'],
    [{mediaState:'passed',renderState:'ready'},'shorts','Shorts · готовий до публікації','info','shorts'],
    [{renderState:'ready',uploadState:'uploading'},'publication','Публікація · завантажується в YouTube','active','publication'],
    [{renderState:'ready',uploadState:'processing'},'publication','Публікація · YouTube обробляє','active','publication'],
    [{renderState:'ready',uploadState:'failed'},'publication','Публікація · помилка','danger','publication'],
    [{renderState:'ready',uploadState:'unknown'},'publication','Публікація · результат невідомий','warning','publication'],
    [{published:true,uploadState:'failed'},'published','Опубліковано','success','publication'],
    [{uploadState:'published'},'published','Опубліковано','success','publication'],
  ];
  for(const [input,stage,label,tone,anchor] of cases){
    const result=episodeStage({...base,...input});
    assert.deepEqual([result.stage,result.label,result.tone,result.anchor],[stage,label,tone,anchor],JSON.stringify(input));
    assert.ok(result.key&&result.action,JSON.stringify(input));
  }
  assert.equal(episodeStage({...base,grokState:'failed'}).action,'Переглянути помилку');
  assert.equal(episodeStage({...base,status:'review'}).action,'Прийняти рішення');
});

async function migrated(){
  const db=new PGlite();
  const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
  for(const {tag} of journal.entries)await db.exec(await readFile(new URL('../drizzle/'+tag+'.sql',import.meta.url),'utf8'));
  return db;
}

test('overview isolates comment data by role, counts work and limits sections',async()=>{
  const db=await migrated();
  const errors=[];const original=console.error;console.error=(...args)=>{errors.push(args);};
  try{
    const member=async(clerk,roles)=>{
      const {rows:[row]}=await db.query('INSERT INTO members(clerk_user_id,email) VALUES($1,$2) RETURNING id',[clerk,clerk+'@example.test']);
      for(const role of roles)await db.query('INSERT INTO member_roles VALUES($1,$2)',[row.id,role]);
      return row.id;
    };
    const admin=await member('admin',['admin']);
    await member('checker',['factchecker']);
    const video=async(id,ago='0 hours')=>(await db.query(`INSERT INTO videos(youtube_id,created_at) VALUES($1,now()-$2::interval) RETURNING id`,[id,ago])).rows[0].id;
    const claim=async(videoId,status,question)=>{
      const {rows:[row]}=await db.query('INSERT INTO claims(video_id,created_by,status) VALUES($1,$2,$3) RETURNING id',[videoId,admin,status]);
      await db.query('INSERT INTO claim_versions(claim_id,version,author_id,content) VALUES($1,1,$2,$3::text::jsonb)',[row.id,admin,JSON.stringify({question})]);
      await db.query("INSERT INTO editorial_events(claim_id,version,revision,actor_id,action) VALUES($1,1,1,$2,'create')",[row.id,admin]);
      if(status==='review')await db.query("INSERT INTO editorial_events(claim_id,version,revision,actor_id,action) VALUES($1,1,2,$2,'submit')",[row.id,admin]);
      return row.id;
    };
    const episode=async(claimId,status,title)=>{
      const {rows:[row]}=await db.query('INSERT INTO episodes(claim_id,created_by,status) VALUES($1,$2,$3) RETURNING id',[claimId,admin,status]);
      await db.query('INSERT INTO episode_versions(episode_id,version,author_id,claim_id,claim_version,content) VALUES($1,1,$2,$3,1,$4::text::jsonb)',
        [row.id,admin,claimId,JSON.stringify({title})]);
      await db.query("INSERT INTO editorial_events(episode_id,version,revision,actor_id,action) VALUES($1,1,1,$2,'create')",[row.id,admin]);
      return row.id;
    };
    const videoA=await video('AAAAAAAAAAA');
    const approvedA=await claim(videoA,'approved','Чи правда А?');
    await episode(approvedA,'review','Сценарій А');
    await claim(videoA,'review','Питання на перевірці');
    const videoB=await video('BBBBBBBBBBB','20 days');
    const episodeB=await episode(await claim(videoB,'approved','Питання Б'),'approved','Опублікований сюжет');
    const {rows:[publication]}=await db.query(`INSERT INTO publications(episode_id,episode_version,youtube_id,published_at,recorded_by,snapshot)
      VALUES($1,1,'ShortBBBBBB',now()-interval '1 day',$2,'{}') RETURNING id`,[episodeB,admin]);
    const comment=async(kind,parent,phase)=>{
      const {rows:[row]}=await db.query(`INSERT INTO youtube_short_comments(episode_id,publication_id,parent_video_id,short_video_id,tracking_token,
        batch_request_id,state,input_snapshot,target_kind,youtube_comment_id,published_at)
        VALUES($1,$2,$3,'ShortBBBBBB',$4,$5,'published','{}',$6,'Ugw-comment-'||$3,now()-interval '2 hours') RETURNING id`,
      [episodeB,publication.id,parent,randomUUID().replaceAll('-',''),randomUUID(),kind]);
      await db.query(`INSERT INTO youtube_comment_steps(comment_id,phase,plain_text,linked_text,linked_verified_at,checked_at)
        VALUES($1,$2,'text','text link',CASE WHEN $2='verified' THEN now()-interval '1 hour' END,now()-interval '1 hour')`,[row.id,phase]);
      return row.id;
    };
    const verified=await comment('main','BBBBBBBBBBB','verified');
    const blocked=await comment('source','CCCCCCCCCCC','blocked');
    const videoC=await video('CCCCCCCCCCC','30 days');
    await episode(await claim(videoC,'approved','Питання В'),'approved','Сюжет у виробництві');
    for(let i=0;i<10;i++)await video(`Fresh${String(i).padStart(6,'0')}`,`${i+1} minutes`);

    await assert.rejects(loadEditorialOverview(db,'stranger'),/FORBIDDEN/);
    await assert.rejects(loadEditorialOverview(db,null),/FORBIDDEN/);
    await assert.rejects(listEditorialVideos(db,'stranger'),/FORBIDDEN/);

    const full=await loadEditorialOverview(db,'admin');
    assert.equal(full.stats.inReview,2);
    assert.equal(full.stats.inProduction,1);
    assert.equal(full.stats.publishedShorts7d,1);
    assert.equal(full.stats.verifiedComments7d,1);
    assert.equal(full.pipeline.length,8);
    assert.ok(full.attention.items.length<=5);
    assert.ok(full.attention.items.some(item=>item.key==='comment:'+blocked&&/видимість після перезавантаження не підтверджена/.test(item.reason)
      &&item.href==='/editorial/youtube-comments#comment-'+blocked));
    assert.ok(full.attention.items.some(item=>item.reason==='Фактчек · твердження чекає перевірки'));
    assert.ok(full.attention.items.some(item=>item.reason==='Сценарій чекає рішення'&&item.href.startsWith(`/editorial/videos/${videoA}#episode-`)));
    assert.ok(!full.attention.items.some(item=>item.key==='comment:'+verified));
    const [short]=full.publications;
    assert.equal(full.publications.length,1);
    assert.equal(short.shortYoutubeId,'ShortBBBBBB');
    assert.equal(short.sourceYoutubeId,'BBBBBBBBBBB');
    assert.equal(short.title,'Опублікований сюжет');
    assert.equal(short.href,`/editorial/videos/${videoB}#episode-${episodeB}-publication`);
    const ok=short.comments.find(item=>item.id===verified);
    assert.equal(ok.visibility.value,'confirmed');
    assert.equal(ok.send.sent,true);
    assert.equal(ok.commentUrl,'https://www.youtube.com/watch?v=BBBBBBBBBBB&lc=Ugw-comment-BBBBBBBBBBB');
    assert.equal(short.comments.find(item=>item.id===blocked).visibility.value,'not_confirmed');
    assert.equal(full.events.full,true);
    assert.ok(full.events.items.length<=6&&full.events.items.length>0);
    assert.equal(full.series.timeZone,'Europe/Kyiv');
    assert.equal(full.series.days.length,7);
    assert.equal(full.series.days.reduce((sum,day)=>sum+day.shorts,0),1);
    assert.equal(full.series.days.reduce((sum,day)=>sum+day.verifiedComments,0),1);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv'}).format(new Date());
    assert.equal(full.series.days.at(-1).day,today);

    const checker=await loadEditorialOverview(db,'checker');
    assert.equal(checker.stats.verifiedComments7d,null);
    assert.equal(checker.stats.inReview,2);
    assert.deepEqual(checker.publications[0].comments,[]);
    assert.ok(!checker.attention.items.some(item=>item.kind==='comment'));
    assert.ok(checker.attention.items.every(item=>item.reason==='Фактчек · твердження чекає перевірки'));
    assert.equal(checker.series.days.length,7);
    assert.ok(checker.series.days.every(day=>day.verifiedComments===null));
    assert.equal(checker.events.full,false);
    assert.ok(checker.events.items.length<=6);
    assert.ok(checker.events.items.some(item=>item.label==='Твердження передано на перевірку'&&item.title==='Питання на перевірці'));

    const ids=rows=>rows.map(row=>row.youtubeId).sort();
    assert.deepEqual(ids(await listEditorialVideos(db,'checker',{stage:'review'})),['AAAAAAAAAAA']);
    assert.deepEqual(ids(await listEditorialVideos(db,'checker',{stage:'production'})),['CCCCCCCCCCC']);
    assert.deepEqual(ids(await listEditorialVideos(db,'checker',{stage:'published'})),['BBBBBBBBBBB']);
    assert.equal((await listEditorialVideos(db,'checker',{stage:'factcheck'})).length,10);
    assert.equal((await listEditorialVideos(db,'checker',{stage:'bogus'})).length,13);
    assert.deepEqual(ids(await listEditorialVideos(db,'checker',{q:'у виробництві'})),['CCCCCCCCCCC']);
    assert.deepEqual(ids(await listEditorialVideos(db,'checker',{q:'bbbbb'})),['BBBBBBBBBBB']);
    const [published]=await listEditorialVideos(db,'checker',{stage:'published'});
    assert.equal(published.label,'Опубліковано');assert.equal(published.claims,1);assert.equal(published.episodes,1);
    assert.deepEqual(errors,[],'no section failed');
  }finally{console.error=original;await db.close();}
});
