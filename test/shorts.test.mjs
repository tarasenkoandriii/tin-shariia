import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {ffmpegMontage,shortsOutput,validateShortTechnicalReport} from '../src/media/montage-ffmpeg.mjs';
import {shortsRenderJob,validateShortsManifest} from '../src/media/shorts-manifest.mjs';
import {renderShortStamp} from '../src/media/shorts-stamp.mjs';

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
  assert.deepEqual(Object.keys(job.input_files),['src']);
  assert.equal(job.ffmpeg_commands.length,3);
  assert.match(job.ffmpeg_commands[0],/-ss 1\.000 -t 15\.000 -i \{\{src\}\}/);
  assert.match(job.ffmpeg_commands[0],/force_original_aspect_ratio=decrease,pad=1080:1920/);
  assert.match(job.ffmpeg_commands[1],/-ss 30\.000 -t 16\.000 -i \{\{src\}\}/);
  assert.match(job.ffmpeg_commands[2],/concat=n=2:v=1:a=1/);
  assert.match(job.ffmpeg_commands[0],/-pix_fmt yuv420p -c:a aac/);
  assert.doesNotMatch(job.ffmpeg_commands.join(' '),/trim=start=|atrim=start=|format=yuv420p|force_original_aspect_ratio=increase/);
});

test('rejects unsafe ranges, unsupported duration and source URLs',()=>{
  assert.throws(()=>validateShortsManifest({...manifest,clips:[{startMs:0,endMs:29_999}]},60_000),/SHORTS_DURATION_INVALID/);
  assert.throws(()=>validateShortsManifest({...manifest,clips:[{startMs:0,endMs:61_000}]},60_000),/SHORTS_INVALID_CLIP/);
  assert.throws(()=>validateShortsManifest({...manifest,clips:[{startMs:'0; -y',endMs:31_000}]},60_000),/SHORTS_INVALID_CLIP/);
  assert.throws(()=>shortsRenderJob('http://blob.example.test/video.mp4',manifest),/SHORTS_INVALID_SOURCE/);
});

test('validates SRT timeline, plain text and selected Shorts duration',()=>{
  const subtitles='1\n00:00:00,000 --> 00:00:02,000\nПеревірена цитата українською.\n\n'
    +'2\n00:00:28,000 --> 00:00:30,000\nКороткий висновок.';
  const plan=validateShortsManifest({...manifest,subtitles},60_000);
  assert.match(plan.subtitles,/00:00:28,000 --> 00:00:30,000/);
  assert.throws(()=>validateShortsManifest({...manifest,subtitles:subtitles.replace('00:00:30,000','00:00:32,000')},60_000),/SHORTS_INVALID_SUBTITLES/);
  assert.throws(()=>validateShortsManifest({...manifest,subtitles:subtitles.replace('Перевірена цитата українською.','{\\an8}unsafe')},60_000),/SHORTS_INVALID_SUBTITLES/);
});

test('adds a validated SRT as a separate input after assembling the selected timeline',()=>{
  const subtitles='1\n00:00:00,000 --> 00:00:03,000\nПеревірена цитата українською.';
  const captionsManifest={...manifest,clips:[{startMs:0,endMs:30_000}],subtitles};
  const job=shortsRenderJob('https://blob.example.test/source.mp4',captionsManifest,{captionsUrl:'https://blob.example.test/captions.srt?token=private'});
  assert.equal(job.input_files['captions.srt'],'https://blob.example.test/captions.srt?token=private');
  const command=job.ffmpeg_commands.at(-1);
  assert.match(command,/concat=n=1:v=1:a=1\[v\]\[a\];\[v\]subtitles=\{\{captions\.srt\}\}\[captioned\]/);
  assert.match(command,/ -map "\[captioned\]" -map "\[a\]"/);
  assert.throws(()=>shortsRenderJob('https://blob.example.test/source.mp4',captionsManifest,{captionsUrl:'http://blob.example.test/captions.srt'}),/SHORTS_INVALID_SUBTITLES/);
  assert.throws(()=>shortsRenderJob('https://blob.example.test/source.mp4',captionsManifest,{captionsUrl:'https://blob.example.test/captions.txt'}),/SHORTS_INVALID_SUBTITLES/);
  assert.throws(()=>shortsRenderJob('https://blob.example.test/source.mp4',{...captionsManifest,subtitles:undefined},{captionsUrl:'https://blob.example.test/captions.srt'}),/SHORTS_INVALID_SUBTITLES/);
});

test('renders the configured rectangular stamp as a transparent PNG overlay',async()=>{
  const bytes=await renderShortStamp({endingStamp:{enabled:true,shape:'rectangle',tiltDeg:-5,largeText:true,
    safeMarginPercent:12,text:'ВЕРДИКТ І СТАН ПЕРЕВІРКИ'}});
  const metadata=await sharp(bytes).metadata();
  assert.equal(metadata.format,'png');
  assert.equal(metadata.width,1200);
  assert.ok(metadata.height>300);
  assert.equal(metadata.hasAlpha,true);
  const job=shortsRenderJob('https://blob.example.test/private/master.mp4',manifest,{stampUrl:'https://blob.example.test/stamp.png',
    stampSpec:{endingStamp:{enabled:true,shape:'rectangle',tiltDeg:-5,largeText:true,safeMarginPercent:12}}});
  assert.equal(job.input_files.stamp,'https://blob.example.test/stamp.png');
  assert.ok(job.ffmpeg_commands.some(command=>command.includes('overlay=(W-w)/2:(H-h)/2')));
});

test('accepts only the declared result file on the configured FFmpeg origin',()=>{
  const id='11111111-2222-4333-8444-555555555555';
  assert.equal(shortsOutput({id,output_files:{'short.mp4':`https://ffmpeg.example.test/api/files/${id}/short.mp4`}},
    new URL('https://ffmpeg.example.test')).pathname,`/api/files/${id}/short.mp4`);
  assert.throws(()=>shortsOutput({id,output_files:{'short.mp4':`https://evil.example/api/files/${id}/short.mp4`}},
    new URL('https://ffmpeg.example.test')),/SHORTS_RENDER_INVALID/);
  // Failures carry a URL-free diagnostic so production logs say which check rejected the job.
  const origin=new URL('https://ffmpeg.example.test');
  const detailOf=job=>{try{shortsOutput(job,origin);}catch(error){return error.detail;}};
  assert.deepEqual(detailOf({id:'job_123',output_files:{}}),{check:'job_id_format',idLength:7});
  const uuid='3f2b7c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b';
  assert.deepEqual(detailOf({id:uuid,output_files:{'output.mp4':'https://ffmpeg.example.test/x'}}),{check:'output_url',outputKeys:['output.mp4']});
  assert.deepEqual(detailOf({id:uuid,output_files:{'short.mp4':'https://cdn.example.test/api/files/'+uuid+'/short.mp4'}}),
    {check:'output_origin',sameHost:false,protocol:'https:'});
  assert.deepEqual(detailOf({id:uuid,output_files:{'short.mp4':'https://ffmpeg.example.test/files/'+uuid+'/short.mp4'}}),
    {check:'output_path',endsWithShort:true});
  assert.equal(String(shortsOutput({id:uuid,output_files:{'short.mp4':'https://ffmpeg.example.test/api/files/'+uuid+'/short.mp4'}},origin)),
    'https://ffmpeg.example.test/api/files/'+uuid+'/short.mp4');
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

test('local FFmpeg pipeline render produces a playable 1080x1920 MP4 with audio and ending stamp',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tin-shorts-'));
  try{
    const source=join(directory,'source.mp4'),output=join(directory,'short.mp4');
    execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y',
      '-f','lavfi','-i','testsrc2=size=360x640:rate=24:duration=46',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=46',
      '-shortest','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',source],{timeout:120000});
    const stampPath=join(directory,'stamp.png');
    await writeFile(stampPath,await renderShortStamp({endingStamp:{enabled:true,shape:'rectangle',tiltDeg:-5,largeText:true,
      safeMarginPercent:12,text:'ВЕРДИКТ І СТАН ПЕРЕВІРКИ'}}));
    const job=shortsRenderJob('https://source.example.test/video.mp4',{
      hook:'Хук',title:'Заголовок',description:'Опис',clips:[{startMs:1000,endMs:16_000},{startMs:30_000,endMs:46_000}],
    },{stampUrl:'https://source.example.test/stamp.png',stampSpec:{endingStamp:{enabled:true,shape:'rectangle',tiltDeg:-5,
      largeText:true,safeMarginPercent:12}}});
    const paths=[join(directory,'clip-0.mp4'),join(directory,'clip-1.mp4'),join(directory,'clip-1-stamp.mp4')];
    for(const [index,command] of job.ffmpeg_commands.entries()){
      const resolved=command.replaceAll('{{src}}',source)
        .replaceAll('{{stamp}}',stampPath)
        .replaceAll('{{clip-0.mp4}}',paths[0]).replaceAll('{{clip-1.mp4}}',paths[1])
        .replaceAll('{{clip-1-stamp.mp4}}',paths[2])
        .replaceAll('{{short.mp4}}',output);
      execFileSync('sh',['-c',`ffmpeg -nostdin -hide_banner -loglevel error -y ${resolved}`],{cwd:directory,timeout:120000});
      await stat(index<3?paths[index]:output);
    }
    const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=width,height,codec_type',
      '-of','json',output],{encoding:'utf8'}));
    assert.ok(metadata.streams.some(stream=>stream.codec_type==='video'&&stream.width===1080&&stream.height===1920));
    assert.ok(metadata.streams.some(stream=>stream.codec_type==='audio'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('Shorts download accepts a response without Content-Length (chunked transfer)',async()=>{
  const id='11111111-2222-4333-8444-555555555555';
  const env={MONTAGE_FFMPEG_ORIGIN:'https://ffmpeg.example.test/',MONTAGE_FFMPEG_TOKEN:'token'};
  const job={id,output_files:{'short.mp4':`https://ffmpeg.example.test/api/files/${id}/short.mp4`}};
  const body=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(64,1)]);
  const original=globalThis.fetch;
  try{
    // A streamed body: Response sets no Content-Length header for a ReadableStream.
    globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(body.subarray(0,40));c.enqueue(body.subarray(40));c.close();}}),{status:200});
    const bytes=await ffmpegMontage(env).shortFile(job);
    assert.equal(bytes.length,body.length);
    assert.equal(bytes.toString('ascii',4,8),'ftyp');
    // A declared length that disagrees with the bytes received is still rejected.
    globalThis.fetch=async()=>new Response(body,{status:200,headers:{'content-length':String(body.length+5)}});
    await assert.rejects(ffmpegMontage(env).shortFile(job),error=>error.detail?.check==='size_mismatch'&&error.detail.length===body.length+5);
  }finally{globalThis.fetch=original;}
});
