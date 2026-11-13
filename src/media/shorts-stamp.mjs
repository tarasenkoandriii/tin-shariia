import sharp from 'sharp';

const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replaceAll('"','&quot;').replaceAll("'",'&apos;');

function wrap(text,maxChars){
  const words=String(text).trim().split(/\s+/).filter(Boolean),lines=[];
  let line='';
  for(const word of words){
    const pieces=word.match(new RegExp(`.{1,${maxChars}}`,'gu'))??[];
    for(const piece of pieces){
      if(line&&`${line} ${piece}`.length>maxChars){lines.push(line);line=piece;}
      else line=line?`${line} ${piece}`:piece;
    }
  }
  if(line)lines.push(line);
  return lines.slice(0,8);
}

export async function renderShortStamp(spec){
  const stamp=spec?.endingStamp;
  if(!stamp||stamp.enabled!==true||stamp.shape!=='rectangle'||!Number.isFinite(stamp.tiltDeg)
    ||Math.abs(stamp.tiltDeg)>15||typeof stamp.text!=='string'||!stamp.text.trim()
    ||stamp.text.length>160||typeof stamp.largeText!=='boolean')throw Error('SHORTS_INVALID_STAMP');
  const fontSize=stamp.largeText?64:48,lineHeight=Math.round(fontSize*1.2),lines=wrap(stamp.text,stamp.largeText?28:38);
  if(!lines.length)throw Error('SHORTS_INVALID_STAMP');
  const rectHeight=Math.max(190,lines.length*lineHeight+54),height=rectHeight+140,centerY=height/2;
  const firstY=centerY-((lines.length-1)*lineHeight)/2+fontSize*0.34;
  const tspans=lines.map((line,index)=>`<tspan x="600" y="${(firstY+index*lineHeight).toFixed(1)}">${xml(line)}</tspan>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}">
    <g transform="rotate(${stamp.tiltDeg} 600 ${centerY})">
      <rect x="34" y="${(centerY-rectHeight/2).toFixed(1)}" width="1132" height="${rectHeight}" rx="18" fill="#10212b" fill-opacity="0.97" stroke="#52dcc2" stroke-width="12"/>
      <rect x="52" y="${(centerY-rectHeight/2+18).toFixed(1)}" width="1096" height="${rectHeight-36}" rx="11" fill="none" stroke="#f3f6f8" stroke-opacity="0.88" stroke-width="3"/>
      <text text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="800" fill="#ffffff">${tspans}</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg),{density:72,limitInputPixels:2_000_000}).png().toBuffer();
}
