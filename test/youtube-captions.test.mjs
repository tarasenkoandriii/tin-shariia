import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {database} from '../src/db/runtime.mjs';
import {registerVideo} from '../src/db/editorial-import.mjs';
import {enqueueYouTubePreferCaptions} from '../src/analysis/queue.mjs';
import {captionsFetch,captionsProxyUrl,isProxyFailure,proxyHostForDisplay,webshareProxyUrl} from '../src/youtube/proxy.mjs';
import {captionTracksFromHtml,captionsToSrt,fetchYouTubeCaptions,mergeCaptionCues,parseCaptionPayload,pickCaptionTrack} from '../src/youtube/captions.mjs';
import {parseTranscript} from '../src/editorial/transcript.mjs';

const config={model:'gemini-test',inputRate:1,outputRate:1,monthlyMicros:50_000_000};
const json3=events=>JSON.stringify({events:events.map(([start,dur,text])=>({tStartMs:start,dDurationMs:dur,segs:[{utf8:text}]}))});
const lines=[[0,2000,'Привіт, друзі.'],[2100,1800,'Сьогодні про заставу'],[4000,2500,'для Миронюка.'],[7000,3000,'Суд зменшив її до 25 мільйонів.'],
  [11000,2000,'Це важливо.']];

test('caption tracks: picks manual ru/uk over auto, parses json3 and XML, merges into sentences',()=>{
  const tracks=[{baseUrl:'https://www.youtube.com/api/timedtext?v=x&lang=ru&kind=asr',languageCode:'ru',kind:'asr'},
    {baseUrl:'https://www.youtube.com/api/timedtext?v=x&lang=en',languageCode:'en'},
    {baseUrl:'https://www.youtube.com/api/timedtext?v=x&lang=uk',languageCode:'uk'}];
  assert.equal(pickCaptionTrack(tracks).languageCode,'uk');
  assert.equal(pickCaptionTrack(tracks.slice(0,2)).languageCode,'en');
  assert.equal(pickCaptionTrack([]),null);
  const html='<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":'
    +JSON.stringify([{baseUrl:'https://www.youtube.com/api/timedtext?v=x&a="]',languageCode:'ru'}])+',"audioTracks":[]}}};</script>';
  assert.equal(captionTracksFromHtml(html)[0].languageCode,'ru');
  assert.equal(captionTracksFromHtml('<html></html>'),null);
  assert.equal(parseCaptionPayload(json3(lines)).length,5);
  const xml=parseCaptionPayload('<?xml version="1.0"?><transcript><text start="1.5" dur="2">Застава &amp;amp; суд</text><text start="4" dur="1"> </text></transcript>');
  assert.deepEqual(xml,[{startMs:1500,endMs:3500,text:'Застава & суд'}]);
  const merged=mergeCaptionCues(parseCaptionPayload(json3(lines)));
  assert.deepEqual(merged.map(s=>s.text),['Привіт, друзі.','Сьогодні про заставу для Миронюка.','Суд зменшив її до 25 мільйонів.','Це важливо.']);
  // The SRT built from captions passes the editorial transcript parser unchanged.
  const parsed=parseTranscript(Buffer.from(captionsToSrt(merged)),'srt');
  assert.deepEqual(parsed.segments.map(s=>[s.startMs,s.endMs]),[[0,2000],[2100,6500],[7000,10000],[11000,13000]]);
});

test('fetchYouTubeCaptions uses the player API, falls back to the watch page and never throws',async()=>{
  const track={baseUrl:'https://www.youtube.com/api/timedtext?v=QAcaption01&lang=ru',languageCode:'ru',kind:'asr'};
  const calls=[];
  const ok=await fetchYouTubeCaptions('QAcaption01',{fetchImpl:async(url,init)=>{
    calls.push(`${init?.method??'GET'} ${new URL(url).pathname} ${new URL(url).searchParams.get('fmt')??''}`);
    if(String(url).includes('/youtubei/v1/player'))return Response.json({playabilityStatus:{status:'OK'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[track]}}});
    return new Response(json3(lines));
  }});
  assert.equal(ok.ok,true);
  assert.deepEqual([ok.language,ok.automatic,ok.segments.length],['ru',true,4]);
  assert.deepEqual(calls,['POST /youtubei/v1/player ','GET /api/timedtext json3']);
  const clientNames=[];
  await fetchYouTubeCaptions('QAcaption01',{fetchImpl:async(url,init)=>{
    if(String(url).includes('/youtubei/v1/player')){clientNames.push(JSON.parse(init.body).context.client.clientName+'/'+init.headers['X-YouTube-Client-Name']);
      return Response.json({playabilityStatus:{status:clientNames.length===1?'LOGIN_REQUIRED':'OK'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[track]}}});}
    return new Response(json3(lines));
  }});
  assert.deepEqual(clientNames,['ANDROID_VR/28','WEB/1']);
  // Bot check on the player API → watch page; empty json3 → default XML format.
  const fallback=await fetchYouTubeCaptions('QAcaption01',{fetchImpl:async url=>{
    const u=new URL(url);
    if(u.pathname==='/youtubei/v1/player')return Response.json({playabilityStatus:{status:'LOGIN_REQUIRED'}});
    if(u.pathname==='/watch')return new Response('x "captionTracks":'+JSON.stringify([track])+',"y":1');
    if(u.searchParams.get('fmt')==='json3')return new Response('');
    return new Response('<transcript>'+lines.map(([s,d,t])=>`<text start="${s/1000}" dur="${d/1000}">${t}</text>`).join('')+'</transcript>');
  }});
  assert.equal(fallback.ok,true);
  assert.equal(fallback.segments.length,4);
  const blocked=await fetchYouTubeCaptions('QAcaption01',{fetchImpl:async url=>new URL(url).pathname==='/youtubei/v1/player'
    ?Response.json({playabilityStatus:{status:'LOGIN_REQUIRED'}}):new Response('<form action="https://consent.youtube.com/save">')});
  assert.deepEqual(blocked,{ok:false,reason:'ANDROID_VR_LOGIN_REQUIRED,WEB_LOGIN_REQUIRED,WATCH_CONSENT',via:'custom'});
  assert.deepEqual(await fetchYouTubeCaptions('QAcaption01',{fetchImpl:async()=>{throw new TypeError('network');}}),{ok:false,reason:'FETCH_FAILED,FETCH_FAILED,FETCH_FAILED',via:'custom'});
  assert.deepEqual(await fetchYouTubeCaptions('bad id'),{ok:false,reason:'INVALID_ID'});
  // A track URL pointing off YouTube is never fetched.
  const offsite=await fetchYouTubeCaptions('QAcaption01',{fetchImpl:async url=>{
    if(new URL(url).hostname==='evil.example')throw Error('must not fetch');
    return Response.json({captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://evil.example/t',languageCode:'ru'}]}}});
  }});
  assert.equal(offsite.ok,false);
});

test('whole-video request uses YouTube captions first and falls back to video windows',async()=>{
  const native=process.env.RUN_EDITORIAL_POSTGRES_TESTS==='1';
  const db=native?await database():new PGlite();
  try{
    if(!native){
      const names=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
      for(const name of names) await db.exec(await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8'));
    }
    for(const [id,roles] of [['cap-author',['author']],['cap-reader',['publisher']]]){
      const {rows:[member]}=await db.query('INSERT INTO members (clerk_user_id,email) VALUES ($1,$2) RETURNING id',[id,id+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])',[member.id,roles]);
    }
    const video=await registerVideo(db,'https://youtu.be/QAcaption01');
    const segments=mergeCaptionCues(parseCaptionPayload(json3(lines)));
    const found={ok:true,language:'ru',automatic:true,segments,srt:captionsToSrt(segments)};
    let asked=0;
    const captions=async id=>{asked++;assert.equal(id,'QAcaption01');return found;};

    await assert.rejects(enqueueYouTubePreferCaptions(db,'cap-reader',video.id,{source:'youtube'},config,{captions}),/FORBIDDEN/);
    assert.equal(asked,0,'no YouTube request for an unauthorised member');

    const viaCaptions=await enqueueYouTubePreferCaptions(db,'cap-author',video.id,{source:'youtube'},config,{captions,duration:async()=>null});
    assert.equal(viaCaptions.source,'captions');
    assert.deepEqual(viaCaptions.captions,{language:'ru',automatic:true,segments:4});
    const {rows:[job]}=await db.query('SELECT mode,transcript_id FROM ai_jobs WHERE id=$1',[viaCaptions.id]);
    assert.deepEqual([job.mode,job.transcript_id],['transcript',viaCaptions.transcriptId]);
    const {rows:stored}=await db.query('SELECT start_ms,body FROM transcript_segments WHERE transcript_id=$1 ORDER BY position',[viaCaptions.transcriptId]);
    assert.deepEqual(stored.map(r=>[Number(r.start_ms),r.body]).slice(1,2),[[2100,'Сьогодні про заставу для Миронюка.']]);
    // Same captions again: same transcript, same (deduplicated) job — no second charge.
    const again=await enqueueYouTubePreferCaptions(db,'cap-author',video.id,{source:'youtube'},config,{captions});
    assert.deepEqual([again.id,again.deduplicated,again.transcriptId],[viaCaptions.id,true,viaCaptions.transcriptId]);

    // Unavailable captions → whole-video analysis with the reason.
    await db.query("UPDATE ai_jobs SET status='succeeded'");
    const viaVideo=await enqueueYouTubePreferCaptions(db,'cap-author',video.id,{source:'youtube',durationSec:900},config,
      {captions:async()=>({ok:false,reason:'PLAYER_LOGIN_REQUIRED'}),duration:async()=>null});
    assert.deepEqual([viaVideo.source,viaVideo.captionsSkipped],['video','PLAYER_LOGIN_REQUIRED']);
    assert.equal((await db.query('SELECT mode FROM ai_jobs WHERE id=$1',[viaVideo.id])).rows[0].mode,'youtube');

    // Opt-out and retries go straight to video, without asking YouTube for captions.
    const before=asked;
    const optOut=await enqueueYouTubePreferCaptions(db,'cap-author',video.id,{source:'youtube',captions:false,durationSec:900},config,{captions,duration:async()=>null});
    assert.deepEqual([optOut.source,optOut.captionsSkipped,optOut.id],['video','DISABLED',viaVideo.id]);
    const disabled=await enqueueYouTubePreferCaptions(db,'cap-author',video.id,{source:'youtube',durationSec:900},config,
      {captions,duration:async()=>null,env:{YOUTUBE_CAPTIONS_ENABLED:'false'}});
    assert.equal(disabled.captionsSkipped,'DISABLED');
    assert.equal(asked,before);
  }finally{await db.close?.();}
});

test('captions proxy: Webshare URL like roadscout, full URL wins, falls back direct only when the proxy is down',async()=>{
  assert.equal(webshareProxyUrl({}),null);
  assert.equal(webshareProxyUrl({WEBSHARE_PROXY_USERNAME:'user',WEBSHARE_PROXY_PASSWORD:'p@ss',WEBSHARE_PROXY_COUNTRY:'DE'}),
    'http://user-de-rotate:p%40ss@p.webshare.io:80');
  assert.equal(webshareProxyUrl({WEBSHARE_PROXY_USERNAME:'u',WEBSHARE_PROXY_PASSWORD:'p',WEBSHARE_PROXY_ROTATE:'false',WEBSHARE_PROXY_HOST:'h',WEBSHARE_PROXY_PORT:'8080'}),'http://u:p@h:8080');
  assert.equal(captionsProxyUrl({YOUTUBE_CAPTIONS_PROXY_URL:'http://a:b@proxy.example:3128',WEBSHARE_PROXY_USERNAME:'u',WEBSHARE_PROXY_PASSWORD:'p'}),'http://a:b@proxy.example:3128');
  assert.equal(captionsProxyUrl({HTTPS_PROXY:'http://corp:1'}),null,'HTTPS_PROXY must not reroute captions implicitly');
  assert.equal(proxyHostForDisplay('http://a:secret@proxy.example:3128'),'proxy.example:3128');
  assert.equal(captionsFetch({}).via,'direct');

  const env={YOUTUBE_CAPTIONS_PROXY_URL:'http://a:secret@proxy.example:3128'};
  let proxied=0,direct=0,agentUrl;
  const deps=failing=>({makeAgent:url=>{agentUrl=url;return {proxy:true};},
    proxiedFetch:async(url,init)=>{proxied++;assert.deepEqual(init.dispatcher,{proxy:true});if(failing)throw failing;return new Response('via proxy');},
    baseFetch:async()=>{direct++;return new Response('direct');}});
  const ok=captionsFetch(env,deps(null));
  assert.equal(ok.via,'proxy proxy.example:3128');
  assert.equal(await (await ok.fetchImpl('https://www.youtube.com/x')).text(),'via proxy');
  assert.equal(agentUrl,env.YOUTUBE_CAPTIONS_PROXY_URL);
  const warn=console.warn;const warnings=[];console.warn=(...a)=>warnings.push(JSON.stringify(a));
  try{
    const down=captionsFetch({YOUTUBE_CAPTIONS_PROXY_URL:'http://a:secret@other.example:1'},deps(Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}})));
    assert.equal(await (await down.fetchImpl('https://www.youtube.com/x')).text(),'direct');
    assert.equal(direct,1);
    // YouTube's own refusal through a working proxy is not retried directly.
    const refused=captionsFetch({YOUTUBE_CAPTIONS_PROXY_URL:'http://a:secret@third.example:1'},deps(new Error('aborted')));
    await assert.rejects(refused.fetchImpl('https://www.youtube.com/x'),/aborted/);
    assert.equal(direct,1);
  }finally{console.warn=warn;}
  assert.ok(warnings.length===1&&!warnings[0].includes('secret'));
  assert.equal(isProxyFailure({message:'Proxy response (407) !== 200 when HTTP Tunneling'}),true);
  assert.equal(isProxyFailure(new Error('HTTP 429')),false);
  assert.equal(proxied,3);
});
