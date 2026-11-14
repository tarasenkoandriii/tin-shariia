import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyYouTubeCommentTarget} from '../src/youtube/comment-target.mjs';
import {refreshYouTubeAccessToken} from '../src/youtube/oauth.mjs';
import {publishOne,youtubeCommentPreflightCode} from '../src/youtube/comments.mjs';
import {recordYouTubeShortCommentClick} from '../src/db/youtube-comments.mjs';
import {SHARIY_CHANNEL_ID} from '../src/youtube/shariy-channel.mjs';

const scope='https://www.googleapis.com/auth/youtube.force-ssl';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base={id,short_video_id:'short-id',channel_id:'ours',approved_channel_id:'ours',scopes:[scope],final_text:'Схвалений текст'};
const metadata=(row,{channel,privacy='public'}={})=>async()=>Response.json({items:[
  {id:row.parent_video_id,snippet:{channelId:channel??(row.target_kind==='source'?SHARIY_CHANNEL_ID:'ours')},status:{privacyStatus:'public'}},
  {id:row.short_video_id,snippet:{channelId:'ours'},status:{privacyStatus:privacy}},
]});
const verify=(row,options)=>verifyYouTubeCommentTarget({source_video_id:row.parent_video_id,...row},{apiKey:'test',fetchImpl:metadata(row,options)});

function scheduledDb(row){
  let pending=true;
  const writes=[];
  const query=async(sql,args)=>{
    if(sql.includes('FROM youtube_comment_settings')) return {rows:[{enabled:true,interval_hours:3}]};
    if(sql.includes('SELECT c.id,c.final_text')) {
      if(!pending)return {rows:[]};
      pending=false;
      return {rows:[row]};
    }
    if(sql.includes('RETURNING id')){writes.push(args);return {rows:[{id}]};}
    return {rows:[]};
  };
  return {query,transaction:work=>work({query}),writes};
}

for(const [target_kind,parent_video_id] of [['source','original-id'],['main','main-id']]){
  test(`commentThreads.insert targets ${target_kind} and accepts a single thread resource`,async()=>{
    const row={...base,target_kind,parent_video_id,...(target_kind==='source'?{plain_text:'Текст без URL',final_text:'Текст без URL\n\nhttps://www.youtube.com/shorts/short-id'}:{})};
    const db=scheduledDb(row);
    let requests=0;
    const deps={verify,accessToken:async()=>'test',fetchImpl:async(url,options)=>{
      requests++;
      assert.equal(url.pathname,'/youtube/v3/commentThreads');
      const {snippet}=JSON.parse(options.body);
      assert.equal(snippet.videoId,parent_video_id);
      assert.equal(snippet.channelId,target_kind==='source'?SHARIY_CHANNEL_ID:'ours');
      assert.equal(snippet.topLevelComment.snippet.textOriginal,row.plain_text??row.final_text);
      return Response.json({id:'thread',snippet:{topLevelComment:{id:'comment',snippet:{publishedAt:'2026-11-13T18:00:00Z'}}}});
    }};
    const results=await Promise.all([publishOne(db,deps),publishOne(db,deps)]);
    assert.equal(requests,1);
    assert.equal(results.reduce((sum,result)=>sum+result.published,0),1);
  });
}

test('accepts any saved source channel and rejects a mismatched video, private Shorts and missing scope',async()=>{
  const row={...base,target_kind:'source',parent_video_id:'original-id'};
  assert.equal(await verify(row,{channel:'another-source-channel'}),'another-source-channel');
  await assert.rejects(verify({...row,source_video_id:'different-video'}),/TARGET_UNVERIFIED/);
  await assert.rejects(verify(row,{privacy:'private'}),/SHORT_NOT_PUBLIC/);
  await assert.rejects(verify({...row,scopes:[]}),/SCOPE_REQUIRED/);
});

test('records disabled comments and fences an unknown POST outcome',async()=>{
  const row={...base,target_kind:'source',parent_video_id:'original-id'};
  for(const [fetchImpl,expected] of [
    [async()=>Response.json({error:{errors:[{reason:'commentsDisabled'}]}},{status:403}),'failed'],
    [async()=>{throw Error('connection lost');},'unknown'],
  ]){
    const db=scheduledDb(row);
    const deps={verify,accessToken:async()=>'test',fetchImpl};
    await publishOne(db,deps);
    assert.equal(db.writes[0][1],expected);
    assert.equal(db.writes[0][2],expected==='failed'?'YOUTUBE_COMMENTSDISABLED':'YOUTUBE_COMMENT_OUTCOME_UNKNOWN');
    assert.deepEqual(await publishOne(db,deps),{published:0});
  }
});

test('tracking token records one redirect to the published Short',async()=>{
  const token='a'.repeat(32),calls=[];
  const db={query:async(sql,args)=>{calls.push(args);return {rows:sql.startsWith('SELECT')?[{id,short_video_id:'short-id',state:'published'}]:[]};}};
  assert.equal(await recordYouTubeShortCommentClick(db,token),'https://www.youtube.com/shorts/short-id');
  assert.deepEqual(calls,[[token],[id]]);
});

test('migrated database supports the dashboard and both queues',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');
  const {readFile}=await import('node:fs/promises');
  const {loadYouTubeCommentDashboard,queueYouTubeCommentDrafts,claimScheduledYouTubeComment,createYouTubeCommentDraft}=await import('../src/db/youtube-comments.mjs');
  const db=new PGlite();
  const previous=process.env.APP_ORIGIN;
  process.env.APP_ORIGIN='https://example.test';
  try{
    const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
    for(const {tag} of journal.entries)await db.exec(await readFile(new URL('../drizzle/'+tag+'.sql',import.meta.url),'utf8'));
    const {rows:[member]}=await db.query("INSERT INTO members(clerk_user_id,email) VALUES('editor','editor@example.test') RETURNING id");
    await db.query("INSERT INTO member_roles(member_id,role) VALUES($1,'editor')",[member.id]);
    const dashboard=await loadYouTubeCommentDashboard(db,'editor');
    assert.equal(dashboard.settings.enabled,false);
    assert.equal(dashboard.settings.interval_hours,3);
    await db.query('UPDATE youtube_comment_settings SET enabled=true');
    assert.deepEqual(await queueYouTubeCommentDrafts(db),[]);
    assert.equal(await claimScheduledYouTubeComment(db),null);
    await assert.rejects(createYouTubeCommentDraft(db,'editor',{uploadId:member.id,targetKind:'source',generate:false}),/TARGET_UNVERIFIED/);
  }finally{
    if(previous===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previous;
    await db.close();
  }
});

test('Studio Short becomes a candidate and waits for official target verification',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');
  const {readFile}=await import('node:fs/promises');
  const {registerVideo}=await import('../src/db/editorial-import.mjs');
  const {changeEditorial}=await import('../src/db/editorial-workflow.mjs');
  const {createYouTubeCommentDraft,loadYouTubeCommentDashboard,queueYouTubeCommentDrafts,
    verifyPendingYouTubeCommentDrafts,approveYouTubeComment,recoverYouTubeComment,recordYouTubeCommentFailure,claimScheduledYouTubeComment}=await import('../src/db/youtube-comments.mjs');
  const db=new PGlite(),previous=process.env.APP_ORIGIN;
  process.env.APP_ORIGIN='https://example.test';
  try{
    const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
    for(const {tag} of journal.entries)await db.exec(await readFile(new URL('../drizzle/'+tag+'.sql',import.meta.url),'utf8'));
    for(const [name,roles] of [['author',['author']],['reviewer',['editor','factchecker']]]){
      const {rows:[member]}=await db.query('INSERT INTO members(clerk_user_id,email) VALUES($1,$2) RETURNING id',[name,name+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])',[member.id,roles]);
    }
    const {rows:[member]}=await db.query("SELECT id FROM members WHERE clerk_user_id='author'");
    const video=await registerVideo(db,'https://youtu.be/SVIDu_m8UT4');
    const change=(identity,kind,action,item,extra={})=>changeEditorial(db,identity,kind,{
      ...extra,action,id:item?.id,version:item?.version,expectedRevision:item?.revision});
    let claim=await change('author','claim','create',null,{parentId:video.id,quote:'Quote',question:'Question?',
      verdict:'confirmed',explanation:'Test',evidence:[{title:'Report',url:'https://example.test/source',accessedOn:'2026-11-14',locator:'1',coverage:'Fact'}]});
    claim=await change('author','claim','submit',claim);
    claim=await change('reviewer','claim','approve',claim);
    let episode=await change('author','episode','create',null,{parentId:claim.id,claimVersion:claim.version,
      title:'Studio Short',script:'Approved script',pinnedComment:'Context'});
    episode=await change('author','episode','submit',episode);
    episode=await change('reviewer','episode','approve',episode);
    const {rows:[media]}=await db.query(`INSERT INTO episode_media_revisions(episode_id,episode_version,uploaded_by,
      ordinal,pathname,expected_bytes,upload_until,expires_at,snapshot,state,sha256,report)
      VALUES($1,$2,$3,1,'test.mp4',100,now(),now()+interval '1 day','{}','passed',$4,
      '{"width":720,"height":1280,"durationMs":27648}') RETURNING id`,[episode.id,episode.version,member.id,'a'.repeat(64)]);
    const {rows:[publication]}=await db.query(`INSERT INTO publications(episode_id,episode_version,media_revision_id,
      youtube_id,published_at,recorded_by,snapshot,ai_disclosed) VALUES($1,$2,$3,'QdaWfN4b6Bg',now(),$4,
      '{"episode":{"title":"Studio Short"}}',true) RETURNING id`,[episode.id,episode.version,media.id,member.id]);
    await db.query(`INSERT INTO youtube_connections(owner_id,channel_id,channel_title,scopes)
      VALUES($1,'ours','Our channel',$2)`,[member.id,[scope]]);
    const data=await loadYouTubeCommentDashboard(db,'reviewer');
    assert.equal(data.candidates.length,1);
    assert.equal(data.candidates[0].kind,'publication');
    await assert.rejects(createYouTubeCommentDraft(db,'reviewer',{publicationId:publication.id,targetKind:'main',generate:false,text:'Текст'}),/MAIN_EPISODE_REQUIRED/);
    const input={publicationId:publication.id,targetKind:'source',generate:false,text:'Зіставили цитату з документом.'};
    const drafts=await Promise.all([createYouTubeCommentDraft(db,'reviewer',input),createYouTubeCommentDraft(db,'reviewer',input)]);
    assert.equal(drafts[0].id,drafts[1].id);
    assert.deepEqual(await queueYouTubeCommentDrafts(db),[],'unverified manual draft never goes to Grok');
    let checks=0;
    assert.deepEqual(await verifyPendingYouTubeCommentDrafts(db,async row=>{
      checks++;assert.equal(row.parent_video_id,'SVIDu_m8UT4');assert.equal(row.short_video_id,'QdaWfN4b6Bg');
      return verify(row);
    }),{verified:1});
    assert.equal(checks,1);
    const {rows:[draft]}=await db.query('SELECT * FROM youtube_short_comments WHERE id=$1',[drafts[0].id]);
    assert.equal(draft.state,'succeeded');
    assert.equal(draft.upload_id,null);
    assert.equal(draft.publication_id,publication.id);
    assert.match(draft.tracking_token,/^[A-Za-z0-9_-]{32}$/);
    await db.query('UPDATE youtube_comment_settings SET enabled=true');
    const approval={text:input.text,targetVideoId:'SVIDu_m8UT4',channelId:'ours',
      link:'https://example.test/go/short/'+draft.tracking_token};
    await assert.rejects(approveYouTubeComment(db,'reviewer',draft.id,approval,verify),/SHORT_LINK_REQUIRED/);
    const oldFetch=globalThis.fetch;
    try {
      globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:approval.link}});
      await approveYouTubeComment(db,'reviewer',draft.id,{...approval,shortLink:'https://share.google/test123'},verify);
    } finally { globalThis.fetch=oldFetch; }
    const {rows:[steps]}=await db.query('SELECT * FROM youtube_comment_steps WHERE comment_id=$1',[draft.id]);
    assert.equal(steps.plain_text,input.text);
    assert.equal(steps.linked_text,input.text+'\n\nhttps://share.google/test123');
    assert.equal((await db.query('SELECT state FROM youtube_short_comments WHERE id=$1',[draft.id])).rows[0].state,'scheduled');
    assert.equal(await recordYouTubeShortCommentClick(db,draft.tracking_token),null,'scheduled links stay inactive until published');
    await db.query("UPDATE youtube_short_comments SET state='publishing' WHERE id=$1",[draft.id]);
    await recordYouTubeCommentFailure(db,draft.id,'YOUTUBE_TOKEN_REFRESH_REVOKED');
    await assert.rejects(recoverYouTubeComment(db,'author',draft.id),/FORBIDDEN/);
    assert.equal((await recoverYouTubeComment(db,'reviewer',draft.id)).state,'succeeded');
    const {rows:[recovered]}=await db.query('SELECT * FROM youtube_short_comments WHERE id=$1',[draft.id]);
    assert.equal(recovered.draft_text,input.text);
    assert.equal(recovered.tracking_token,draft.tracking_token);
    assert.equal(recovered.approved_at,null);
    assert.equal(recovered.final_text,null);
    assert.equal(await claimScheduledYouTubeComment(db),null);
    await db.query("UPDATE youtube_short_comments SET state='unknown',error_code='YOUTUBE_TOKEN_REFRESH_REVOKED' WHERE id=$1",[draft.id]);
    await assert.rejects(recoverYouTubeComment(db,'reviewer',draft.id),/NOT_READY/);

    const {claimCommentVisibility,finishCommentVisibility,claimCommentLinkUpdate,finishCommentLinkUpdate}
      =await import('../src/db/youtube-comment-steps.mjs');
    await db.query("UPDATE youtube_short_comments SET state='published',youtube_comment_id='UgTestComment123' WHERE id=$1",[draft.id]);
    const check=await claimCommentVisibility(db);
    assert.equal(check.expectedText,input.text);
    assert.equal(await claimCommentVisibility(db),null);
    assert.equal(await claimCommentLinkUpdate(db),null);
    assert.equal(await finishCommentVisibility(db,{...check,visible:true}),true);
    assert.equal(await finishCommentVisibility(db,{...check,visible:true}),false,'stale confirmation cannot advance twice');
    const update=await claimCommentLinkUpdate(db);
    assert.equal(update.youtube_comment_id,'UgTestComment123');
    assert.equal(update.linked_text,steps.linked_text);
    assert.equal(await claimCommentLinkUpdate(db),null,'one update lease');
    await finishCommentLinkUpdate(db,update,'YOUTUBE_COMMENT_EDIT_UNCONFIRMED');
    assert.equal(await claimCommentLinkUpdate(db),null,'unknown PUT outcome is never automatically retried');
    const linkedCheck=await claimCommentVisibility(db);
    assert.equal(linkedCheck.expectedText,steps.linked_text);
    assert.equal(await finishCommentVisibility(db,{...linkedCheck,visible:true}),true);
    assert.equal((await db.query('SELECT phase FROM youtube_comment_steps WHERE comment_id=$1',[draft.id])).rows[0].phase,'verified');
    assert.equal(await claimCommentVisibility(db),null);
  }finally{
    if(previous===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previous;
    await db.close();
  }
});


test('OAuth diagnostics expose only the allowlisted refresh failure code',async()=>{
  for(const [providerError,code] of [['invalid_grant','YOUTUBE_TOKEN_REFRESH_REVOKED'],
    ['invalid_client','YOUTUBE_TOKEN_REFRESH_CLIENT'],['unexpected','YOUTUBE_TOKEN_REFRESH_FAILED']]){
    await assert.rejects(refreshYouTubeAccessToken('test',{clientId:'test',clientSecret:'test'},
      async()=>Response.json({error:providerError,error_description:'private detail'},{status:400})),
      error=>error.message===code&&youtubeCommentPreflightCode(error)===code);
  }
});

test('link edit updates the existing comment and sends uncertain results to reload verification',async()=>{
  const {appendVisibleCommentLink}=await import('../src/youtube/comments.mjs');
  const row={...base,lease:id,youtube_comment_id:'UgExisting123',linked_text:'Текст\n\nhttps://www.youtube.com/shorts/short-id'};
  let claimed=false,finished;
  const db={query:async(sql,args)=>{
    if(sql.includes('WITH candidate')){
      if(claimed)return {rows:[]};
      claimed=true;return {rows:[row]};
    }
    finished=args;return {rows:[]};
  }};
  const result=await appendVisibleCommentLink(db,{verify:async()=>{},accessToken:async()=>'test',
    fetchImpl:async(url,options)=>{
      assert.equal(options.method,'PUT');
      assert.ok(url.includes('/comments?part=snippet'));
      assert.deepEqual(JSON.parse(options.body),{id:row.youtube_comment_id,snippet:{textOriginal:row.linked_text}});
      throw Error('Response lost');
    }});
  assert.equal(result.edited,0);
  assert.equal(finished[2],'YOUTUBE_COMMENT_EDIT_UNCONFIRMED');
  assert.deepEqual(await appendVisibleCommentLink(db),{edited:0});
});
