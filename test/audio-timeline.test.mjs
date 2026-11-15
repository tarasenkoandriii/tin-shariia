import assert from 'node:assert/strict';
import test from 'node:test';
import {audioTimeline} from '../src/media/audio-timeline.mjs';
const frame=(time)=>({best_effort_timestamp_time:String(time),nb_samples:1024});
test('continuous AAC frames pass with rounding tolerance',()=>{
 const result=audioTimeline([frame(0),frame(.021333),frame(.042667)],48000);
 assert.equal(result.gaps.length,0);
});
test('capture clock holes are detected even when packet duration hides them',()=>{
 const result=audioTimeline([frame(0),frame(.021333),frame(.102667)],48000);
 assert.equal(result.gaps.length,1);
 assert.ok(Math.abs(result.emptySeconds-.06)<.00001);
 assert.equal(result.samples,3072);
});
test('overlapping clocks and missing audio cannot silently export',()=>{
 assert.equal(audioTimeline([frame(0),frame(.001)],48000).overlaps.length,1);
 assert.throws(()=>audioTimeline([],48000),/INVALID/);
});
