const MAX_CLIPS=8;
const MIN_SHORT_MS=30_000;
const MAX_SHORT_MS=60_000;

const cleanText=(value,max)=>{
  if(typeof value!=='string') throw Error('SHORTS_INVALID_INPUT');
  const result=value.trim();
  if(!result||result.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw Error('SHORTS_INVALID_INPUT');
  return result;
};

const parseSrtTime=value=>{
  const match=/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
  if(!match)return null;
  const [,hours,minutes,seconds,milliseconds]=match.map(Number);
  if(minutes>59||seconds>59)return null;
  return ((hours*60+minutes)*60+seconds)*1000+milliseconds;
};

function validateSubtitleSrt(value,durationMs){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>20_000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw Error('SHORTS_INVALID_SUBTITLES');
  const blocks=value.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim().split(/\n\s*\n/);
  if(blocks.length>300)throw Error('SHORTS_INVALID_SUBTITLES');
  let previousEnd=0;
  const cues=blocks.map((block,index)=>{
    const lines=block.split('\n');
    if(lines.length<3||lines[0].trim()!==String(index+1))throw Error('SHORTS_INVALID_SUBTITLES');
    const timing=/^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/.exec(lines[1].trim());
    if(!timing)throw Error('SHORTS_INVALID_SUBTITLES');
    const startMs=parseSrtTime(timing[1]),endMs=parseSrtTime(timing[2]);
    const text=lines.slice(2).map(line=>line.trim()).join('\n');
    if(startMs===null||endMs===null||startMs<previousEnd||endMs<=startMs||endMs>durationMs
      ||!text||text.length>240||lines.length>5||text.split('\n').some(line=>!line||line.length>90)
      ||/[{}<>\\]/.test(text))throw Error('SHORTS_INVALID_SUBTITLES');
    previousEnd=endMs;
    return `${index+1}\n${timing[1]} --> ${timing[2]}\n${text}`;
  });
  return cues.join('\n\n')+'\n';
}

export function validateShortsManifest(value,sourceDurationMs){
  if(!Number.isSafeInteger(sourceDurationMs)||sourceDurationMs<MIN_SHORT_MS||sourceDurationMs>600_000
    ||!value||!Array.isArray(value.clips)||value.clips.length<1||value.clips.length>MAX_CLIPS) throw Error('SHORTS_INVALID_INPUT');
  const clips=value.clips.map(item=>{
    const {startMs,endMs}=item??{};
    if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||startMs<0||endMs<=startMs||endMs>sourceDurationMs)
      throw Error('SHORTS_INVALID_CLIP');
    return {startMs,endMs};
  });
  for(let index=1;index<clips.length;index++){
    if(clips[index].startMs<clips[index-1].endMs) throw Error('SHORTS_INVALID_CLIP');
  }
  const durationMs=clips.reduce((sum,clip)=>sum+clip.endMs-clip.startMs,0);
  if(durationMs<MIN_SHORT_MS||durationMs>MAX_SHORT_MS) throw Error('SHORTS_DURATION_INVALID');
  const subtitles=validateSubtitleSrt(value.subtitles,durationMs);
  return {schema:1,format:'9:16',width:1080,height:1920,fps:30,durationMs,
    hook:cleanText(value.hook,160),title:cleanText(value.title,100),description:cleanText(value.description,2000),clips,
    ...(subtitles?{subtitles}:{})};
}

const sec=ms=>(ms/1000).toFixed(3);

export function shortsRenderJob(sourceUrl,manifest,{stampUrl=null,stampSpec=null,captionsUrl=null}={}){
  let source;
  try{source=new URL(sourceUrl);}catch{throw Error('SHORTS_INVALID_SOURCE');}
  if(source.protocol!=='https:'||source.username||source.password||source.hash) throw Error('SHORTS_INVALID_SOURCE');
  let stamp=null;
  if(stampUrl){
    try{stamp=new URL(stampUrl);}catch{throw Error('SHORTS_INVALID_STAMP');}
    if(stamp.protocol!=='https:'||stamp.username||stamp.password||stamp.hash) throw Error('SHORTS_INVALID_STAMP');
    const value=stampSpec?.endingStamp;
    if(!value||value.enabled!==true||value.shape!=='rectangle'||!Number.isFinite(value.tiltDeg)
      ||Math.abs(value.tiltDeg)>15||!Number.isInteger(value.safeMarginPercent)
      ||value.safeMarginPercent<8||value.safeMarginPercent>25) throw Error('SHORTS_INVALID_STAMP');
  }
  const plan=validateShortsManifest(manifest,600_000);
  let captions=null;
  if(captionsUrl){
    try{captions=new URL(captionsUrl);}catch{throw Error('SHORTS_INVALID_SUBTITLES');}
    if(captions.protocol!=='https:'||captions.username||captions.password||captions.hash||!captions.pathname.endsWith('.srt'))
      throw Error('SHORTS_INVALID_SUBTITLES');
  }
  if(Boolean(plan.subtitles)!==Boolean(captions))throw Error('SHORTS_INVALID_SUBTITLES');
  const inputFiles={src:source.href,...(stamp?{stamp:stamp.href}:{}),...(captions?{'captions.srt':captions.href}:{})};
  const commands=[],segments=[];
  const renderSegment=({startMs,durationMs,output,withStamp=false})=>{
    const duration=sec(durationMs);
    // Use one downloaded source for the whole pipeline. Per-clip commands
    // seek the shared input and write bounded intermediates; the final
    // command joins them. A signed PNG overlay is used only on the ending
    // segment, so the configured stamp never obscures the clip body.
    const base='scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30';
    const stampWidth=stamp?Math.round(1080*(1-2*stampSpec.endingStamp.safeMarginPercent/100)):0;
    const graph=withStamp
      ?`[0:v]${base}[base];[1:v]scale=${stampWidth}:-2[badge];[base][badge]overlay=(W-w)/2:(H-h)/2[outv]`
      :null;
    commands.push(`-ss ${sec(startMs)} -t ${duration} -i {{src}} ${withStamp?'-i {{stamp}} ':''}`
      +(withStamp?`-filter_complex "${graph}" -map "[outv]" `:`-vf "${base}" -map 0:v:0 `)
      +'-map 0:a:0 -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p '
      +'-c:a aac -b:a 160k -movflags +faststart '
      +`{{${output}}}`);
    segments.push(output);
  };
  for(const [i,clip] of plan.clips.entries()){
    const durationMs=clip.endMs-clip.startMs;
    const ending=i===plan.clips.length-1&&Boolean(stamp);
    if(!ending){renderSegment({startMs:clip.startMs,durationMs,output:`clip-${i}.mp4`});continue;}
    const stampDurationMs=Math.min(2000,durationMs),prefixDurationMs=durationMs-stampDurationMs;
    if(prefixDurationMs>0) renderSegment({startMs:clip.startMs,durationMs:prefixDurationMs,output:`clip-${i}.mp4`});
    renderSegment({startMs:clip.endMs-stampDurationMs,durationMs:stampDurationMs,output:`clip-${i}-stamp.mp4`,withStamp:true});
  }
  const inputs=segments.map(name=>`-i {{${name}}}`).join(' ');
  const graph=`${segments.map((_,i)=>`[${i}:v:0][${i}:a:0]`).join('')}concat=n=${segments.length}:v=1:a=1[v][a]`;
  const finalGraph=captions?`${graph};[v]subtitles={{captions.srt}}[captioned]`:graph;
  commands.push(`${inputs} -filter_complex "${finalGraph}" -map "${captions?'[captioned]':'[v]'}" -map "[a]" `
    +'-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 160k '
    +'-movflags +faststart {{short.mp4}}');
  return {input_files:inputFiles,output_files:['short.mp4'],ffmpeg_commands:commands.map(command=>`-xerror ${command}`)};
}
