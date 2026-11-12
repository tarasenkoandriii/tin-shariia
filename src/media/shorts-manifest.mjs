const MAX_CLIPS=8;
const MIN_SHORT_MS=30_000;
const MAX_SHORT_MS=60_000;

const cleanText=(value,max)=>{
  if(typeof value!=='string') throw Error('SHORTS_INVALID_INPUT');
  const result=value.trim();
  if(!result||result.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw Error('SHORTS_INVALID_INPUT');
  return result;
};

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
  return {schema:1,format:'9:16',width:1080,height:1920,fps:30,durationMs,
    hook:cleanText(value.hook,160),title:cleanText(value.title,100),description:cleanText(value.description,2000),clips};
}

const sec=ms=>(ms/1000).toFixed(3);

export function shortsRenderJob(sourceUrl,manifest){
  let source;
  try{source=new URL(sourceUrl);}catch{throw Error('SHORTS_INVALID_SOURCE');}
  if(source.protocol!=='https:'||source.username||source.password||source.hash) throw Error('SHORTS_INVALID_SOURCE');
  const plan=validateShortsManifest(manifest,600_000);
  const filters=plan.clips.length>1?[
    `[0:v]split=${plan.clips.length}${plan.clips.map((_,i)=>`[vsrc${i}]`).join('')}`,
    `[0:a]asplit=${plan.clips.length}${plan.clips.map((_,i)=>`[asrc${i}]`).join('')}`,
  ]:[];
  for(const [i,clip] of plan.clips.entries()){
    const video=plan.clips.length>1?`[vsrc${i}]`:'[0:v]';
    const audio=plan.clips.length>1?`[asrc${i}]`:'[0:a]';
    filters.push(`${video}trim=start=${sec(clip.startMs)}:end=${sec(clip.endMs)},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v${i}]`);
    filters.push(`${audio}atrim=start=${sec(clip.startMs)}:end=${sec(clip.endMs)},asetpts=PTS-STARTPTS[a${i}]`);
  }
  filters.push(`${plan.clips.map((_,i)=>`[v${i}][a${i}]`).join('')}concat=n=${plan.clips.length}:v=1:a=1[v][a]`);
  return {input_files:{src:source.href},output_files:['short.mp4'],ffmpeg_commands:[
    `-xerror -i {{src}} -filter_complex "${filters.join(';')}" -map "[v]" -map "[a]" -t 60 -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 160k -movflags +faststart {{short.mp4}}`,
  ]};
}
