import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {shortsOutput,validateShortTechnicalReport} from '../src/media/montage-ffmpeg.mjs';
import {shortsRenderJob,validateShortsManifest} from '../src/media/shorts-manifest.mjs';

const manifest={hook:'Короткий хук',title:'Перевірка',description:'Короткий опис',clips:[
  {startMs:1000,endMs:16000},{startMs:30000,endMs:46000},
]};

test('builds a validated 9:16 FFmpeg composition from selected ranges',()=>{
  const plan=validateShortsManifest(manifest,60_000);
  assert.equal(plan.durationMs,31_000);
  assert.equal(plan.width,1080);
  assert.equal(plan.height,1920);
  const job=shortsRenderJob('https://blob.example.test/private/master.mp4',manifest);
  assert.deepEqual(job.output_files,['short.mp4']);
  assert.match(job.ffmpeg_commands[0],/split=2/);
  assert.match(job.ffmpeg_commands[0],/scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.match(job.ffmpeg_commands[0],/concat=n=2:v=1:a=1/);
  assert.match(job.ffmpeg_commands[0],/-c:v libx264 .* -c:a aac/);
});

test('rejects unsafe ranges, unsupported duration and source URLs',()=>{
  assert.throws(()=>validateShortsManifest({...manifest,clips:[{startMs:0,endMs:29_999}]},60_000),/SHORTS_DURATION_INVALID/);
  assert.throws(()=>validateShortsManifest({...manifest,clips:[{startMs:0,endMs:61_000}]},60_000),/SHORTS_INVALID_CLIP/);
  assert.throws(()=>validateShortsManifest({...manifest,clips:[{startMs:'0; -y',endMs:31_000}]},60_000),/SHORTS_INVALID_CLIP/);
  assert.throws(()=>shortsRenderJob('http://blob.example.test/video.mp4',manifest),/SHORTS_INVALID_SOURCE/);
});

test('accepts only the declared result file on the configured FFmpeg origin',()=>{
  const id='11111111-2222-4333-8444-555555555555';
  assert.equal(shortsOutput({id,output_files:{'short.mp4':`https://ffmpeg.example.test/api/files/${id}/short.mp4`}},
    new URL('https://ffmpeg.example.test')).pathname,`/api/files/${id}/short.mp4`);
  assert.throws(()=>shortsOutput({id,output_files:{'short.mp4':`https://evil.example/api/files/${id}/short.mp4`}},
    new URL('https://ffmpeg.example.test')),/SHORTS_RENDER_INVALID/);
});

test('Shorts technical release requires the exact complete 9:16 audio-video render',()=>{
  const id='11111111-2222-4333-8444-555555555555';
  const sha256='a'.repeat(64);
  const text='frame:0 pts:0 pts_time:0.1\nlavfi.r128.I=-21.4\nlavfi.r128.true_peak=0.100\n'
    +'frame:9 pts:9 pts_time:1\nframe:929 pts:929 pts_time:31\nlavfi.r128.I=-22.6\nlavfi.r128.true_peak=0.200\n';
  const streams=[{type:'video',width:1080,height:1920,codec:'h264'},{type:'audio',codec:'aac',durationSec:31}];
  const job={id,status:'succeeded',ffmpeg_version:'5.1',inputs_metadata:[{
    key:'src',bytes:600,sha256,durationSec:31,format:'mov,mp4,m4a,3gp,3g2,mj2',streams,
  }]};
  const report=validateShortTechnicalReport(job,text,600,sha256);
  assert.equal(report.width,1080);
  assert.equal(report.height,1920);
  assert.equal(report.durationMs,31000);
  assert.throws(()=>validateShortTechnicalReport(job,text,600,'b'.repeat(64)),/SHORTS_TECH_CHECK_REJECTED/);
  assert.throws(()=>validateShortTechnicalReport({...job,inputs_metadata:[{...job.inputs_metadata[0],
    streams:[{...streams[0],width:1920,height:1080},streams[1]],}]},text,600,sha256),/SHORTS_TECH_CHECK_REJECTED/);
});

test('local FFmpeg smoke render produces a playable 1080x1920 MP4 with audio',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tin-shorts-'));
  try{
    const source=join(directory,'source.mp4'),output=join(directory,'short.mp4');
    execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y',
      '-f','lavfi','-i','testsrc2=size=360x640:rate=24:duration=31',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=31',
      '-shortest','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',source],{timeout:120000});
    const job=shortsRenderJob('https://source.example.test/video.mp4',{
      hook:'Хук',title:'Заголовок',description:'Опис',clips:[{startMs:0,endMs:30_500}],
    });
    const graph=/-filter_complex "([^"]+)"/.exec(job.ffmpeg_commands[0])?.[1];
    assert.ok(graph);
    execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y','-i',source,
      '-filter_complex',graph,'-map','[v]','-map','[a]','-t','60','-c:v','libx264','-preset','veryfast','-crf','23',
      '-c:a','aac','-b:a','160k','-movflags','+faststart',output],{timeout:120000});
    const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=width,height,codec_type',
      '-of','json',output],{encoding:'utf8'}));
    assert.ok(metadata.streams.some(stream=>stream.codec_type==='video'&&stream.width===1080&&stream.height===1920));
    assert.ok(metadata.streams.some(stream=>stream.codec_type==='audio'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
