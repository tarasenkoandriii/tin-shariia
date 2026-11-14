import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyGoogleShareLink} from '../src/youtube/google-share.mjs';
const tracking='https://tin-shariia.viral4creators.app/go/short/test-token';
test('Google share verifies exact counter without counting a visit',async()=>{
  let calls=0;
  assert.equal(await verifyGoogleShareLink('https://share.google/abc',tracking,async()=>{
    calls++; return new Response(null,{status:302,headers:{location:tracking}});
  }),'https://share.google/abc');assert.equal(calls,1);
});
test('rejects direct Shorts, another token, HTML, private destinations and loops',async()=>{
  for(const destination of ['https://www.youtube.com/shorts/test',tracking+'x','http://127.0.0.1','https://share.google/loop'])
    await assert.rejects(verifyGoogleShareLink('https://share.google/abc',tracking,async()=>new Response(null,{status:302,headers:{location:destination}})));
  await assert.rejects(verifyGoogleShareLink('https://share.google/abc',tracking,async()=>new Response('html')));
  await assert.rejects(verifyGoogleShareLink('https://evil.example/abc',tracking,async()=>{throw Error('must not request');}));
});
