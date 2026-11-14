import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../src/db/runtime.mjs';
import {registerVideo} from '../src/db/editorial-import.mjs';
import {checkYouTubeCaptions,classifyCaptionsCheck} from '../src/analysis/captions-check.mjs';
import {fetchYouTubeCaptions} from '../src/youtube/captions.mjs';

const json3=events=>JSON.stringify({events:events.map(([start,dur,text])=>({tStartMs:start,dDurationMs:dur,segs:[{utf8:text}]}))});
const lines=[[0,2000,'Перше речення.'],[2500,2000,'Друге речення.'],[5000,2000,'Третє речення.'],[8000,2000,'Четверте речення.']];
const secret='hunter2';
const proxyUrl=`http://webshare-user-uk:${secret}@203.0.113.7:6123`;
const player=status=>Response.json(status==='OK'
  ?{playabilityStatus:{status:'OK'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://www.youtube.com/api/timedtext?v=QAcheck0001&lang=ru',languageCode:'ru',kind:'asr'}]}}}
  :{playabilityStatus:{status,reason:'Sign in to confirm you’re not a bot',errorScreen:{playerErrorMessageRenderer:{subreason:{simpleText:'This helps protect our community. Learn more https://support.google.com/x'}}}}});
// YouTube as seen through the proxy (proxiedFetch) or directly (baseFetch): one handler serves both.
const youtube=status=>async url=>{
  const u=new URL(url);
  if(u.pathname==='/youtubei/v1/player')return player(status);
  if(u.pathname==='/watch')return new Response(status==='OK'?'':'<script>{"status":"LOGIN_REQUIRED"}</script>');
  return new Response(json3(lines));
};
const paidTables=['ai_jobs','ai_chunks','budget_reservations','job_outbox','transcripts','transcript_segments'];

async function withDb(run){
  const native=process.env.RUN_EDITORIAL_POSTGRES_TESTS==='1';
  const db=native?await database():new PGlite();
  try{
    if(!native){
      const names=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
      for(const name of names) await db.exec(await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8'));
    }
    for(const [id,roles] of [['chk-editor',['editor']],['chk-admin',['admin']],['chk-publisher',['publisher']]]){
      const {rows:[member]}=await db.query('INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) RETURNING id',[id,id+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])',[member.id,roles]);
    }
    await run(db,await registerVideo(db,'https://youtu.be/QAcheck0001'));
  }finally{await db.close?.();}
}
async function counts(db){
  const out={};
  for(const table of paidTables) out[table]=Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  return out;
}
function captureLogs(){
  const lines=[],info=console.info,warn=console.warn;
  console.info=(...a)=>lines.push(JSON.stringify(a));console.warn=(...a)=>lines.push(JSON.stringify(a));
  return {lines,restore(){console.info=info;console.warn=warn;}};
}
// The real fetchYouTubeCaptions behind the configured proxy, with network calls mocked.
const viaProxy=({proxied,direct})=>id=>fetchYouTubeCaptions(id,{env:{YOUTUBE_CAPTIONS_PROXY_URL:proxyUrl},
  proxyDeps:{makeAgent:()=>({mock:true}),proxiedFetch:proxied,baseFetch:direct}});
const proxy407=async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:Object.assign(
  new Error(`Proxy response (407) !== 200 when HTTP Tunneling to ${proxyUrl}`),{code:'UND_ERR_ABORTED'})});};

test('captions check: success, proxy 407, LOGIN_REQUIRED and access, without any paid work',async()=>withDb(async(db,video)=>{
  const logs=captureLogs();
  try{
    // Success through the proxy: language, kind and fragment count; YouTube ID taken from the saved card.
    let askedFor;
    const ok=await checkYouTubeCaptions(db,'chk-editor',video.id,{captions:async id=>{askedFor=id;return viaProxy({proxied:youtube('OK'),direct:youtube('OK')})(id);}});
    assert.equal(askedFor,'QAcheck0001');
    assert.deepEqual([ok.status,ok.language,ok.automatic,ok.segments,ok.proxy],['available','ru',true,4,'203.0.113.7:6123']);
    assert.equal(ok.srt,undefined,'no caption text in the response');

    // Proxy refuses credentials (407): requests go direct, the editor sees proxy_auth with status only.
    const auth=await checkYouTubeCaptions(db,'chk-admin',video.id,{captions:viaProxy({proxied:proxy407,direct:youtube('LOGIN_REQUIRED')})});
    assert.equal(auth.status,'proxy_auth');
    assert.deepEqual(auth.proxyFailures[0],{status:407,codes:['UND_ERR_ABORTED']});

    // LOGIN_REQUIRED through a working proxy: exact per-source reason and YouTube's note, no links.
    const login=await checkYouTubeCaptions(db,'chk-editor',video.id,{captions:viaProxy({proxied:youtube('LOGIN_REQUIRED'),direct:youtube('OK')})});
    assert.equal(login.status,'login_required');
    assert.deepEqual(login.steps.map(step=>step.reason),['ANDROID_VR_LOGIN_REQUIRED','WEB_LOGIN_REQUIRED','WATCH_LOGIN_REQUIRED']);
    assert.match(login.steps[0].note,/Sign in to confirm/);
    assert.ok(!login.steps[0].note.includes('https://'));

    // No track and network errors are reported separately.
    assert.equal(classifyCaptionsCheck({ok:false,reason:'NO_TRACKS,NO_TRACKS,NO_TRACKS',via:'direct',
      steps:[{source:'ANDROID_VR',reason:'NO_TRACKS'},{source:'WEB',reason:'NO_TRACKS'},{source:'WATCH',reason:'NO_TRACKS'}],proxyFailures:[]}).status,'no_track');
    const net=await checkYouTubeCaptions(db,'chk-editor',video.id,{captions:id=>fetchYouTubeCaptions(id,{fetchImpl:async()=>{throw new TypeError('network');}})});
    assert.equal(net.status,'network');
    assert.equal((await checkYouTubeCaptions(db,'chk-editor',video.id,{captions:async()=>{throw Error(`boom ${proxyUrl}`);}})).status,'network');

    // Without editorial access: refused before YouTube is asked.
    let asked=0;
    const counting=async()=>{asked++;return {ok:false};};
    await assert.rejects(checkYouTubeCaptions(db,'chk-publisher',video.id,{captions:counting}),/FORBIDDEN/);
    await assert.rejects(checkYouTubeCaptions(db,'nobody',video.id,{captions:counting}),/FORBIDDEN/);
    await assert.rejects(checkYouTubeCaptions(db,'chk-editor','not-a-uuid',{captions:counting}),/INVALID_INPUT/);
    await assert.rejects(checkYouTubeCaptions(db,'chk-editor','00000000-0000-4000-8000-000000000000',{captions:counting}),/NOT_FOUND/);
    assert.equal(asked,0);

    // No outcome reserved budget, queued a job or wrote a transcript.
    assert.deepEqual(await counts(db),Object.fromEntries(paidTables.map(table=>[table,0])));

    // Logs: the three events, proxy IP:port and statuses only — no login, password, full URL or exception text.
    const joined=logs.lines.join('\n');
    for(const event of ['YOUTUBE_CAPTIONS_USED','YOUTUBE_CAPTIONS_SKIPPED','YOUTUBE_CAPTIONS_PROXY_DOWN']) assert.ok(joined.includes(event),event);
    assert.ok(joined.includes('203.0.113.7:6123'));
    for(const leak of [secret,'webshare-user-uk',proxyUrl,'Proxy response','boom']) assert.ok(!joined.includes(leak),leak);
    for(const result of [ok,auth,login,net]) for(const leak of [secret,'webshare-user-uk','Proxy response']) assert.ok(!JSON.stringify(result).includes(leak),leak);
  }finally{logs.restore();}
}));
