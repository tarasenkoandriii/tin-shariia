import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCommentShortLink,verifyCommentShortLink} from '../src/youtube/comment-short-link.mjs';
const target='https://example.test/go/short/unique';
const redirect=location=>new Response(null,{status:302,headers:{location}});
test('Google preference avoids creation; validation never visits counter',async()=>{
 const calls=[];const result=await createCommentShortLink(target,{googleLink:'https://share.google/abc',request:async url=>{calls.push(String(url));return redirect(target);}});
 assert.equal(result.provider,'google');assert.deepEqual(calls,['https://share.google/abc']);
});
test('creates and verifies free fallback after Google fails, encoding unique target',async()=>{
 const result=await createCommentShortLink(target,{googleLink:'https://share.google/abc',request:async url=>{
  const u=new URL(url);if(u.hostname==='share.google')return new Response('no');
  if(u.pathname==='/create.php'){assert.equal(u.searchParams.get('url'),target);return Response.json({shorturl:'https://is.gd/abc'});}
  return redirect(target);
 }});assert.equal(result.url,'https://is.gd/abc');
});
test('provider failure falls back once and refuses wrong destination and arbitrary hosts',async()=>{
 const result=await createCommentShortLink(target,{request:async url=>{
 const u=new URL(url);if(u.hostname==='is.gd')return new Response('',{status:503});
 return u.pathname==='/create.php'?Response.json({shorturl:'https://v.gd/abc'}):redirect(target);
 }});assert.equal(result.provider,'v.gd');
 await assert.rejects(verifyCommentShortLink('https://is.gd/abc',target,async()=>redirect(target+'wrong')));
 await assert.rejects(verifyCommentShortLink('http://127.0.0.1/',target,async()=>{throw Error('must not request');}));
 await assert.rejects(createCommentShortLink(target,{request:async()=>new Response('',{status:503})}),/SHORTENER_UNAVAILABLE/);
});
