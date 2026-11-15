import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {writeFile,access,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
const run=promisify(execFile);
const [videoId,start,end,output]=process.argv.slice(2);
if(!/^[\w-]{11}$/.test(videoId??'')||![start,end].every(v=>/^\d+(?:\.\d{1,3})?$/.test(v??''))||Number(end)<=Number(start)||Number(end)-Number(start)>30||!output)throw Error('QUOTE_INPUT_INVALID');
const target=resolve(output),job=randomUUID(),remote='/tmp/editorial-quote-'+job+'.webm',temporary=target+'.'+job+'.webm';
try{await access(target);throw Error('OUTPUT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
const ssh=async args=>run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','worker-vps',...args],{timeout:110000,maxBuffer:500000});
try{
 // A reader started from an older compose file has no capture script; say so instead of a generic failure.
 let present;
 try{present=(await ssh(['docker','exec','youtube-reader-youtube-reader-1','node','-p',`"require('fs').existsSync('/reader/capture-quote.cjs')"`])).stdout.trim();}
 catch{throw Error('QUOTE_READER_UNAVAILABLE');}
 if(present!=='true'){console.error('Reader container has no /reader/capture-quote.cjs. Update it: node scripts/deploy-youtube-reader.mjs (check), then --apply.');throw Error('QUOTE_READER_SCRIPT_MISSING');}
 const {stdout}=await ssh(['docker','exec','youtube-reader-youtube-reader-1','node','/reader/capture-quote.cjs',videoId,start,end,job]);
 const result=JSON.parse(stdout.trim());if(!result.ok||result.path!==remote)throw Error(result.error??'QUOTE_SOURCE_UNAVAILABLE');
 // Binary output bypasses terminal logs and remains a local private file.
 const {stdout:binary}=await run('ssh',['-o','BatchMode=yes','worker-vps','docker','exec','youtube-reader-youtube-reader-1','cat',remote],{timeout:60000,maxBuffer:25*1024*1024,encoding:'buffer'});
 await writeFile(temporary,binary,{flag:'wx'});
 await run('ffmpeg',['-v','error','-nostdin','-n','-i',temporary,'-t',String(Number(end)-Number(start)),'-c:v','libx264','-preset','fast','-crf','19','-c:a','aac','-movflags','+faststart',target],{timeout:60000});
 const {stdout:probe}=await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',target]);
 const media=JSON.parse(probe);if(!media.streams.some(s=>s.codec_type==='audio')||!media.streams.some(s=>s.codec_type==='video')||Math.abs(Number(media.format.duration)-(Number(end)-Number(start)))>0.6)throw Error('QUOTE_TECHNICAL_CHECK_FAILED');
 await writeFile(target+'.json',JSON.stringify({...result,path:undefined,source:'https://www.youtube.com/watch?v='+videoId,technical:media},null,2));
 console.log(target);
}catch(e){throw Error(/^QUOTE_|^OUTPUT_/.test(e.message)?e.message:'QUOTE_READER_FAILED');}
finally{await unlink(temporary).catch(()=>{});await ssh(['docker','exec','youtube-reader-youtube-reader-1','rm','-f',remote]).catch(()=>{});}
