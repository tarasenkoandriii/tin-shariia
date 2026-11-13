'use client';

import {useState} from 'react';

export function GrokSettings({initialScore}:{initialScore:number}){
  const [score,setScore]=useState(String(initialScore)),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  return <section className="editorial-panel" aria-labelledby="grok-settings-title">
    <h2 id="grok-settings-title">Поріг автоприйняття сценарію</h2>
    <p>Grok автоматично допустить сценарій до відеогенерації, якщо оцінки новизни й інтересу обидві не нижчі за поріг і список фактичних ризиків порожній. В інших випадках рішення лишається редактору.</p>
    <form onSubmit={event=>{
      event.preventDefault();if(busy)return;setBusy(true);setMessage('');
      void fetch('/api/editorial/grok-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoAcceptScore:Number(score)})})
        .then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error?.code??'SAVE_FAILED');setMessage(`Збережено: ${body.data.autoAcceptScore}/100.`);})
        .catch(error=>setMessage(`Не вдалося зберегти (${error.message}).`)).finally(()=>setBusy(false));
    }}>
      <label>Мінімальна оцінка кожного критерію <input type="number" min={0} max={100} step={1} required value={score}
        onChange={event=>setScore(event.target.value)} /> / 100</label>
      <button disabled={busy}>{busy?'Зберігаємо…':'Зберегти поріг'}</button>
      {message&&<output role="status">{message}</output>}
    </form>
  </section>;
}
