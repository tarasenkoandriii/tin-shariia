'use client';

import {useEffect,useState} from 'react';
import {VideoAuditPanel} from './video-audit-panel';
import {useRouter} from 'next/navigation';
import type {Episode} from './workflow-types';

type Report={
  durationMs:number; audioDurationMs:number; width:number; height:number; videoCodec:string; audioCodec:string;
  integratedLufs:number; truePeakDbtp:number; silence:{startMs:number;endMs:number}[];
};
export type Montage={
  id:string; episode_id:string; episode_version:number; ordinal:number; state:string; owned:boolean;
  expected_bytes:number; expires_at:string; sha256:string|null; report:Report|null; error_code:string|null;
};
const states:Record<string,string>={
  uploading:'Очікує підтвердження завантаження',queued:'У черзі',checking:'Перевіряється',
  passed:'Технічну перевірку пройдено',failed:'Перевірку не пройдено',expired:'Термін зберігання минув',
};
const errors:Record<string,string>={
  MONTAGE_DISABLED:'Монтажні завантаження ще не налаштовано.',
  MONTAGE_STORAGE_LIMIT:'Ліміт сховища вичерпано.',
  MONTAGE_SIZE_INVALID:'Дозволено MP4 до 128 МіБ.',
  MONTAGE_UPLOAD_PENDING:'Для цього сценарію вже зарезервовано завантаження.',
  MONTAGE_UPLOAD_EXPIRED:'Дозвіл на завантаження вже сплив.',
  MONTAGE_OBJECT_MISSING:'Файл ще не надійшов у сховище.',
  MONTAGE_OBJECT_MISMATCH:'Розмір або тип файлу не відповідає завантаженню.',
  MONTAGE_DECODE_FAILED:'FFmpeg не зміг декодувати відео та аудіо або файл перевищив технічні межі.',
  MONTAGE_AUDIO_INCOMPLETE:'Аудіодоріжка не покриває тривалість відео.',
  MONTAGE_AUDIO_SILENT:'Аудіодоріжка повністю тиха.',
  MONTAGE_INVALID_MEDIA:'Очікується коректний MP4 з відео та аудіо.',
  MONTAGE_CHECK_TIMEOUT:'Сервіс не завершив перевірку вчасно.',
  CLAIM_STALE:'Потрібно погодити актуальну версію твердження.',
  APPROVAL_REQUIRED:'Потрібен погоджений сценарій.',
};

async function post<T>(path:string,body?:object):Promise<T>{
  const response=await fetch(path,{method:'POST',...(body?{
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  }:{})});
  const json=await response.json();
  if(!response.ok) throw Error(json.error?.code);
  return json.data;
}

export function MontagePanel({episode,items,canUpload}:{episode:Episode;items:Montage[];canUpload:boolean}){
  const router=useRouter();
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const base='/api/episodes/'+episode.id+'/montages';
  const active=items.some(item=>item.state==='queued'||item.state==='checking');
  useEffect(()=>{
    if(!active) return;
    const timer=setInterval(()=>router.refresh(),6000);
    return ()=>clearInterval(timer);
  },[active,router]);

  async function operate(operation:()=>Promise<unknown>){
    if(busy) return;
    setBusy(true);
    setMessage('');
    try{await operation();router.refresh();}
    catch(error){setMessage(errors[(error as Error).message]??'Не вдалося завершити дію. Перевірте файл і повторіть.');router.refresh();}
    finally{setBusy(false);}
  }

  return <section>
    <h5>Монтажні версії MP4</h5>
    {canUpload&&<form onSubmit={event=>{
      event.preventDefault();
      const form=event.currentTarget;
      const file=new FormData(form).get('video');
      if(!(file instanceof File)||!file.name.toLowerCase().endsWith('.mp4')) {setMessage(errors.MONTAGE_SIZE_INVALID);return;}
      void operate(async()=>{
        const ticket=await post<{id:string;uploadUrl:string}>(base,{version:episode.version,bytes:file.size});
        const upload=await fetch(ticket.uploadUrl,{method:'PUT',body:file,headers:{'Content-Type':'video/mp4'},credentials:'omit'});
        if(!upload.ok&&upload.status!==409&&upload.status!==412) throw Error('MONTAGE_UPLOAD_FAILED');
        await post(base+'/'+ticket.id+'/confirm');
        form.reset();
      });
    }}>
      <label>Монтажний MP4 до 128 МіБ <input type="file" name="video" accept="video/mp4,.mp4" required /></label>
      <button disabled={busy}>{busy?'Виконується…':'Завантажити та перевірити'}</button>
    </form>}
    {message&&<output role="status">{message}</output>}
    {items.length>0&&<ol>{items.map(item=><li key={item.id}>
      <strong>Монтаж {item.ordinal}</strong> · сценарій {item.episode_version} · {states[item.state]}
      {item.episode_version!==episode.version&&' · попередній сценарій'}
      {item.error_code&&<p>{errors[item.error_code]??'Технічний сервіс не повернув перевірений результат.'}</p>}
      {item.state==='uploading'&&item.owned&&canUpload&&
        <button disabled={busy} onClick={()=>void operate(()=>post(base+'/'+item.id+'/confirm'))}>Підтвердити отримання MP4</button>}
      {!['uploading','expired'].includes(item.state)&&<p><a href={base+'/'+item.id+'/download'} target="_blank" rel="noreferrer">Відкрити приватний MP4</a></p>}
      {item.report&&<details><summary>Технічний звіт</summary>
        <p>{item.report.width}×{item.report.height} · {item.report.durationMs/1000} с · {item.report.videoCodec} / {item.report.audioCodec}</p>
        {Math.abs(item.report.width/item.report.height-16/9)>0.02&&<p>Пропорції відрізняються від основного формату 16:9.</p>}
        <p>{item.report.integratedLufs} LUFS · {item.report.truePeakDbtp} dBTP</p>
        {item.report.silence.length>0?<ul>{item.report.silence.map(silence=><li key={silence.startMs}>
          Тиша {silence.startMs/1000}–{silence.endMs/1000} с
        </li>)}</ul>:<p>Пауз понад 0,5 с нижче −45 дБ не виявлено.</p>}
        {item.sha256&&<p>SHA-256 <code>{item.sha256}</code></p>}
      </details>}
      {item.sha256&&<VideoAuditPanel endpoint={base+'/'+item.id+'/audits'}
        canRun={canUpload&&item.state==='passed'&&item.episode_version===episode.version} />}
    </li>)}</ol>}
  </section>;
}
