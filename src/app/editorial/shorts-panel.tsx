'use client';

import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {Episode} from './workflow-types';

type Short={id:string;media_revision_id:string;episode_version:number;manifest:{hook:string;title:string;description:string;clips:{startMs:number;endMs:number}[]};
  state:string;expected_bytes:number|null;sha256:string|null;error_code:string|null;expires_at:string;created_at:string};
type Source={id:string;episode_version:number;state:string};
const labels:Record<string,string>={queued:'У черзі',rendering:'Збирається FFmpeg',ready:'Чернетка Shorts готова',failed:'Помилка складання',expired:'Термін зберігання минув'};
const seconds=(milliseconds:number)=>(milliseconds/1000).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');

async function request<T>(url:string,method='GET',body?:object):Promise<T>{
  const response=await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const json=await response.json();
  if(!response.ok) throw Error(json.error?.code??'REQUEST_FAILED');
  return json.data;
}

export function ShortsPanel({episode,sources,items,canCreate}:{episode:Episode;sources:Source[];items:Short[];canCreate:boolean}){
  const router=useRouter();
  const formRef=useRef<HTMLFormElement>(null);
  const [busy,setBusy]=useState(false);
  const [suggesting,setSuggesting]=useState(false);
  const [message,setMessage]=useState('');
  const [suggestion,setSuggestion]=useState('');
  const base=`/api/episodes/${episode.id}/shorts`;
  const active=items.some(item=>['queued','rendering'].includes(item.state));
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
      {item.state==='ready'&&<p><a href={`${base}/${item.id}/download`} target="_blank" rel="noreferrer">Відкрити приватний MP4</a></p>}
      {item.sha256&&<p>SHA-256: <code>{item.sha256}</code></p>}
    </li>)}</ol>}
  </section>;
}
