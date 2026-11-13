import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyYouTubeCommentTarget} from '../src/youtube/comment-target.mjs';
import {publishOne} from '../src/youtube/comments.mjs';
import {recordYouTubeShortCommentClick} from '../src/db/youtube-comments.mjs';
import {SHARIY_CHANNEL_ID} from '../src/youtube/shariy-channel.mjs';

const scope='https://www.googleapis.com/auth/youtube.force-ssl';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base={id,short_video_id:'short-id',channel_id:'ours',approved_channel_id:'ours',scopes:[scope],final_text:'Схвалений текст'};
const metadata=(row,{channel,privacy='public'}={})=>async()=>Response.json({items:[
  {id:row.parent_video_id,snippet:{channelId:channel??(row.target_kind==='source'?SHARIY_CHANNEL_ID:'ours')},status:{privacyStatus:'public'}},
  {id:row.short_video_id,snippet:{channelId:'ours'},status:{privacyStatus:privacy}},
]});
const verify=(row,options)=>verifyYouTubeCommentTarget(row,{apiKey:'test',fetchImpl:metadata(row,options)});

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
    const row={...base,target_kind,parent_video_id};
    const db=scheduledDb(row);
    let requests=0;
    const deps={verify,accessToken:async()=>'test',fetchImpl:async(url,options)=>{
      requests++;
      assert.equal(url.pathname,'/youtube/v3/commentThreads');
      const {snippet}=JSON.parse(options.body);
      assert.equal(snippet.videoId,parent_video_id);
      assert.equal(snippet.channelId,target_kind==='source'?SHARIY_CHANNEL_ID:'ours');
      assert.equal(snippet.topLevelComment.snippet.textOriginal,row.final_text);
      return Response.json({id:'thread',snippet:{topLevelComment:{id:'comment',snippet:{publishedAt:'2026-11-13T18:00:00Z'}}}});
    }};
    const results=await Promise.all([publishOne(db,deps),publishOne(db,deps)]);
    assert.equal(requests,1);
    assert.equal(results.reduce((sum,result)=>sum+result.published,0),1);
  });
}

test('refuses another source channel, private Shorts and a missing scope',async()=>{
  const row={...base,target_kind:'source',parent_video_id:'original-id'};
  await assert.rejects(verify(row,{channel:'repost'}),/WRONG_TARGET_CHANNEL/);
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
  const db={query:async(sql,args)=>{calls.push(args);return {rows:sql.startsWith('SELECT')?[{id,short_video_id:'short-id'}]:[]};}};
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
