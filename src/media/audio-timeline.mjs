import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

export function audioTimeline(frames, sampleRate) {
  if(!Number.isFinite(sampleRate)||sampleRate<=0||!frames.length)throw Error('AUDIO_TIMELINE_INVALID');
  let samples=0;
  const gaps=[], overlaps=[];
  for(let index=0;index<frames.length;index++){
    const frame=frames[index], count=Number(frame.nb_samples);
    if(!Number.isFinite(count)||count<=0)throw Error('AUDIO_TIMELINE_INVALID');
    samples+=count;
    if(index+1<frames.length){
      const end=Number(frame.best_effort_timestamp_time)+count/sampleRate;
      const next=Number(frames[index+1].best_effort_timestamp_time);
      if(!Number.isFinite(end)||!Number.isFinite(next))throw Error('AUDIO_TIMELINE_INVALID');
      if(next<end-0.005)overlaps.push({start:next,duration:end-next});
      if(next>end+0.003)gaps.push({start:end,duration:next-end});
    }
  }
  return {sampleRate,samples,decodedSeconds:samples/sampleRate,gaps,overlaps,
    emptySeconds:gaps.reduce((sum,gap)=>sum+gap.duration,0)};
}

export async function inspectAudioTimeline(path) {
  const {stdout}=await run('ffprobe',['-v','error','-select_streams','a:0','-show_streams','-show_frames',
    '-show_entries','stream=sample_rate:frame=best_effort_timestamp_time,nb_samples','-of','json',path],
  {maxBuffer:20*1024*1024,timeout:60000});
  const data=JSON.parse(stdout);
  return audioTimeline(data.frames??[],Number(data.streams?.[0]?.sample_rate));
}

export async function assertContinuousAudio(path) {
  const result=await inspectAudioTimeline(path);
  if(result.overlaps.length)throw Error('AUDIO_TIMELINE_OVERLAP');
  if(result.emptySeconds>0.05||result.gaps.some(gap=>gap.duration>0.02))throw Error('AUDIO_TIMELINE_GAPS');
  return result;
}

// Preserve the decoded source samples. Remove empty capture-clock intervals from the picture clock.
export async function repairCapturedQuote(input,output) {
  const timeline=await inspectAudioTimeline(input);
  if(timeline.emptySeconds<=0.05&&!timeline.overlaps.length)return {path:input,repaired:false,...timeline};
  const terms=[...timeline.gaps.map(gap=>({...gap,sign:1})),...timeline.overlaps.map(gap=>({...gap,sign:-1}))].map(gap=>
    gap.sign+'*min(max(PTS*TB-'+gap.start.toFixed(9)+',0),'+gap.duration.toFixed(9)+')').join('+');
  const filters="[0:v]setpts='(PTS*TB-("+terms+"))/TB',fps=30,tpad=stop_mode=clone:stop_duration=0.1[v];"
    +"[0:a]asetpts=N/SR/TB,aresample=48000[a]";
  await run('ffmpeg',['-v','error','-nostdin','-n','-i',input,'-filter_complex',filters,
    '-map','[v]','-map','[a]','-t',String(timeline.decodedSeconds),'-c:v','libx264','-preset','fast','-crf','18',
    '-c:a','aac','-profile:a','aac_low','-ar','48000','-ac','2','-b:a','192k','-movflags','+faststart',output],
  {timeout:180000,maxBuffer:1000000});
  await assertContinuousAudio(output);
  return {path:output,repaired:true,...timeline};
}
