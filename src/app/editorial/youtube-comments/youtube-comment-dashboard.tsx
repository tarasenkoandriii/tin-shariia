'use client';

import {useMemo,useState} from 'react';
import Link from 'next/link';

type CommentRow={id:string;episode_title:string|null;parent_video_id:string;short_video_id:string;state:string;draft_text:string|null;final_text:string|null;
  scheduled_at:string|null;published_at:string|null;error_code:string|null;click_count:number;tracking_token:string;main_video_id:string};
export type CommentDashboardData={settings:{enabled:boolean;interval_hours:number};connection:{channelTitle:string;channelId:string;commentScope:boolean}|null;
  comments:CommentRow[];chart:{hour:string;clicks:number}[];publishedMarkers:{publishedAt:string;shortVideoId:string;clicks:number}[];shortLinkOrigin:string;totalClicks:number;chartEnd:string};

const labels:Record<string,string>={queued:'У черзі Grok',submitting:'Передається Grok',submitted:'Grok аналізує',succeeded:'Чекає схвалення',scheduled:'Заплановано',publishing:'Публікується',published:'Опубліковано',failed:'Помилка',rejected:'Відхилено',unknown:'Потрібна перевірка'};
const stamp=(value:string|null)=>value?new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Kyiv'}).format(new Date(value)):'—';

export function YouTubeCommentDashboard({initial,canManage,canApprove}:{initial:CommentDashboardData;canManage:boolean;canApprove:boolean}){
  const [data,setData]=useState(initial),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[enabled,setEnabled]=useState(initial.settings.enabled),[hours,setHours]=useState(initial.settings.interval_hours);
  const [consented,setConsented]=useState(false);
  const bins=useMemo(()=>{
    const end=new Date(data.chartEnd).getTime(),start=end-7*24*60*60*1000,step=3*60*60*1000,count=56;
    const values=Array.from({length:count},(_,i)=>({time:start+i*step,clicks:0}));
    for(const item of data.chart){const time=new Date(item.hour).getTime(),index=Math.floor((time-start)/step);if(index>=0&&index<count)values[index].clicks+=item.clicks;}
    const max=Math.max(1,...values.map(item=>item.clicks));
    const markers=data.publishedMarkers.map(item=>({x:(new Date(item.publishedAt).getTime()-start)/(end-start)*100,item})).filter(item=>item.x>=0&&item.x<=100);
    return {values,max,markers,start,end};
  },[data]);
  async function refresh(){const response=await fetch('/api/editorial/youtube-comments',{cache:'no-store'});if(!response.ok)throw Error('Не вдалося оновити статистику.');const body=await response.json();setData(body.data);}
  async function post(payload:Record<string,unknown>){setBusy(true);setMessage('');try{const response=await fetch('/api/editorial/youtube-comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const body=await response.json().catch(()=>null);if(!response.ok)throw Error(body?.error?.code??'Не вдалося зберегти.');await refresh();setMessage('Збережено.');}catch(error){setMessage(error instanceof Error?error.message:'Сталася помилка.');}finally{setBusy(false);}}
  const needsScope=!data.connection?.commentScope;
  return <>
    <section className="youtube-comment-settings workflow-card">
      <div><h2>Розклад</h2><p>За один інтервал вийде не більше одного коментаря. Нові тексти Grok не публікуються без схвалення редактора.</p></div>
      <p>{data.connection?<>Канал: <strong>{data.connection.channelTitle}</strong></>:<strong>Канал YouTube не підключено</strong>}</p>
      {needsScope&&<p role="status">Для коментарів потрібна окрема згода YouTube. Читання статистики та завантаження відео працюють за чинним дозволом.</p>}
      {needsScope&&<Link className="button-link" href="/api/youtube/oauth/start?comments=1">Надати дозвіл на коментарі YouTube</Link>}
      {canManage&&<>
        <label className="comment-setting-field">Інтервал, годин
          <input type="number" min={3} max={168} value={hours} onChange={event=>setHours(Number(event.target.value))} />
        </label>
        <label className="comment-setting-field"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)} /> Увімкнути чергу схвалених коментарів</label>
        {enabled&&<label className="comment-setting-consent"><input type="checkbox" checked={consented} onChange={event=>setConsented(event.target.checked)} />
          Я дозволяю публікацію тільки схвалених редактором коментарів від імені каналу {data.connection?.channelTitle??'YouTube'}.</label>}
        <button type="button" disabled={busy||needsScope||(enabled&&!consented)} onClick={()=>void post({action:'settings',enabled,intervalHours:hours,confirmed:consented})}>
          {busy?'Зберігаємо…':'Зберегти розклад'}
        </button>
      </>}
      {message&&<p role="status">{message}</p>}
      <p className="muted">Інтервал за замовчуванням — 3 години; мінімум також 3 години, щоб не перетворювати коментарі на частий повторюваний потік. Він розділяє публікації глобально. Нова настройка діє для майбутніх схвалень; уже запланований час не пересувається.</p>
    </section>
    <section className="workflow-card youtube-click-chart">
      <div className="youtube-chart-heading"><div><h2>Переходи з коментарів</h2><p>Останні 7 днів · кількість переходів через унікальні посилання</p></div>
        <span>{data.totalClicks} за весь доступний період</span></div>
      <div className="youtube-chart-wrap"><svg viewBox="0 0 1000 260" role="img" aria-label="Графік переходів з коментарів за 7 днів">
        {[0,1,2,3].map(line=><line key={line} x1="48" x2="985" y1={24+line*62} y2={24+line*62} className="youtube-chart-grid" />)}
        {bins.values.map((bin,index)=>{const width=937/bins.values.length,bar=Math.max(1,bin.clicks/bins.max*176);return <rect key={index} x={48+index*width+1} y={208-bar} width={Math.max(2,width-2)} height={bar} rx="2" className="youtube-chart-bar"><title>{stamp(new Date(bin.time).toISOString())}: {bin.clicks} переходів</title></rect>;})}
        {bins.markers.map(({x,item})=><g key={item.shortVideoId+item.publishedAt}><line x1={48+x*9.37} x2={48+x*9.37} y1="18" y2="218" className="youtube-chart-publish"/><circle cx={48+x*9.37} cy="16" r="5" className="youtube-chart-publish-dot"><title>Коментар опубліковано {stamp(item.publishedAt)} · Shorts {item.shortVideoId}</title></circle></g>)}
        <text x="48" y="246">{stamp(new Date(bins.start).toISOString())}</text><text x="890" y="246">Зараз</text>
      </svg></div>
      <p className="youtube-chart-legend"><i /> переходи <b /> час публікації коментаря</p>
      <p className="muted">Рахуються запити до перенаправлення, а не унікальні люди: попередній перегляд посилання чи повторне натискання теж може враховуватися.</p>
    </section>
    <section className="youtube-comment-list">
      <h2>Чернетки й публікації</h2>
      {!data.comments.length&&<p>Коли буде опубліковано Shorts до основного відео, після ввімкнення розкладу Grok підготує чернетку.</p>}
      {data.comments.map(item=><article className="workflow-card youtube-comment-card" key={item.id}>
        <header><div><h3>{item.episode_title||'Відео'}</h3><p>{labels[item.state]??item.state}</p></div><strong>{item.click_count} переходів</strong></header>
        <p>Основне відео: <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(item.main_video_id)}`} target="_blank" rel="noreferrer">відкрити на YouTube</a></p>
        <p>Підтверджувальний Shorts: <a href={`https://www.youtube.com/shorts/${encodeURIComponent(item.short_video_id)}`} target="_blank" rel="noreferrer">відкрити Shorts</a></p>
        {item.draft_text&&<blockquote><strong>Перевір текст із посиланням, який буде опубліковано:</strong><br/>{item.draft_text}<br/><br/>
          <a href={`${data.shortLinkOrigin}/go/short/${encodeURIComponent(item.tracking_token)}`} target="_blank" rel="noreferrer">{data.shortLinkOrigin}/go/short/{item.tracking_token}</a></blockquote>}
        {item.final_text&&<blockquote><strong>Точний схвалений текст:</strong><br/>{item.final_text}</blockquote>}
        <p>Опубліковано: {stamp(item.published_at)}{item.scheduled_at&&!item.published_at?` · заплановано ${stamp(item.scheduled_at)}`:''}</p>
        {item.error_code&&<p role="alert">{item.error_code}</p>}
        {item.state==='succeeded'&&canApprove&&<div className="youtube-comment-actions">
          <button type="button" disabled={busy||!enabled||needsScope} onClick={()=>void post({action:'approve',id:item.id})}>Схвалити й запланувати</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={()=>void post({action:'reject',id:item.id})}>Відхилити</button>
        </div>}
      </article>)}
    </section>
  </>;
}
