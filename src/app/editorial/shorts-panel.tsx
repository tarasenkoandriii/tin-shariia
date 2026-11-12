'use client';

import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {Episode} from './workflow-types';
import {VideoAuditPanel} from './video-audit-panel';

type Short={id:string;media_revision_id:string;episode_version:number;manifest:{hook:string;title:string;description:string;clips:{startMs:number;endMs:number}[]};
  state:string;expected_bytes:number|null;sha256:string|null;error_code:string|null;expires_at:string;created_at:string;
  technical_report:{durationMs:number;width:number;height:number;videoCodec:string;audioCodec:string;integratedLufs:number;truePeakDbtp:number;silence:{startMs:number;endMs:number}[]}|null;
  audit_media_revision_id:string|null;youtube_upload_id:string|null;youtube_upload_state:string|null;youtube_video_id:string|null;
  youtube_privacy_status:string|null;youtube_processing_status:string|null;youtube_actual_privacy_status:string|null;youtube_error_code:string|null;
  youtube_upload_offset:number|null;youtube_total_bytes:number|null};
type Source={id:string;episode_version:number;state:string};
const labels:Record<string,string>={queued:'У черзі',rendering:'Збирається FFmpeg',technical_check:'FFmpeg перевіряє готовий файл',ready:'Чернетка пройшла технічну перевірку',failed:'Помилка складання або технічної перевірки',expired:'Термін зберігання минув'};
const seconds=(milliseconds:number)=>(milliseconds/1000).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');

async function request<T>(url:string,method='GET',body?:object):Promise<T>{
  const response=await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const json=await response.json();
  if(!response.ok) throw Error(json.error?.code??'REQUEST_FAILED');
  return json.data;
}

export function ShortsPanel({episode,sources,items,canCreate,canReview,canPublish}:{episode:Episode;sources:Source[];items:Short[];canCreate:boolean;canReview:boolean;canPublish:boolean}){
  const router=useRouter();
  const formRef=useRef<HTMLFormElement>(null);
  const [busy,setBusy]=useState(false);
  const [suggesting,setSuggesting]=useState(false);
  const [message,setMessage]=useState('');
  const [suggestion,setSuggestion]=useState('');
  const base=`/api/episodes/${episode.id}/shorts`;
  const active=items.some(item=>['queued','rendering','technical_check'].includes(item.state)
    ||['queued','uploading','processing','unknown'].includes(item.youtube_upload_state??''));
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>router.refresh(),5000);return()=>clearInterval(timer);},[active,router]);
  async function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;
    const form=new FormData(event.currentTarget);
    const clips=String(form.get('clips')??'').split(',').map(part=>{
      const [start,end]=part.split('-').map(Number);
      return {startMs:Math.round(start*1000),endMs:Math.round(end*1000)};
    });
    setBusy(true);setMessage('');
    try{
      const created=await request<{id:string}>(base,'POST',{mediaId:form.get('mediaId'),manifest:{
        hook:form.get('hook'),title:form.get('title'),description:form.get('description'),clips,
      }});
      await request(`${base}/${created.id}`);router.refresh();
    }catch(error){setMessage((error as Error).message==='SHORTS_DURATION_INVALID'?'Загальна тривалість вибраних фрагментів має бути 30–60 секунд.':'Не вдалося створити Shorts. Перевірте фрагменти й стан джерела.');}
    finally{setBusy(false);}
  }
  async function suggest(){
    const form=formRef.current;
    if(!form||suggesting)return;
    const mediaId=String(new FormData(form).get('mediaId')??'');
    if(!mediaId)return;
    setSuggesting(true);setMessage('');setSuggestion('');
    try{
      const result=await request<{manifest:{hook:string;title:string;description:string;clips:{startMs:number;endMs:number}[]};
        reasons:string[];spentMicros:number}>(base,'POST',{action:'suggest',mediaId,requestId:crypto.randomUUID()});
      (form.elements.namedItem('hook') as HTMLInputElement).value=result.manifest.hook;
      (form.elements.namedItem('title') as HTMLInputElement).value=result.manifest.title;
      (form.elements.namedItem('description') as HTMLTextAreaElement).value=result.manifest.description;
      (form.elements.namedItem('clips') as HTMLInputElement).value=result.manifest.clips
        .map(clip=>`${seconds(clip.startMs)}-${seconds(clip.endMs)}`).join(', ');
      setSuggestion(`Gemini запропонував план (${(result.spentMicros/1_000_000).toFixed(4)} $). Перегляньте й відредагуйте його перед складанням.`);
    }catch{setMessage('Gemini не повернув перевірену пропозицію. Спробуйте пізніше або відредагуйте фрагменти вручну.');}
    finally{setSuggesting(false);}
  }
  async function publish(event:React.FormEvent<HTMLFormElement>,item:Short){
    event.preventDefault();if(busy)return;
    const form=new FormData(event.currentTarget);setBusy(true);setMessage('');
    try{
      await request(`/api/episodes/${episode.id}/shorts/${item.id}/youtube-upload`,'POST',{
        title:form.get('title'),description:form.get('description'),privacyStatus:form.get('privacyStatus'),
        idempotencyKey:crypto.randomUUID(),reviewedSha256:item.sha256,confirmed:form.has('confirmed'),
      });
      router.refresh();
    }catch(error){
      const code=(error as Error).message;
      setMessage(code==='YOUTUBE_OAUTH_NOT_CONFIGURED'||code==='YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED'
        ?'OAuth YouTube ще не налаштований у Production.'
        :code==='YOUTUBE_CHANNEL_NOT_CONNECTED'?'Спершу підключіть YouTube-канал у головному розділі редакції.'
        :code==='YOUTUBE_RELEASE_APPROVAL_REQUIRED'?'Точний Shorts-файл ще не пройшов повний аудит і допуск редактора.'
        :'Не вдалося створити завантаження. Перевірте підключення каналу та допуск цього файлу.');
    }finally{setBusy(false);}
  }
  const uploadLabels:Record<string,string>={queued:'YouTube: у черзі',uploading:'YouTube: завантаження можна продовжити',
    processing:'YouTube обробляє відео',published:'YouTube: завантаження й видимість підтверджені',
    failed:'YouTube відхилив завантаження або перевірку',unknown:'YouTube: перевіряємо результат без повторного завантаження'};
  return <section>
    <h5>Shorts · вертикальний чернетковий монтаж</h5>
    <p>Виберіть перевірену медіаревізію. Укажіть фрагменти в секундах через кому, наприклад 12-28, 54-72. Сумарно — 30–60 секунд.</p>
    {canCreate&&<>
    <button type="button" disabled={suggesting||busy} onClick={()=>void suggest()}>
      {suggesting?'Gemini аналізує сценарій…':'Запропонувати монтаж через Gemini'}
    </button>
    <form ref={formRef} onSubmit={submit}>
      <label>Відео-джерело <select name="mediaId" required defaultValue="">
        <option value="" disabled>Оберіть перевірений файл</option>
        {sources.filter(item=>item.state==='passed'&&item.episode_version===episode.version).map(item=>
          <option key={item.id} value={item.id}>Медіаревізія · {item.id.slice(0,8)}</option>)}
      </select></label>
      <label>Фрагменти, с <input name="clips" required defaultValue="0-35" placeholder="12-28, 54-72" /></label>
      <label>Початкова фраза <input name="hook" required maxLength={160} /></label>
      <label>Заголовок <input name="title" required maxLength={100} /></label>
      <label>Опис <textarea name="description" required maxLength={2000} /></label>
      <button disabled={busy||!sources.some(item=>item.state==='passed'&&item.episode_version===episode.version)}>
        {busy?'Передаємо в чергу…':'Зібрати вертикальний MP4'}
      </button>
    </form>
    </>}
    {suggestion&&<p role="status">{suggestion}</p>}
    {message&&<p role="status">{message}</p>}
    {items.length>0&&<ol>{items.map(item=><li key={item.id}>
      <strong>{labels[item.state]??item.state}</strong> · {item.manifest.title} · {Math.round(item.manifest.clips.reduce((n,c)=>n+c.endMs-c.startMs,0)/1000)} с
      {item.error_code&&<p>Код помилки: {item.error_code}</p>}
      {item.state==='ready'&&<>
        <p><a href={`${base}/${item.id}/download`} target="_blank" rel="noreferrer">Відкрити приватний MP4</a></p>
        {item.technical_report&&<details><summary>Повна технічна перевірка FFmpeg</summary>
          <p>{item.technical_report.width}×{item.technical_report.height} · {item.technical_report.durationMs/1000} с · {item.technical_report.videoCodec}/{item.technical_report.audioCodec}</p>
          <p>{item.technical_report.integratedLufs} LUFS · {item.technical_report.truePeakDbtp} dBTP</p>
          {item.technical_report.silence.length>0?<ul>{item.technical_report.silence.map(part=><li key={part.startMs}>Тиша {part.startMs/1000}–{part.endMs/1000} с</li>)}</ul>:<p>Тривалих тихих ділянок FFmpeg не виявив.</p>}
        </details>}
        {item.audit_media_revision_id&&<VideoAuditPanel short endpoint={`/api/episodes/${episode.id}/montages/${item.audit_media_revision_id}/audits`}
          canRun={canCreate} canReview={canReview} />}
        {item.youtube_upload_state&&<div className="workflow-card">
          <p><strong>{uploadLabels[item.youtube_upload_state]??item.youtube_upload_state}</strong>
            {item.youtube_actual_privacy_status&&<> · видимість: {item.youtube_actual_privacy_status}</>}
            {item.youtube_processing_status&&<> · статус: {item.youtube_processing_status}</>}</p>
          {item.youtube_video_id&&<p><a href={`https://www.youtube.com/shorts/${item.youtube_video_id}`} target="_blank" rel="noreferrer">Відкрити Short на YouTube</a></p>}
          {item.youtube_upload_state==='unknown'&&<p>Нова копія не створюється: система спочатку звіряє стан resumable-сесії.</p>}
          {item.youtube_error_code&&<p>Код стану: {item.youtube_error_code}</p>}
        </div>}
        {canPublish&&item.audit_media_revision_id&&item.sha256&&!item.youtube_upload_id&&<details>
          <summary>Завантажити допущений Shorts на YouTube</summary>
          <form onSubmit={event=>void publish(event,item)}>
            <label>Заголовок <input name="title" maxLength={100} required defaultValue={item.manifest.title} /></label>
            <label>Опис <textarea name="description" maxLength={5000} defaultValue={item.manifest.description} /></label>
            <label>Видимість <select name="privacyStatus" required defaultValue="private">
              <option value="private">Приватне</option><option value="unlisted">За посиланням</option><option value="public">Публічне</option>
            </select></label>
            <p>Завантажиться саме перевірений файл із SHA-256 <code>{item.sha256}</code>. Зміна ролика потребує нового аудиту.</p>
            <label><input type="checkbox" name="confirmed" required /> Підтверджую цей файл, текст і вибрану видимість.</label>
            <button disabled={busy}>{busy?'Передаємо завдання…':'Підтвердити й завантажити'}</button>
          </form>
        </details>}
      </>}
      {item.sha256&&<p>SHA-256: <code>{item.sha256}</code></p>}
    </li>)}</ol>}
  </section>;
}
