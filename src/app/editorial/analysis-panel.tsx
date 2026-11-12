'use client';

import { useEffect, useState } from 'react';
import { ClaimForm } from './workflow-controls';
import type { Transcript } from './workflow-types';

type Draft = {
  kind: string; quote: string; question: string; verifiedQuote: boolean; paraphrase: boolean;
  segmentIds: number[]; startMs: number | null; endMs: number | null;
};
type Job = {
  id: string; status: string; attempt: number; transcript_id: string; owned: boolean;
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
      await data(endpoint,undefined,input);
      setSelected(undefined);
      setJobs(await data<Job[]>(endpoint));
    } catch(error) {
      setMessage(errors[(error as Error).message]??'Не вдалося поставити аналіз у чергу.');
    } finally { setPending(false); }
  }

  return <section>
    <h2>Аналіз розшифрування</h2>
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
      {labels[job.status]} · {job.completed_chunks}/{job.total_chunks} · спроба {job.attempt}
      {job.error_code&&<p>{errors[job.error_code]??'Аналіз завершився з помилкою.'}</p>}
      {job.status==='succeeded'&&<button type="button" onClick={()=>void data<Job>('/api/analysis-jobs/'+job.id)
        .then(setSelected).catch(()=>setMessage('Не вдалося відкрити чернетки.'))}>Відкрити чернетки</button>}
      {canRun&&job.owned&&job.attempt<3&&['failed','unknown'].includes(job.status)&&
        <form onSubmit={event=>{
          event.preventDefault();
          const form=new FormData(event.currentTarget);
          void enqueue({transcriptId:job.transcript_id,retry:true,expectedAttempt:job.attempt,acknowledgeUnknown:form.has('ack')});
        }}>
          {job.status==='unknown'&&<label><input type="checkbox" name="ack" required /> Можливе повторне списання</label>}
          <button disabled={pending}>Повторити аналіз</button>
        </form>}
    </li>)}</ul>
    {selected&&<article className="workflow-card">
      <h3>Чернетки Gemini</h3>
      {selected.drafts?.length===0&&<p>Gemini не запропонував тверджень.</p>}
      {selected.drafts?.map((draft,index)=><article className="workflow-card" key={index}>
        <h4>{draft.question}</h4>
        <blockquote>{draft.quote}</blockquote>
        <p>{labels[draft.kind]} · {draft.paraphrase?'Переказ':draft.verifiedQuote?'Цитату знайдено в розшифруванні':'Потрібна ручна звірка'} ·
          {' '}репліки {draft.segmentIds.map(id=>id+1).join(', ')}</p>
        {canRun&&<details><summary>Перенести у твердження</summary>
          <ClaimForm videoId={videoId} transcripts={transcripts} draft={{
            transcriptId:selected.transcript_id, quote:draft.quote, question:draft.question,
            startMs:draft.startMs,endMs:draft.endMs,
          }} />
        </details>}
      </article>)}
    </article>}
  </section>;
}
