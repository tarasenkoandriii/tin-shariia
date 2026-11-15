import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {verifyCaseEvidence} from '../src/automation/verified-case.mjs';
import {assertContinuousAudio} from '../src/media/audio-timeline.mjs';
const run=promisify(execFile),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const token=process.env.EDITORIAL_WORKER_TOKEN??process.env.YOUTUBE_READER_TOKEN;
if(!token)throw Error('CYCLE_WORKER_TOKEN_REQUIRED');
const origin=process.env.EDITORIAL_ORIGIN??'https://tin-shariia.viral4creators.app';
if(new URL(origin).protocol!=='https:')throw Error('CYCLE_SOURCE_INVALID');
const base=resolve(process.env.EDITORIAL_WORKER_DIRECTORY??join(root,'.editorial-worker'));
const ytdlp=process.env.YTDLP_PATH??'yt-dlp';
const exists=p=>access(p).then(()=>true,()=>false);
const invoke=async(cmd,args,timeout=600000)=>{try{return await run(cmd,args,{timeout,maxBuffer:300000,env:process.env});}catch(error){
 const code=/(?:Error|error): ([A-Z][A-Z0-9_]{2,80})/.exec(error.stderr??'')?.[1];
 const http=/HTTP Error: (\d{3})/.exec(error.stderr??'')?.[1];
 throw Error(code??(http?'CYCLE_SOURCE_HTTP_'+http:'CYCLE_MEDIA_TOOL_FAILED'));
}};
async function request(input){const r=await fetch(origin+'/api/internal/editorial-worker',{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),
 headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)});if(!r.ok)throw Error('CYCLE_WORKER_HTTP_'+r.status);return r.json();}
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function render(task,dir){
 const input=task.input;
 if(!/^[\w-]{11}$/.test(input.videoId)||!Number.isFinite(input.startMs)||input.endMs<=input.startMs||input.endMs-input.startMs>30000)throw Error('CYCLE_QUOTE_INVALID');
 const narration=input.narration;
 if(narration?.provider!=='soniox'||narration.model!=='tts-rt-v2'||narration.voice!=='Maya'||narration.language!=='uk'||narration.speed!==1.15)throw Error('EDITORIAL_VOICE_LOCKED');
 const audio=Buffer.from(narration.base64,'base64');
 if(createHash('sha256').update(audio).digest('hex')!==narration.sha256)throw Error('NARRATION_CHECKSUM_MISMATCH');
 await writeFile(join(dir,'maya.mp3'),audio,{mode:0o600});
 const source=join(dir,'source.mp4');
 if(!await exists(source))await invoke(ytdlp,['--no-playlist','--download-sections',`*${input.startMs/1000}-${input.endMs/1000}`,
  '-f','bv*[height<=720]+ba/b[height<=720]','--merge-output-format','mp4','--force-keyframes-at-cuts','--write-info-json',
  '--js-runtimes','node:'+process.execPath,'-o',source,'https://www.youtube.com/watch?v='+input.videoId]);
 const meta=JSON.parse(await readFile(join(dir,'source.info.json')));
 if(meta.id!==input.videoId||meta.channel_id!==input.channelId)throw Error('CYCLE_SOURCE_INVALID');
 const quote=join(dir,'quote.mp4');
 if(!await exists(quote)) {
  const lines=[];for(const word of String(input.quoteCaption??'').split(/\s+/)){const last=lines.at(-1);if(last&&last.length+word.length<39)lines[lines.length-1]+=' '+word;else lines.push(word);}
  const captions=lines.slice(0,5).map((l,i)=>`<text x="360" y="${970+i*43}" text-anchor="middle" fill="#fff" font-family="Arial" font-size="30">${xml(l)}</text>`).join('');
  const banner=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect x="32" y="95" width="656" height="128" rx="22" fill="#102633"/><text x="360" y="147" text-anchor="middle" fill="#77e0cf" font-family="Arial" font-weight="bold" font-size="36">${xml(String(meta.channel??meta.uploader??'Джерело').slice(0,24)+' · відеоцитата')}</text><text x="360" y="196" text-anchor="middle" fill="#fff" font-family="Arial" font-size="27">${xml(input.quoteLabel??'Оригінальний звук · швидкість 1×')}</text><rect x="25" y="915" width="670" height="300" rx="24" fill="#102633" fill-opacity="0.9"/>${captions}</svg>`);
  const overlay=join(dir,'quote-overlay.png');await sharp(banner).png().toFile(overlay);
  await invoke('ffmpeg',['-v','error','-nostdin','-n','-i',source,'-i',overlay,'-filter_complex',
   '[0:v]split=2[b][f];[b]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=25[bg];[f]scale=720:-2[fg];[bg][fg]overlay=0:(H-h)/2[base];[base][1:v]overlay=0:0,setsar=1,fps=30[v]',
   '-map','[v]','-map','0:a:0','-c:v','libx264','-preset','fast','-crf','19','-c:a','aac','-ar','48000','-ac','2','-b:a','192k','-movflags','+faststart',quote]);
 }
 const assetDir=join(dir,'assets');await mkdir(assetDir,{recursive:true});
 const poolFile=join(assetDir,'candidates.json');
 if(!await exists(poolFile)) {
  const queries=join(dir,'queries.json');await writeFile(queries,JSON.stringify(input.visualQueries));
  await invoke(process.execPath,[join(root,'scripts/find-editorial-visuals.mjs'),queries,assetDir],900000);
 }
 const photos=JSON.parse(await readFile(poolFile));
 const assets=photos.map(p=>({...p,path:'assets/'+p.path,tags:[...p.tags,'verdict']}));
 for(const [i,card] of (input.manifest.documentCards??[]).entries()) {
  const p='document-'+i+'.png';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="760"><rect width="1000" height="760" rx="25" fill="#f5f1e6"/><rect x="35" y="30" width="930" height="700" rx="15" fill="none" stroke="#ddad46" stroke-width="5"/><text x="70" y="115" font-family="Arial" font-size="38" font-weight="bold" fill="#102633">${xml(card.title)}</text>${card.lines.map((l,n)=>`<text x="70" y="${210+n*66}" font-family="Arial" font-size="30" fill="#163345">${xml(l)}</text>`).join('')}<text x="70" y="700" font-family="Arial" font-size="23" fill="#496471">${xml(card.credit)}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(assetDir,p));
  assets.push({path:'assets/'+p,kind:'document',tags:card.tags,credit:card.credit,sourceUrl:card.sourceUrl});
 }
 const manifest={sourceLabel:input.manifest.sourceLabel,visualEffect:input.manifest.visualEffect,quote:{path:'quote.mp4'},
  narration:{...narration,path:'maya.mp3',base64:undefined},assets,scenes:input.manifest.scenes};
 const manifestPath=join(dir,'montage.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2));
 const authored=join(dir,'authored.mp4');
 if(!await exists(authored))await invoke(process.execPath,[join(root,'scripts/render-editorial.mjs'),manifestPath,authored],900000);
 const final=join(dir,'short.mp4');
 if(!await exists(final))await invoke('ffmpeg',['-v','error','-nostdin','-n','-i',authored,'-vf','scale=1080:1920,setsar=1','-c:v','libx264','-preset','fast','-crf','19','-c:a','aac','-ar','48000','-ac','2','-b:a','192k','-movflags','+faststart',final]);
 await assertContinuousAudio(final);
 const bytes=await readFile(final),mediaHash=createHash('sha256').update(bytes).digest('hex');
 const prepared=await request({action:'prepare-upload',id:task.id,lease:task.lease,bytes:bytes.length});
 if(!prepared.alreadyUploaded){const r=await fetch(prepared.uploadUrl,{method:'PUT',headers:{'Content-Type':'video/mp4'},body:bytes,signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('CYCLE_BLOB_UPLOAD_FAILED');}
 return {mediaHash,audioContinuous:true,report:JSON.parse(await readFile(authored+'.json'))};
}
async function youtubeAudio(task,dir){
 const baseline=join(dir,'baseline.mp4'),youtube=join(dir,'youtube.webm');
 if(!await exists(baseline)){const r=await fetch(task.input.baselineUrl,{signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error('CYCLE_BASELINE_UNAVAILABLE');await writeFile(baseline,Buffer.from(await r.arrayBuffer()));}
 if(createHash('sha256').update(await readFile(baseline)).digest('hex')!==task.input.mediaHash)throw Error('CYCLE_MEDIA_INVALID');
 if(!await exists(youtube))await invoke(ytdlp,['--no-playlist','-f','bestaudio','--js-runtimes','node:'+process.execPath,'-o',youtube,'https://www.youtube.com/watch?v='+task.input.youtubeId]);
 const pcm=async(file,name)=>{const out=join(dir,name);await invoke('ffmpeg',['-v','error','-nostdin','-y','-i',file,'-vn','-ac','1','-ar','8000','-f','s16le',out]);const b=await readFile(out);return Array.from({length:Math.floor(b.length/16)},(_,i)=>b.readInt16LE(i*16));};
 const x=await pcm(baseline,'baseline.pcm'),y=await pcm(youtube,'youtube.pcm');
 const corr=(a,b)=>{let aa=0,bb=0,ab=0;for(let i=0;i<Math.min(a.length,b.length);i++){aa+=a[i]*a[i];bb+=b[i]*b[i];ab+=a[i]*b[i];}return aa&&bb?ab/Math.sqrt(aa*bb):0;};
 let best=-1,lag=0;
 for(let shift=-150;shift<=150;shift++){const start=200,score=corr(x.slice(start,start+4000),y.slice(start+shift,start+shift+4000));if(score>best){best=score;lag=shift;}}
 const durationDeltaMs=y.length-x.length;
 // Ignore up to half a second of quiet padding after the aligned original.
 const tailStart=x.length+lag;
 const quietPadding=durationDeltaMs>250&&durationDeltaMs<=500&&tailStart>=0&&tailStart<y.length
  &&y.slice(tailStart).every(sample=>Math.abs(sample)<=184); // −45 dBFS
 if(Math.abs(durationDeltaMs)>250&&!quietPadding)throw Error('CYCLE_YOUTUBE_AUDIO_FAILED');
 const starts=[200,Math.floor(x.length/2),x.length-4000],correlations=starts.map(start=>corr(x.slice(start,start+3000),y.slice(start+lag,start+lag+3000)));
 if(correlations.some(c=>c<0.9))throw Error('CYCLE_YOUTUBE_AUDIO_FAILED');
 const result={audioVerified:true,correlations,alignmentMs:lag,durationDeltaMs,quietPadding};await writeFile(join(dir,'verification.json'),JSON.stringify(result,null,2));return result;
}
await mkdir(base,{recursive:true,mode:0o700});
for(;;){
 const task=await request({action:'claim'});
 if(task){
  const dir=join(base,task.cycle_id,task.kind);await mkdir(dir,{recursive:true,mode:0o700});
  console.info('EDITORIAL_CYCLE_WORKER',{cycleId:task.cycle_id,task:task.kind,state:'running'});
  try{const result=await (task.kind==='evidence'?verifyCaseEvidence(task.input.seed).then(evidence=>({evidence})):task.kind==='render'?render(task,dir):youtubeAudio(task,dir));await request({action:'finish',id:task.id,lease:task.lease,...result});console.info('EDITORIAL_CYCLE_WORKER',{cycleId:task.cycle_id,task:task.kind,state:'done'});}
  catch(error){const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message??'')?error.message:'CYCLE_WORKER_FAILED';await request({action:'finish',id:task.id,lease:task.lease,errorCode:code});console.warn('EDITORIAL_CYCLE_WORKER',{cycleId:task.cycle_id,task:task.kind,state:'failed',code});}
 }
 if(process.argv.includes('--once'))break;
 await new Promise(r=>setTimeout(r,5000));
}
