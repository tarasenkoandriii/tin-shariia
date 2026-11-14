import assert from 'node:assert/strict';
import test from 'node:test';
import {captionsBookmarklet,captionsBookmarkletHref} from '../src/youtube/captions-bookmarklet.mjs';
import {captionsToSrt,mergeCaptionCues,parseCaptionPayload} from '../src/youtube/captions.mjs';
import {parseTranscript} from '../src/editorial/transcript.mjs';

const json3=events=>JSON.stringify({events:events.map(([start,dur,text])=>({tStartMs:start,dDurationMs:dur,segs:[{utf8:text}]}))});
const lines=[[0,2000,'Привіт, друзі.'],[2100,1800,'Сьогодні про заставу'],[4000,2500,'для Миронюка.'],[7000,3000,'Суд зменшив її.'],[11000,2000,'Це важливо.']];
const id='QAbookmark1';
const timedtext=(lang,kind)=>`https://www.youtube.com/api/timedtext?v=${id}&lang=${lang}${kind?'&kind='+kind:''}&pot=TOKEN&fmt=srv3&tlang=en`;
const tracks=[{languageCode:'en',kind:'asr'},{languageCode:'ru',kind:'asr'}];

function page({entries=[],playerTracks=tracks,onSetOption,panel=[],host='www.youtube.com',href=`https://www.youtube.com/watch?v=${id}`,unavailable=false}={}){
  const fetched=[],alerts=[];
  const player={getPlayerResponse:()=>unavailable?{playabilityStatus:{status:'ERROR',reason:'Відео недоступне'}}
      :({videoDetails:{videoId:id},playabilityStatus:{status:'OK'},captions:{playerCaptionsTracklistRenderer:{captionTracks:playerTracks}}}),
    loadModule(){},setOption(...args){onSetOption?.(args,entries);}};
  const row=([time,text])=>({querySelector:selector=>selector==='.segment-timestamp'?{textContent:time}:{textContent:text}});
  const win={location:{hostname:host,href},alert:message=>alerts.push(message),setTimeout:fn=>fn(),
    performance:{getEntriesByType:()=>entries.map(name=>({name}))},
    fetch:async url=>{fetched.push(url);return new Response(json3(lines));},ytInitialPlayerResponse:null};
  const doc={getElementById:name=>name==='movie_player'?player:null,querySelector:()=>null,
    querySelectorAll:selector=>selector==='ytd-transcript-segment-renderer'?panel.map(row):[]};
  return {win,doc,fetched,alerts};
}

test('bookmarklet saves the player\'s own captions as the same SRT the server would build',async()=>{
  const {win,doc,fetched}=page({entries:['https://www.youtube.com/api/stats?x=1',timedtext('en','asr'),timedtext('ru','asr')]});
  const result=await captionsBookmarklet(win,doc,{download:false});
  assert.deepEqual([result.ok,result.name,result.language,result.automatic,result.segments],[true,`${id}-ru-auto.srt`,'ru',true,4]);
  const url=new URL(fetched[0]);
  assert.deepEqual([url.searchParams.get('lang'),url.searchParams.get('fmt'),url.searchParams.get('pot'),url.searchParams.has('tlang')],['ru','json3','TOKEN',false]);
  assert.equal(result.srt,captionsToSrt(mergeCaptionCues(parseCaptionPayload(json3(lines)))));
  assert.equal(parseTranscript(Buffer.from(result.srt),'srt').segments.length,4);
});

test('bookmarklet turns captions on when the player has not loaded them yet, then falls back to the transcript panel',async()=>{
  let asked;
  const enabled=page({onSetOption:(args,entries)=>{asked=args;entries.push(timedtext('ru','asr'));}});
  assert.equal((await captionsBookmarklet(enabled.win,enabled.doc,{download:false})).ok,true);
  assert.deepEqual(asked,['captions','track',{languageCode:'ru'}]);

  const panel=page({playerTracks:[],panel:[['0:00','Привіт, друзі.'],['0:05','Сьогодні про заставу.'],['1:02:03','Суд зменшив її.'],['bad','x']]});
  const fromPanel=await captionsBookmarklet(panel.win,panel.doc,{download:false});
  assert.deepEqual([fromPanel.ok,fromPanel.segments,fromPanel.name],[true,3,`${id}-transcript.srt`]);
  assert.match(fromPanel.srt,/01:02:03,000 --> 01:02:06,000/);
  assert.equal(panel.fetched.length,0);
});

test('bookmarklet explains itself off YouTube or without captions, and its href is a valid javascript: URL',async()=>{
  const off=page({host:'tin-shariia.viral4creators.app'});
  const outside=await captionsBookmarklet(off.win,off.doc);
  assert.equal(outside.ok,false);
  assert.match(off.alerts[0],/youtube\.com/);
  const none=page({playerTracks:[]});
  assert.match((await captionsBookmarklet(none.win,none.doc,{download:false})).message,/не показує субтитрів/);
  // Closed in the editor's country: YouTube's own reason and a hint to use a VPN outside Ukraine.
  const blocked=page({unavailable:true});
  const closed=await captionsBookmarklet(blocked.win,blocked.doc,{download:false});
  assert.deepEqual([closed.ok,closed.playability],[false,'ERROR']);
  assert.match(closed.message,/«Відео недоступне».*VPN/);
  assert.equal(blocked.fetched.length,0);

  const href=captionsBookmarkletHref();
  assert.ok(href.startsWith('javascript:'));
  const code=decodeURIComponent(href.slice('javascript:'.length));
  assert.doesNotThrow(()=>new Function(code));
  assert.ok(!/tin-shariia|\/api\/videos|process\.env/.test(code),'the bookmarklet talks to youtube.com only');
});
