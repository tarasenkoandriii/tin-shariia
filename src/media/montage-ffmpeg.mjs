import {createAudioAuditJob} from './ffmpeg-audio-job.mjs';
import {shortsRenderJob} from './shorts-manifest.mjs';

const maxReport=4*1024*1024;
export function montageJob(url){
  const body=createAudioAuditJob(url);
  body.ffmpeg_commands[0]='-xerror '+body.ffmpeg_commands[0].replace('-map "[audit]"','-map 0:v:0 -map "[audit]"');
  return body;
}

export function montageReport(job,text,expectedBytes){
  const input=job.inputs_metadata?.find(item=>item.key==='src');
  if(!input||input.bytes!==expectedBytes||!/^([a-f0-9]{64})$/.test(input.sha256??'')||
    !input.format?.split(',').includes('mp4')) throw Error('MONTAGE_INVALID_MEDIA');
  const video=input.streams?.find(stream=>stream.type==='video'&&stream.width>0&&stream.height>0);
  const audio=input.streams?.find(stream=>stream.type==='audio');
  const durationMs=Math.round(Number(input.durationSec)*1000);
  if(!video||!audio||!Number.isSafeInteger(durationMs)||durationMs<100||durationMs>600500) throw Error('MONTAGE_INVALID_MEDIA');

  let integratedLufs=null,linearPeak=0,clock=0,start=null;
  const silence=[];
  for(const line of text.split('\n')){
    const frame=/^frame:\s*\d+.*\bpts_time:([\d.]+)/.exec(line);
    if(frame) clock=Number(frame[1]);
    const [name,value]=line.split('=');
    const n=Number(value);
    if(!Number.isFinite(n)) continue;
    if(name==='lavfi.r128.I') integratedLufs=n;
    if(name==='lavfi.r128.true_peak') linearPeak=Math.max(linearPeak,n);
    if(name==='lavfi.silence_start') start=n;
    if(name==='lavfi.silence_end'&&start!==null) {
      silence.push({startMs:Math.max(0,Math.round(start*1000)),endMs:Math.min(durationMs,Math.round(n*1000))});
      start=null;
    }
  }
  if(integratedLufs===null||!Number.isFinite(clock)) throw Error('MONTAGE_REPORT_INVALID');
  const audioDurationMs=Math.round((Number(audio.durationSec)||clock+0.1)*1000);
  if(audioDurationMs<durationMs-Math.max(500,durationMs*0.02)
      ||clock*1000+300<audioDurationMs) throw Error('MONTAGE_AUDIO_INCOMPLETE');
  if(start!==null) silence.push({startMs:Math.max(0,Math.round(start*1000)),endMs:Math.min(durationMs,audioDurationMs)});
  if(linearPeak<=0) throw Error('MONTAGE_AUDIO_SILENT');
  return {sha256:input.sha256,report:{
    durationMs,audioDurationMs,width:video.width,height:video.height,videoCodec:video.codec,audioCodec:audio.codec,
    integratedLufs,truePeakDbtp:Number((20*Math.log10(linearPeak)).toFixed(2)),
    silence:silence.filter(item=>item.endMs>item.startMs),silenceThresholdDb:-45,minimumSilenceMs:500,
    ffmpegVersion:job.ffmpeg_version??null,
  }};
}

export function shortsOutput(job,origin){
  if(!job?.id||!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(job.id)) throw Error('SHORTS_RENDER_INVALID');
  let url;
  try{url=new URL(job.output_files?.['short.mp4']);}catch{throw Error('SHORTS_RENDER_INVALID');}
  if(url.origin!==origin.origin||url.pathname!==`/api/files/${job.id}/short.mp4`||url.search||url.hash)
    throw Error('SHORTS_RENDER_INVALID');
  return url;
}

export function ffmpegMontage(env=process.env){
  const origin=new URL(env.MONTAGE_FFMPEG_ORIGIN);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!env.MONTAGE_FFMPEG_TOKEN) {
    throw Error('MONTAGE_DISABLED');
  }
  const authorization='Bearer '+env.MONTAGE_FFMPEG_TOKEN;
  async function request(path,init={}){
    const response=await fetch(new URL(path,origin),{
      ...init,headers:{Authorization:authorization,...init.headers},redirect:'error',signal:AbortSignal.timeout(15000),
    });
    if(response.status===404&&init.method!=='POST') return null;
    if(!response.ok){
      if([400,401,403,422].includes(response.status)) throw Error('MONTAGE_FFMPEG_REJECTED');
      throw Error('MONTAGE_FFMPEG_UNAVAILABLE');
    }
    return (await response.json()).data;
  }
  return {
    lookup:key=>request('/api/jobs/by-key/'+encodeURIComponent(key)),
    job:id=>request('/api/jobs/'+encodeURIComponent(id)),
    submit:(key,source)=>request('/api/ffmpeg',{
      method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},
      body:JSON.stringify(montageJob(source)),
    }),
    submitShorts:(key,source,manifest)=>request('/api/ffmpeg',{
      method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},
      body:JSON.stringify(shortsRenderJob(source,manifest)),
    }),
    async shortFile(job){
      const url=shortsOutput(job,origin);
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});
      if(!response.ok) throw Error('SHORTS_RENDER_UNAVAILABLE');
      const length=Number(response.headers.get('content-length'));
      if(Number.isFinite(length)&&length>128*1024*1024) throw Error('SHORTS_RENDER_INVALID');
      const reader=response.body?.getReader();
      if(!reader) throw Error('SHORTS_RENDER_INVALID');
      const chunks=[];let size=0;
      try{
        for(;;){
          const {value,done}=await reader.read();if(done)break;
          size+=value.byteLength;
          if(size>128*1024*1024){await reader.cancel();throw Error('SHORTS_RENDER_INVALID');}
          chunks.push(value);
        }
      }finally{reader.releaseLock();}
      if(size<16||(Number.isFinite(length)&&length!==size)) throw Error('SHORTS_RENDER_INVALID');
      return Buffer.concat(chunks,size);
    },
    async report(job){
      const url=new URL(job.output_files?.['audit.txt']);
      if(url.origin!==origin.origin||url.pathname!=='/api/files/'+job.id+'/audit.txt') throw Error('MONTAGE_REPORT_INVALID');
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok) throw Error('MONTAGE_FFMPEG_UNAVAILABLE');
      if(Number(response.headers.get('content-length'))>maxReport) throw Error('MONTAGE_REPORT_INVALID');
      const reader=response.body.getReader(),chunks=[];
      let size=0;
      try{
        for(;;){
          const {value,done}=await reader.read();
          if(done) break;
          size+=value.byteLength;
          if(size>maxReport){await reader.cancel();throw Error('MONTAGE_REPORT_INVALID');}
          chunks.push(value);
        }
      }finally{reader.releaseLock();}
      return Buffer.concat(chunks,size).toString('utf8');
    },
  };
}

export function ffmpegShorts(env=process.env){
  const montage=ffmpegMontage(env);
  return {
    lookup:montage.lookup,job:montage.job,shortFile:montage.shortFile,
    submit:(key,source,manifest)=>montage.submitShorts(key,source,manifest),
  };
}
