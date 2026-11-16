import sharp from 'sharp';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
const run=promisify(execFile);
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export async function burnQuoteSubtitles(input,output,cues,dir){
 if(!Array.isArray(cues)||!cues.length)throw Error('QUOTE_UK_SUBTITLES_REQUIRED');
 let last=0;
 for(const c of cues){
  if(!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<last||c.end<=c.start||!Array.isArray(c.lines)||c.lines.length>2||!c.lines.length)throw Error('QUOTE_SUBTITLES_INVALID');
  last=c.end;
 }
 const args=['-v','error','-nostdin','-n','-i',input];
 for(let i=0;i<cues.length;i++){
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="720" height="160"><rect x="30" y="0" width="660" height="160" rx="14" fill="#081822" fill-opacity="0.96"/>'+cues[i].lines.map((l,j)=>'<text x="360" y="'+(cues[i].lines.length===1?98:66+j*44)+'" text-anchor="middle" font-family="Arial" font-size="29" fill="white">'+xml(l)+'</text>').join('')+'</svg>';
  const path=join(dir,'uk-subtitle-'+i+'.png');await sharp(Buffer.from(svg)).png().toFile(path);args.push('-i',path);
 }
 const filters=cues.map((c,i)=>(i?'[v'+(i-1)+']':'[0:v]')+'['+(i+1)+':v]overlay=0:850:enable=\'gte(t,'+c.start+')*lt(t,'+c.end+')\'[v'+i+']').join(';');
 await run('ffmpeg',[...args,'-filter_complex',filters,'-map','[v'+(cues.length-1)+']','-map','0:a','-c:v','libx264','-preset','fast','-crf','19','-c:a','copy','-movflags','+faststart',output],{timeout:180000,maxBuffer:1000000});
}
