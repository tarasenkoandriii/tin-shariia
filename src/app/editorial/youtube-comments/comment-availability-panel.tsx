'use client';
import {useState} from 'react';
type Result={channelId:string;checkedAt:string;canComment:boolean|null;httpStatus:number;reason:string|null};
export function CommentAvailabilityPanel(){
 const [video,setVideo]=useState(''),[result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function check(){
  setBusy(true);setResult(null);setError('');
  try{
   let id=video.trim();
   if(id.includes('://')){const u=new URL(id);id=u.hostname==='youtu.be'?u.pathname.slice(1):u.searchParams.get('v')??u.pathname.split('/').at(-1)??'';}
   const r=await fetch('/api/youtube/comment-availability?videoId='+encodeURIComponent(id),{cache:'no-store'}),body=await r.json();
   if(!r.ok)throw Error(body.error?.code??'CHECK_FAILED');setResult(body.data);
  }catch(e){setError(e instanceof Error?e.message:'CHECK_FAILED');}finally{setBusy(false);}
 }
 return <section><h2>Чи відкриті коментарі?</h2>
 <label>Посилання або ID відео <input value={video} onChange={e=>setVideo(e.target.value)}/></label>
 <button disabled={busy||!video.trim()} onClick={check}>{busy?'Перевіряємо…':'Перевірити через YouTube API'}</button>
 {error&&<p role="alert">{error}</p>}
 {result&&<div role="status"><p>{result.canComment===true?'Список коментарів доступний':result.canComment===false?'Коментарі вимкнено':'Доступність не підтверджена'}</p>
 <p>HTTP {result.httpStatus} · {result.reason??'OK'}</p><p>Канал {result.channelId} · {new Date(result.checkedAt).toLocaleString('uk-UA')}</p>
 <p>Перевірка читання коментарів. Фільтрацію нового коментаря YouTube визначає після відправлення.</p></div>}
 </section>;
}
