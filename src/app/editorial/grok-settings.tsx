'use client';

import {useState} from 'react';

type GrokMode='direct'|'batch';

export function GrokSettings({initialScore,initialMode}:{initialScore:number;initialMode:GrokMode}){
  const [score,setScore]=useState(String(initialScore)),[mode,setMode]=useState<GrokMode>(initialMode);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  return <section className="editorial-panel" aria-labelledby="grok-settings-title">
    <h2 id="grok-settings-title">Перевірка сценарію Grok</h2>
    <p>Grok автоматично допустить сценарій до відеогенерації, якщо оцінки новизни й інтересу обидві не нижчі за поріг і список фактичних ризиків порожній. В інших випадках рішення лишається редактору.</p>
    <form onSubmit={event=>{
      event.preventDefault();if(busy)return;setBusy(true);setMessage('');
      void fetch('/api/editorial/grok-settings',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({autoAcceptScore:Number(score),grokMode:mode})})
        .then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error?.code??'SAVE_FAILED');
          setMode(body.data.grokMode);
          setMessage(`Збережено: ${body.data.autoAcceptScore}/100 · ${body.data.grokMode==='batch'?'Batch API':'прямий виклик'}.`);})
        .catch(error=>setMessage(`Не вдалося зберегти (${error.message}).`)).finally(()=>setBusy(false));
    }}>
      <label>Мінімальна оцінка кожного критерію <input type="number" min={0} max={100} step={1} required value={score}
        onChange={event=>setScore(event.target.value)} /> / 100</label>
      <fieldset>
        <legend>Спосіб виклику Grok</legend>
        <label><input type="radio" name="grokMode" value="direct" checked={mode==='direct'} onChange={()=>setMode('direct')} />
          {' '}Прямий виклик — результат за хвилину після запуску (типово)</label>
        <label><input type="radio" name="grokMode" value="batch" checked={mode==='batch'} onChange={()=>setMode('batch')} />
          {' '}Batch API — дешевше, але результат може прийти через години</label>
        <p>Новий спосіб діє для наступних запусків; уже надіслані проходи завершуються тим способом, яким їх запущено.</p>
      </fieldset>
      <button disabled={busy}>{busy?'Зберігаємо…':'Зберегти налаштування'}</button>
      {message&&<output role="status">{message}</output>}
    </form>
  </section>;
}
