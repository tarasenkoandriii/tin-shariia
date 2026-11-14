/* eslint-disable @typescript-eslint/no-require-imports -- VPS container intentionally uses CommonJS. */
// Runs only inside the private VPS reader container. No public listener.
const {chromium}=require('/app/node_modules/playwright-core');
const fs=require('node:fs/promises');
const [videoId,startRaw,endRaw,jobId]=process.argv.slice(2);
const start=Number(startRaw),end=Number(endRaw);
if(!/^[A-Za-z0-9_-]{11}$/.test(videoId??'')||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>30||end>14400||!/^[a-f0-9-]{36}$/.test(jobId??''))throw Error('QUOTE_INPUT_INVALID');
(async()=>{
 let browser;
 try{
  browser=await chromium.launch({headless:true,chromiumSandbox:true});
  const context=await browser.newContext({viewport:{width:1280,height:720}});
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   const allowed=['youtube.com','googlevideo.com','ytimg.com','google.com','gstatic.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d));
   if(u.protocol==='https:'&&(!u.port||u.port==='443')&&allowed)await route.continue();else await route.abort();
  });
  const session=JSON.parse(await fs.readFile('/profile/session.json','utf8'));
  await context.addCookies(session.cookies);
  const page=await context.newPage();
  await page.goto('https://www.youtube.com/watch?v='+videoId,{waitUntil:'domcontentloaded',timeout:40000});
  const rejectCookies=page.getByRole('button',{name:/^(Alle ablehnen|Reject all|Відхилити всі|Отклонить все)$/});
  if(await rejectCookies.count())await rejectCookies.first().click({timeout:5000}).catch(()=>{});
  await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=2&&v.duration>0;},{},{timeout:30000});
  const result=await page.evaluate(async({start,end})=>{
   const v=document.querySelector('video');if(v.duration<end)throw Error('QUOTE_OUT_OF_RANGE');
   v.pause();v.playbackRate=1;v.muted=false;v.volume=1;
   v.currentTime=start;
   await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('SEEK_TIMEOUT')),15000);v.addEventListener('seeked',()=>{clearTimeout(timeout);resolve();},{once:true});});
   const stream=v.captureStream();
   if(!stream.getAudioTracks().length||!stream.getVideoTracks().length)throw Error('QUOTE_TRACKS_MISSING');
   const mime=['video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
   if(!mime)throw Error('QUOTE_CODEC_UNAVAILABLE');
   const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:2500000,audioBitsPerSecond:128000});
   const chunks=[];let bytes=0;
   return await new Promise((resolve,reject)=>{
    let watch,timer;
    const cleanup=()=>{clearInterval(watch);clearTimeout(timer);v.pause();};
    recorder.ondataavailable=e=>{bytes+=e.data.size;if(bytes>24*1024*1024){recorder.stop();cleanup();reject(Error('QUOTE_TOO_LARGE'));}else if(e.data.size)chunks.push(e.data);};
    recorder.onerror=()=>{cleanup();reject(Error('QUOTE_RECORD_FAILED'));};
    recorder.onstop=async()=>{cleanup();const blob=new Blob(chunks,{type:mime});const buffer=new Uint8Array(await blob.arrayBuffer());let text='';for(let i=0;i<buffer.length;i+=16384)text+=String.fromCharCode(...buffer.subarray(i,i+16384));resolve({data:btoa(text),mime,start,end,lastTime:v.currentTime});};
    recorder.start(250);
    v.play().catch(()=>{cleanup();reject(Error('QUOTE_PLAY_FAILED'));});
    watch=setInterval(()=>{if(v.currentTime>=end&&recorder.state==='recording')recorder.stop();},30);
    timer=setTimeout(()=>{cleanup();if(recorder.state==='recording')recorder.stop();reject(Error('QUOTE_PLAY_TIMEOUT'));},(end-start)*1000+25000);
   });
  },{start,end});
  if(Math.abs(result.lastTime-end)>0.5)throw Error('QUOTE_DURATION_MISMATCH');
  const path='/tmp/editorial-quote-'+jobId+'.webm';
  const bytes=Buffer.from(result.data,'base64');if(bytes.length<10000)throw Error('QUOTE_EMPTY');
  await fs.writeFile(path,bytes,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({ok:true,path,bytes:bytes.length,videoId,start,end,method:'browser-original-stream',playbackRate:1}));
 }catch(error){console.log(JSON.stringify({ok:false,error:/^QUOTE_[A-Z_]+$/.test(error.message)?error.message:'QUOTE_SOURCE_UNAVAILABLE'}));process.exitCode=1;}
 finally{await browser?.close();}
})();
