'use client';

import {useEffect,useState} from 'react';

type Finding={
  category:string; severity:string; startMs:number|null; endMs:number|null; field:string|null;
  sourceIndex:number|null; observation:string; fix:string;
};
type Report={
  attempt:number; summary:string; completedAt:string; reviewedAt:string|null; reviewedByMe:boolean;
  coverage:{interval:number;startMs:number;endMs:number;audio:string;visual:string}[];
  findings:{finding:Finding;position:number;review:{disposition:string;comment:string}|null}[];
};
type Job={
  id:string; attempt:number; owned:boolean; status:string; error_code:string|null; model:string; reports:Report[];
};
const statuses:Record<string,string>={
  queued:'У черзі',running:'Gemini перевіряє відео',succeeded:'Аудит завершено',failed:'Помилка аудиту',unknown:'Результат або списання невідомі',
};
const messages:Record<string,string>={
  VIDEO_AUDIT_DISABLED:'Відеоаудит вимкнено в цьому середовищі.',
  ANALYSIS_DISABLED:'Платний аналіз тимчасово недоступний.',
  BUDGET_EXHAUSTED:'Спільний місячний ліміт Gemini вичерпано.',
  CONCURRENCY_LIMIT:'Зачекайте завершення активних аналізів.',
  MEDIA_STALE:'Монтаж пов’язаний з попередньою версією сценарію.',
  MEDIA_NOT_READY:'Потрібен доступний MP4 з пройденою технічною перевіркою.',
  VIDEO_COVERAGE_INCOMPLETE:'Gemini не підтвердив усі інтервали відео та звуку.',
  VIDEO_INPUT_UNCONFIRMED:'Gemini не підтвердив отримання відео.',
  VIDEO_PROVIDER_TIMEOUT:'Gemini не повернув результат вчасно.',
  PROVIDER_OUTCOME_UNKNOWN:'Зв’язок обірвався. Резерв збережено до звірки.',
  PROVIDER_USAGE_UNKNOWN:'Дані про витрати відсутні. Резерв збережено.',
  FINDINGS_OPEN:'Спершу закрийте кожне зауваження коментарем редактора.',
  AUDIT_REQUIRED:'Для цієї ревізії ще немає успішного аудиту Gemini.',
  RELEASE_APPROVAL_REQUIRED:'Публікацію можна зареєструвати лише для окремо допущеної ревізії монтажу.',
  INVALID_INPUT:'Перевірте заповнення форми.',
  FORBIDDEN:'Для цієї дії потрібна роль редактора.',
};
const categories:Record<string,string>={
  speech:'Розбірливість',pronunciation:'Вимова',pauses:'Паузи',overlap:'Накладання голосів',music:'Музика',
  subtitles:'Субтитри',quote:'Цитата',attribution:'Атрибуція',context:'Контекст',conclusion:'Висновок',
  unsupported:'Непідтверджене твердження',metadata:'Дані пакета',
};
const severities:Record<string,string>={critical:'Критичне',major:'Суттєве',minor:'Незначне'};
const seconds=(ms:number)=>new Intl.NumberFormat('uk-UA',{maximumFractionDigits:3}).format(ms/1000)+' с';

export function VideoAuditPanel({endpoint,canRun,canReview}:{endpoint:string;canRun:boolean;canReview:boolean}){
  const [jobs,setJobs]=useState<Job[]>([]);
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState(false);
  const active=jobs.some(job=>['queued','running'].includes(job.status));
  useEffect(()=>{
    const abort=new AbortController();
    const refresh=async()=>{
      try {
        const response=await fetch(endpoint,{cache:'no-store',signal:abort.signal});
        const result=await response.json();
        if(response.ok) setJobs(result.data);
        else setMessage('Не вдалося завантажити аудити.');
      }catch(error){if((error as Error).name!=='AbortError')setMessage('Не вдалося завантажити аудити.');}
    };
    void refresh();
    const timer=active?setInterval(refresh,5000):undefined;
    return ()=>{abort.abort();clearInterval(timer);};
  },[endpoint,active]);

  async function run(input:object){
    if(pending) return;
    setPending(true);
    setMessage('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,confirmed:true})});
      const result=await response.json();
      if(!response.ok) throw Error(result.error?.code);
      const refreshed=await fetch(endpoint,{cache:'no-store'});
      if(!refreshed.ok) throw Error('AUDIT_LIST_FAILED');
      setJobs((await refreshed.json()).data);
    }catch(error){setMessage(messages[(error as Error).message]??'Не вдалося запустити відеоаудит.');}
    finally{setPending(false);}
  }

  async function review(input:Record<string,unknown>){
    if(pending) return;
    setPending(true);setMessage('');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
      const result=await response.json();
      if(!response.ok) throw Error(result.error?.code);
      const refreshed=await fetch(endpoint,{cache:'no-store'});
      if(!refreshed.ok) throw Error('AUDIT_LIST_FAILED');
      setJobs((await refreshed.json()).data);
      setMessage(input.action==='approve'?'Ревізію монтажу допущено до реєстрації публікації.':'Рішення редактора збережено.');
    }catch(error){setMessage(messages[(error as Error).message]??'Не вдалося зберегти рішення редактора.');}
    finally{setPending(false);}
  }

  return <details><summary>Аудит відео та звуку Gemini</summary>
    {canRun&&jobs.length===0&&<form onSubmit={event=>{event.preventDefault();void run({});}}>
      <label><input type="checkbox" required /> Передати цей MP4 і пакет сценарію Gemini в межах спільного бюджету.</label>
      <button disabled={pending}>Запустити аудит</button>
    </form>}
    {message&&<output role="status">{message}</output>}
    {jobs.map(job=><article className="workflow-card" key={job.id}>
      <p>{statuses[job.status]} · {job.model} · спроба {job.attempt}</p>
      {job.error_code&&<p>{messages[job.error_code]??'Gemini не повернув перевірений звіт.'}</p>}
      {canRun&&job.owned&&job.attempt<3&&!['queued','running'].includes(job.status)&&
        <form onSubmit={event=>{
          event.preventDefault();
          const form=new FormData(event.currentTarget);
          void run({retry:true,expectedAttempt:job.attempt,acknowledgeUnknown:form.has('ack')});
        }}>
          <label><input name="ack" type="checkbox" required /> Передати MP4 повторно. Можливе нове списання.</label>
          <button disabled={pending}>Повторити аудит</button>
        </form>}
      {job.reports.map(report=><details key={report.attempt} open={report.attempt===job.attempt}>
        <summary>Звіт · спроба {report.attempt}</summary>
        <p>{report.summary}</p>
        <p>Gemini перевірив звук і відеоряд на всій шкалі. Кадри відеоряду відібрані з частотою 1 кадр/с.</p>
        <ul>{report.coverage.map(row=><li key={row.interval}>
          <strong>{seconds(row.startMs)} – {seconds(row.endMs)}</strong>
          <p>Звук: {row.audio}</p><p>Відеоряд: {row.visual}</p>
        </li>)}</ul>
        {report.reviewedAt&&<p>Ревізію допущено редактором · {new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Kyiv'}).format(new Date(report.reviewedAt))}</p>}
        {report.findings.length===0?<p>Gemini не запропонував зауважень.</p>:<ol>{report.findings.map(({finding,position,review:decision})=><li key={position}>
          <strong>{severities[finding.severity]} · {categories[finding.category]}</strong>
          <p>{finding.startMs!==null&&finding.endMs!==null?
            seconds(finding.startMs)+' – '+seconds(finding.endMs):finding.field}
          {finding.sourceIndex!==null&&' · джерело '+(finding.sourceIndex+1)}</p>
          <p>{finding.observation}</p><p>Запропонована правка: {finding.fix}</p>
          {decision?<p><strong>{decision.disposition==='resolved'?'Виправлено':'Прийнято редактором'}:</strong> {decision.comment}</p>:canReview&&report.attempt===job.attempt&&<form onSubmit={event=>{
            event.preventDefault();const form=new FormData(event.currentTarget);
            void review({action:'finding',attempt:report.attempt,position,disposition:form.get('disposition'),comment:form.get('comment')});
          }}>
            <label>Рішення редактора <select name="disposition"><option value="resolved">Виправлено</option><option value="accepted">Прийнято без правки</option></select></label>
            <label>Коментар та обґрунтування <textarea name="comment" minLength={1} maxLength={4000} required /></label>
            <button disabled={pending}>Зберегти рішення</button>
          </form>}
        </li>)}</ol>}
        {canReview&&report.attempt===job.attempt&&job.status==='succeeded'&&!report.reviewedAt&&<button disabled={pending}
          onClick={()=>void review({action:'approve'})}>Допустити цю ревізію до публікації</button>}
      </details>)}
    </article>)}
  </details>;
}
