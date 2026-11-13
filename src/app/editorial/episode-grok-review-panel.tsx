'use client';

import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {Episode} from './workflow-types';

export type EpisodeGrokReview={id:string;episode_version:number;round:number;state:string;error_code:string|null;accepted_at:string|null;
  auto_accepted:boolean;auto_accept_threshold:number|null;created_at:string;
  result:{originalityScore:number;interestScore:number;summary:string;strengths:string[];recommendations:{change:string;reason:string;priority:string}[];factRisks:string[];limits:string}|null};
const labels:Record<string,string>={queued:'Очікує фонової перевірки',submitting:'Надсилається в Grok Batch',submitted:'Grok аналізує у фоні',succeeded:'Є рекомендації для редактора',accepted:'Сценарій допущено до генерації відео',failed:'Не вдалося перевірити',unknown:'Невідомо, чи прийняв Grok запит; повтор не запускається'};

export function EpisodeGrokReviewPanel({episode,reviews,canRun,canAccept}:{episode:Episode;reviews:EpisodeGrokReview[];canRun:boolean;canAccept:boolean}){
  const router=useRouter(),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const current=reviews.filter(item=>item.episode_version===episode.version).sort((a,b)=>b.round-a.round);
  const latest=current[0],active=latest&&['queued','submitting','submitted','unknown'].includes(latest.state);
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>router.refresh(),12000);return()=>clearInterval(timer);},[active,router]);
  async function act(action:'run'|'accept'){
    if(busy)return;setBusy(true);setMessage('');
    try{
      const response=await fetch(`/api/episodes/${episode.id}/grok-review`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(action==='run'?{action}:{action,reviewId:latest?.id,version:episode.version})});
      const body=await response.json();
      if(!response.ok)throw Error(body.error?.code??'REQUEST_FAILED');
      setMessage(action==='run'?'Прохід поставлено у фонову чергу. Результат з’явиться тут.':'Сценарій допущено до відеогенерації.');router.refresh();
    }catch(error){
      const code=(error as Error).message;
      setMessage(code==='GROK_MONTHLY_LIMIT'?'Вичерпано місячний ліміт Grok Batch $5.':
        code==='GROK_NOT_CONFIGURED'?'Grok API ще не налаштовано в Production.':
        code==='GROK_REVIEW_PENDING'?'Поточний прохід ще виконується.':`Не вдалося завершити дію (${code}).`);
    }finally{setBusy(false);}
  }
  return <section className="workflow-card">
    <h5>Перед генерацією відео · Grok Batch</h5>
    <p>Grok порівнює сценарій із джерелами та результатами попередніх публікацій каналу, оцінює новизну й інтерес, пропонує конкретні правки. Він не переписує сценарій сам: автор вносить зміни, проходить погодження нової версії та за потреби запускає наступний прохід.</p>
    {latest&&<article>
      <strong>Версія {latest.episode_version} · прохід {latest.round}: {labels[latest.state]??latest.state}</strong>
      {latest.auto_accepted&&<p>Автоприйняття: обидві оцінки не нижчі за {latest.auto_accept_threshold}/100, фактичних ризиків Grok не виявив.</p>}
      {latest.error_code&&<p>Код: {latest.error_code}</p>}
      {latest.result&&<>
        <p>Оцінка редакційної новизни: {latest.result.originalityScore}/100 · інтересу: {latest.result.interestScore}/100</p>
        <p>{latest.result.summary}</p>
        {latest.result.strengths?.length>0&&<><strong>Що працює</strong><ul>{latest.result.strengths.map((value,index)=><li key={index}>{value}</li>)}</ul></>}
        {latest.result.recommendations?.length>0&&<><strong>Що покращити до відеогенерації</strong><ol>{latest.result.recommendations.map((item,index)=><li key={index}>
          <strong>{item.change}</strong> · {item.reason} · пріоритет: {item.priority}
        </li>)}</ol></>}
        {latest.result.factRisks?.length>0&&<><strong>Факти для додаткової перевірки</strong><ul>{latest.result.factRisks.map((item,index)=><li key={index}>{item}</li>)}</ul></>}
        <p><small>Це редакційна оцінка тексту, а не доказ відсутності плагіату чи заміна фактчекінгу. {latest.result.limits}</small></p>
      </>}
      {latest.state==='succeeded'&&canAccept&&<button disabled={busy} onClick={()=>void act('accept')}>Погодити сценарій для генерації відео</button>}
    </article>}
    {canRun&&<button disabled={busy||!!active} onClick={()=>void act('run')}>
      {active?'Прохід виконується…':latest?.state==='accepted'?'Запросити ще один прохід Grok':'Перевірити сценарій через Grok Batch'}
    </button>}
    {reviews.filter(item=>item.episode_version!==episode.version).length>0&&<p>Є попередні проходи для старих версій сценарію; вони не допускають поточну версію до генерації.</p>}
    {message&&<output role="status">{message}</output>}
  </section>;
}
