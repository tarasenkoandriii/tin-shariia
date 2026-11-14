'use client';

import { useEffect, useState } from 'react';
import { ClaimForm } from './workflow-controls';
import type { Transcript } from './workflow-types';

type Draft = {
  kind: string; quote: string; question: string; verifiedQuote: boolean; paraphrase: boolean;
  segmentIds: number[]; startMs: number | null; endMs: number | null;
  context?: string; position?: number; claimId?: string | null;
};
type Job = {
  id: string; status: string; attempt: number; transcript_id: string | null; mode?: string; duration_sec?: number | null; owned: boolean;
  error_code: string | null; completed_chunks: number; total_chunks: number;
  budget_status: string; reserved_micros: string; spent_micros: string; drafts?: Draft[];
};

const labels: Record<string,string> = {
  queued:'У черзі',running:'Аналіз триває',succeeded:'Завершено',failed:'Помилка',unknown:'Результат запиту невідомий',
  fact:'Твердження',opinion:'Думка',prediction:'Прогноз',
};
const errors: Record<string,string> = {
  ANALYSIS_DISABLED:'Аналіз ще не налаштовано для цього середовища.',
  BUDGET_EXHAUSTED:'Місячний бюджет аналізу вичерпано.',
  CONCURRENCY_LIMIT:'Дочекайтеся завершення активних аналізів.',
  ATTEMPT_CONFLICT:'Спроба вже змінилася. Оновіть сторінку.',
  ACKNOWLEDGMENT_REQUIRED:'Підтвердьте можливе повторне списання.',
  TRANSCRIPT_TOO_LARGE:'Розшифрування завелике. Імпортуйте коротший фрагмент.',
  SEGMENT_TOO_LARGE:'Одна репліка завелика. Розділіть її на менші репліки.',
  PROVIDER_REJECTED:'Gemini відхилив запит.',
  PROVIDER_RATE_LIMIT:'Gemini обмежив частоту запитів.',
  PROVIDER_UNAVAILABLE:'Gemini тимчасово недоступний.',
  PROVIDER_RESPONSE_INVALID:'Відповідь Gemini не пройшла перевірку формату.',
  PROVIDER_OUTCOME_UNKNOWN:'Зв’язок перервався. Резерв збережено до звірки.',
  PROVIDER_USAGE_UNKNOWN:'Gemini не повернув дані про витрати. Резерв збережено.',
  YOUTUBE_DURATION_REQUIRED:'YouTube не повернув тривалість. Вкажіть тривалість ролику в секундах.',
  YOUTUBE_VIDEO_TOO_LONG:'Ролик задовгий для одного аналізу (до 3 годин).',
  ANALYSIS_NOT_READY:'Аналіз ще не завершено.',
};

async function data<T>(url: string, signal?: AbortSignal, body?: object): Promise<T> {
  const response=await fetch(url,{signal,cache:'no-store',...(body ? {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  } : {})});
  const result=await response.json();
  if(!response.ok) throw Error(result.error?.code);
  return result.data;
}

const active=(job: Job)=>['queued','running'].includes(job.status);
export function AnalysisPanel({ videoId, transcripts, canRun }: {videoId:string; transcripts:Transcript[]; canRun:boolean}) {
  const [jobs,setJobs]=useState<Job[]>([]);
  const [selected,setSelected]=useState<Job>();
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState(false);
  const endpoint='/api/videos/'+videoId+'/analysis-jobs';
  const hasActive=jobs.some(active);
  useEffect(()=>{
    const controller=new AbortController();
    const refresh=()=>data<Job[]>(endpoint,controller.signal).then(setJobs).catch(error=>{
      if(error.name!=='AbortError') setMessage('Не вдалося завантажити аналізи.');
    });
    void refresh();
    const timer=hasActive?setInterval(refresh,4000):undefined;
    return ()=>{ controller.abort(); clearInterval(timer); };
  },[endpoint,hasActive]);

  async function enqueue(input: object) {
    if(pending) return;
    setPending(true);
    setMessage('');
    try {
      const result=await data<{source?:string;captions?:{language:string;automatic:boolean;segments:number};captionsSkipped?:string}>(endpoint,undefined,input);
      if(result?.source==='captions'&&result.captions) setMessage(`Узято субтитри YouTube (${result.captions.language}, `
        +`${result.captions.automatic?'автоматичні':'авторські'}, ${result.captions.segments} фрагментів): Gemini аналізує текст, а не відео. `
        +'Цитати звіряйте з відео — автоматичні субтитри можуть помилятися.');
      else if(result?.source==='video'&&result.captionsSkipped&&result.captionsSkipped!=='DISABLED')
        setMessage('Субтитри YouTube недоступні — Gemini аналізує все відео.');
      setSelected(undefined);
      setJobs(await data<Job[]>(endpoint));
    } catch(error) {
      setMessage(errors[(error as Error).message]??'Не вдалося поставити аналіз у чергу.');
    } finally { setPending(false); }
  }

  async function createClaims(job: Job) {
    if(pending) return;
    setPending(true);setMessage('');
    try {
      const result=await data<{created:number}>('/api/analysis-jobs/'+job.id,undefined,{action:'create-claims'});
      setMessage(result.created?`Створено чернеток тверджень: ${result.created}. Оновіть сторінку, щоб побачити їх нижче.`
        :'Усі пропозиції вже перенесено у твердження.');
      setSelected(await data<Job>('/api/analysis-jobs/'+job.id));
    } catch(error) {
      setMessage(errors[(error as Error).message]??'Не вдалося створити твердження.');
    } finally { setPending(false); }
  }

  return <section>
    <h2>Аналіз розшифрування</h2>
    {canRun&&<form onSubmit={event=>{
      event.preventDefault();
      const form=new FormData(event.currentTarget);
      const raw=String(form.get('durationSec')??'').trim();
      void enqueue({source:'youtube',captions:form.has('captions'),...(raw?{durationSec:Number(raw)}:{})});
    }}>
      <p>Gemini запропонує перевірювані твердження з таймкодами. Якщо YouTube віддає субтитри ролику, аналізується їхній текст — це в десятки разів дешевше. Інакше Gemini перегляне весь ролик частинами по 8 хвилин.</p>
      <label><input type="checkbox" name="captions" defaultChecked /> Спершу спробувати субтитри YouTube (економія Gemini)</label>
      <label>Тривалість, с (лише якщо YouTube не повернув її сам) <input name="durationSec" type="number" min={10} max={86400} /></label>
      <button disabled={pending}>Проаналізувати весь ролик через Gemini</button>
    </form>}
    {canRun&&transcripts.length>0&&<form onSubmit={event=>{
      event.preventDefault();
      const form=new FormData(event.currentTarget);
      void enqueue({transcriptId:form.get('transcriptId')});
    }}>
      <label>Розшифрування для аналізу <select name="transcriptId">
        {transcripts.map(t=><option key={t.id} value={t.id}>Версія {t.version} · {t.format.toUpperCase()}</option>)}
      </select></label>
      <button disabled={pending}>Запустити Gemini</button>
    </form>}
    {message&&<output role="status">{message}</output>}
    <ul>{jobs.map(job=><li key={job.id}>
      {job.mode==='youtube'?'Весь ролик':'Розшифрування'} · {labels[job.status]} · {job.completed_chunks}/{job.total_chunks} · спроба {job.attempt}
      {job.error_code&&<p>{errors[job.error_code]??'Аналіз завершився з помилкою.'}</p>}
      {job.status==='succeeded'&&<button type="button" onClick={()=>void data<Job>('/api/analysis-jobs/'+job.id)
        .then(setSelected).catch(()=>setMessage('Не вдалося відкрити чернетки.'))}>Відкрити чернетки</button>}
      {canRun&&job.owned&&job.attempt<3&&['failed','unknown'].includes(job.status)&&
        <form onSubmit={event=>{
          event.preventDefault();
          const form=new FormData(event.currentTarget);
          const retry={retry:true,expectedAttempt:job.attempt,acknowledgeUnknown:form.has('ack')};
          void enqueue(job.mode==='youtube'?{source:'youtube',...(job.duration_sec?{durationSec:job.duration_sec}:{}),...retry}
            :{transcriptId:job.transcript_id,...retry});
        }}>
          {job.status==='unknown'&&<label><input type="checkbox" name="ack" required /> Можливе повторне списання</label>}
          <button disabled={pending}>Повторити аналіз</button>
        </form>}
    </li>)}</ul>
    {selected&&<article className="workflow-card">
      <h3>Чернетки Gemini</h3>
      {selected.drafts?.length===0&&<p>Gemini не запропонував тверджень.</p>}
      {canRun&&selected.drafts?.some(draft=>!draft.claimId)&&<button type="button" disabled={pending} onClick={()=>void createClaims(selected)}>
        Створити чернетки тверджень з усіх пропозицій</button>}
      {selected.drafts?.map((draft,index)=><article className="workflow-card" key={index}>
        <h4>{draft.question}</h4>
        <blockquote>{draft.quote}</blockquote>
        {draft.context&&<p>{draft.context}</p>}
        {draft.claimId&&<p>Уже перенесено у твердження.</p>}
        <p>{labels[draft.kind]} · {draft.paraphrase?'Переказ':draft.verifiedQuote?'Цитату знайдено в розшифруванні':'Потрібна ручна звірка'} ·
          {' '}{draft.segmentIds.length?'репліки '+draft.segmentIds.map(id=>id+1).join(', ')
            :draft.startMs!==null&&draft.endMs!==null?`${Math.floor(draft.startMs/1000)}–${Math.ceil(draft.endMs/1000)} с`:''}</p>
        {canRun&&!draft.claimId&&<details><summary>Перенести у твердження</summary>
          <ClaimForm videoId={videoId} transcripts={transcripts} draft={{
            transcriptId:selected.transcript_id??undefined, quote:draft.quote, question:draft.question,
            startMs:draft.startMs,endMs:draft.endMs,
          }} />
        </details>}
      </article>)}
    </article>}
  </section>;
}
