import assert from 'node:assert/strict';
import test from 'node:test';
import recovery from '../services/youtube-reader/recovery.cjs';

test('capture distinguishes authentication, unavailable video and geographical restriction',()=>{
  assert.equal(recovery.quoteError('LOGIN_REQUIRED'),'QUOTE_SESSION_REQUIRED');
  assert.equal(recovery.quoteError('UNPLAYABLE','not available in your country'),'QUOTE_GEO_BLOCKED');
  assert.equal(recovery.quoteError('ERROR','Video removed'),'QUOTE_VIDEO_UNAVAILABLE');
  assert.equal(recovery.quoteError('OK'),null);
});

test('logged-in video explicitly starts playback before waiting for the buffer',async()=>{
 const calls=[];
 const page={
  goto:async()=>calls.push('navigate'),
  getByRole:()=>({count:async()=>0}),
  waitForFunction:async()=>calls.push('wait'),
  evaluate:async fn=>{
   if(fn.toString().includes('return response'))return {status:'OK'};
   calls.push('play');
  },
 };
 await recovery.openVideo(page,'srfE2nbzbrw');
 assert.deepEqual(calls,['navigate','wait','play','wait']);
});

test('authentication failure stops before playback and reports the recovery requirement',async()=>{
 let played=false;
 const page={goto:async()=>{},getByRole:()=>({count:async()=>0}),waitForFunction:async()=>{},
 evaluate:async fn=>{if(fn.toString().includes('return response'))return {status:'LOGIN_REQUIRED'};played=true;}};
 await assert.rejects(recovery.openVideo(page,'srfE2nbzbrw'),/QUOTE_SESSION_REQUIRED/);
 assert.equal(played,false);
});
