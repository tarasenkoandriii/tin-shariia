'use client';
import {useEffect,useState} from 'react';
export type CycleRow={id:string;state:string;stage_index:number;release_state:string|null;youtube_id:string|null;promotion_state:string|null;code:string|null;events:unknown;scenario?:{episodeId:string};grok?:{originalityScore:number;interestScore:number}};
export function CyclePanel({initialRows}:{initialRows:CycleRow[]}){
 const [seed,setSeed]=useState(''),[status,setStatus]=useState(''),[rows,setRows]=useState<CycleRow[]>(initialRows);
 const refresh=async()=>{const r=await fetch('/api/editorial/cycles');const b=await r.json();if(r.ok)setRows(b.data);};
 useEffect(()=>{const t=setInterval(()=>void refresh(),15000);return()=>clearInterval(t);},[]);
 return <><p>Основний результат — опублікований Short. Просування не затримує випуск. Запуск приймає перевірений редакційний кейс із джерелами, цитатою і монтажним планом. Grok, Maya, рендер, аудит і завантаження виконує код.</p>
 <form onSubmit={async e=>{e.preventDefault();setStatus('Запускаємо…');try{const input=JSON.parse(seed);const r=await fetch('/api/editorial/cycles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const b=await r.json();setStatus(r.ok?'Цикл запущено: '+b.data.id:'Помилка: '+b.error?.code);await refresh();}catch{setStatus('Перевірте JSON кейсу.');}}}>
 <label>Файл перевіреного редакційного кейсу<input type="file" accept="application/json,.json" onChange={async e=>{const file=e.target.files?.[0];if(file&&file.size<=200000){const value=await file.text();setSeed(value);}else setStatus('Файл завеликий.');}}/></label>
 {seed&&(()=>{try{const p=JSON.parse(seed);return <section><h2>{p.seed.scenario.title}</h2><blockquote>{p.seed.factcheck.quote}</blockquote><p>{p.seed.factcheck.explanation}</p><p>{p.seed.scenario.narrationText}</p><ul>{p.seed.evidence.map((e:{url:string;title:string})=><li key={e.url}><a href={e.url}>{e.title}</a></li>)}</ul><p>Цей запуск дозволяє публікацію на підключеному каналі після перевірок Grok і готового відео.</p></section>;}catch{return <p>Невірний формат кейсу.</p>;}})()}
 <button type="submit">Запустити погоджений випуск</button></form><p role="status">{status}</p>
 {rows.map(row=><article key={row.id}><h2>{row.release_state==='published'?'Short опубліковано':row.state}</h2>
 <p>Етап: {['Джерело','Субтитри','Докази','Сценарій','Grok direct','Maya та монтаж','Аудит відео','YouTube','Просування','Перевірка коментаря'][row.stage_index]??'Завершено'}</p>
 {row.youtube_id&&<p><a href={'https://www.youtube.com/shorts/'+row.youtube_id}>Відкрити Short на YouTube</a></p>}
 {row.scenario?.episodeId&&<p>Сценарій: {row.scenario.episodeId}</p>}
 {row.grok&&<p>Grok: {row.grok.originalityScore} / {row.grok.interestScore}</p>}
 {row.code&&<p>Причина: <code>{row.code}</code></p>}
 <details><summary>Історія циклу</summary><pre>{JSON.stringify(row.events,null,2)}</pre></details>
 {['queued','waiting'].includes(row.state)&&<button onClick={async()=>{const r=await fetch('/api/editorial/cycles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'resume',id:row.id})});setStatus(r.ok?'Цикл продовжено':'Не вдалося продовжити цикл');await refresh();}}>Продовжити цикл</button>}
 <small>{row.id}</small></article>)}
 </>;
}
