'use client';

import {useState} from 'react';
import Link from 'next/link';

type Connection={channel_id:string;channel_title:string;connected_at:string};

export function YouTubeConnectionPanel({connection,result,configured}:{connection:Connection|null;result?:string;configured:boolean}){
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  async function disconnect(){
    if(busy)return;
    setBusy(true);setMessage('');
    try{
      const response=await fetch('/api/youtube/connection',{method:'DELETE'});
      if(!response.ok)throw Error();
      window.location.reload();
    }catch{setMessage('Не вдалося відкликати доступ YouTube. Підключення лишилося активним.');}
    finally{setBusy(false);}
  }
  const resultText:Record<string,string>={connected:'YouTube-канал підключено.',connect_failed:'Не вдалося підключити YouTube. Перевірте згоду й налаштування OAuth.',
    comment_scope_required:'Google не надав дозвіл на коментарі. Перевірте конфігурацію OAuth і повторіть підключення.',
    not_configured:'OAuth-ключі YouTube ще не налаштовані.',forbidden:'Підключати канал може лише учасник із роллю публікатора.'};
  return <section>
    <h2>YouTube Studio</h2>
    {connection?<>
      <p>Підключений канал: <strong>{connection.channel_title}</strong> · ID <code>{connection.channel_id}</code></p>
      <button type="button" disabled={busy} onClick={()=>void disconnect()}>{busy?'Відкликаємо доступ…':'Від’єднати канал'}</button>
    </>:configured?<>
      <p>Канал не підключено. Спочатку завершіть налаштування Google OAuth у Production.</p>
      <Link href="/api/youtube/oauth/start">Підключити YouTube-канал</Link>
    </>:<p>YouTube-завантаження ще не налаштовані адміністратором.</p>}
    {result&&resultText[result]&&<p role="status">{resultText[result]}</p>}
    {message&&<p role="alert">{message}</p>}
  </section>;
}
