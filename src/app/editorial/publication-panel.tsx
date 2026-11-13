'use client';

import type { FormEvent } from 'react';
import { json, useRequest } from './workflow-controls';
import type { Episode } from './workflow-types';

type Metric = { day:number; measured_at:string; views:number; average_view_percent:number; source:string };
type YouTubeStats={fetched_at:string;views:string|null;likes:string|null;comments:string|null;error_code:string|null}|null;
type Correction = {
  id:string; status:string; revision:number; kind:string; original:string; replacement:string;
  reason:string; author:string; review_comment:string|null; posting_location:string|null;
};
type ReleaseMedia={id:string;ordinal:number;version:number;sha256:string|null;releaseApproved:boolean};
export type Publication = {
  id:string; episode_id:string; episode_version:number; media_revision_id:string|null; media_ordinal:number|null; youtube_id:string;
  published_at:string; ai_disclosed:boolean; youtube_stats:YouTubeStats; metrics:Metric[]; corrections:Correction[];
  history:{id:number; action:string; created_at:string; actor:string}[];
};

const kinds: Record<string,string> = {
  quote:'Цитата',context:'Контекст',fact:'Факт',translation:'Переклад',metadata:'Дані публікації',other:'Інше',
};
const historyLabels:Record<string,string> = { register:'Зареєстровано публікацію',metrics:'Збережено замір',
  propose:'Запропоновано виправлення',approve:'Погоджено виправлення',return:'Повернуто виправлення',post:'Зафіксовано публікацію виправлення' };
const states: Record<string,string> = { review:'На перевірці',approved:'Погоджено',returned:'Повернуто',posted:'Опубліковано' };
const formatTime=(value:string)=>new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Kyiv'}).format(new Date(value));
function fields(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  return new FormData(event.currentTarget,(event.nativeEvent as SubmitEvent).submitter);
}

function Register({episode,media}:{episode:Episode;media:ReleaseMedia[]}){
  const request=useRequest();
  return <form onSubmit={event=>{
    const form=fields(event);
    void request.send('/api/episodes/'+episode.id+'/publications',json({
      version:episode.version,url:form.get('url'),publishedAt:new Date(String(form.get('publishedAt'))).toISOString(),
      mediaRevisionId:form.get('mediaRevisionId'),confirmed:form.has('confirmed'),aiDisclosureConfirmed:form.has('aiDisclosureConfirmed'),
    }));
  }}>
    <label>Посилання опублікованого відео YouTube <input type="url" name="url" maxLength={2048} required /></label>
    <label>Час публікації (часовий пояс пристрою) <input type="datetime-local" name="publishedAt" required /></label>
    <label>Допущена ревізія монтажу <select name="mediaRevisionId" required defaultValue="">
      <option value="" disabled>Оберіть ревізію після допуску редактором</option>
      {media.filter(item=>item.releaseApproved&&item.sha256).map(item=><option key={item.id} value={item.id}>
        Монтаж {item.ordinal} · версія сценарію {item.version} · SHA-256 {item.sha256?.slice(0,12)}
      </option>)}
    </select></label>
    <p>Перед реєстрацією у YouTube Studio потрібно ввімкнути позначку AI-контенту для цього реалістичного синтетичного відео.</p>
    <label><input type="checkbox" name="aiDisclosureConfirmed" required /> Позначку AI-контенту ввімкнено в YouTube Studio.</label>
    <label><input type="checkbox" name="confirmed" required /> Опубліковано відео за цією версією сценарію.</label>
    <button disabled={request.pending}>Зареєструвати публікацію</button>
    {request.message&&<output role="status">{request.message}</output>}
  </form>;
}

function Metrics({publication}:{publication:Publication}){
  const request=useRequest();
  return <form onSubmit={event=>{
    const form=fields(event);
    void request.send('/api/publications/'+publication.id+'/metrics',json({
      day:Number(form.get('day')),views:Number(form.get('views')),averageViewPercent:Number(form.get('averageViewPercent')),
      measuredAt:new Date(String(form.get('measuredAt'))).toISOString(),source:form.get('source'),
    }));
  }}>
    <label>Період <select name="day"><option value="7">7 днів</option><option value="28">28 днів</option></select></label>
    <label>Дата заміру (часовий пояс пристрою) <input type="datetime-local" name="measuredAt" required /></label>
    <label>Перегляди <input type="number" name="views" min={0} max={Number.MAX_SAFE_INTEGER} required /></label>
    <label>Середній відсоток перегляду <input type="number" name="averageViewPercent" min={0} max={99999.999} step=".001" required /></label>
    <label>Джерело заміру <input name="source" maxLength={500} required /></label>
    <button disabled={request.pending}>Зберегти замір</button>
    {request.message&&<output role="status">{request.message}</output>}
  </form>;
}

function CorrectionForm({publication,correction}:{publication:Publication;correction?:Correction}){
  const request=useRequest();
  return <form onSubmit={event=>{
    const form=fields(event);
    const action=correction?(correction.status==='approved'?'post':form.get('action')):'propose';
    void request.send('/api/publications/'+publication.id+'/corrections',json({
      ...Object.fromEntries(form),id:correction?.id,expectedRevision:correction?.revision,action,
    }));
  }}>
    {!correction ? <>
      <label>Тип помилки <select name="kind">{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>Початкове формулювання <textarea name="original" maxLength={12000} required /></label>
      <label>Виправлене формулювання <textarea name="replacement" maxLength={12000} required /></label>
      <label>Причина виправлення <textarea name="reason" maxLength={4000} required /></label>
      <button disabled={request.pending}>Подати виправлення на перевірку</button>
    </> : correction.status==='review' ? <>
      <label>Коментар редактора <textarea name="comment" maxLength={4000} /></label>
      <div><button name="action" value="approve" disabled={request.pending}>Погодити виправлення</button>
        <button name="action" value="return" disabled={request.pending}>Повернути виправлення</button></div>
    </> : <>
      <label>Посилання або місце публікації виправлення <input name="location" maxLength={2000} required /></label>
      <button disabled={request.pending}>Зафіксувати публікацію виправлення</button>
    </>}
    {request.message&&<output role="status">{request.message}</output>}
  </form>;
}

export function PublicationPanel({episode,publication,roles,mediaRevisions}:{episode:Episode;publication?:Publication;roles:string[];mediaRevisions:ReleaseMedia[]}){
  const publisher=roles.includes('publisher'),editor=roles.includes('editor');
  const ready=episode.status==='approved'&&!episode.stale;
  if(!publication&&(!publisher||!ready)) return null;
  const exportVersion=publication?.episode_version??episode.version;
  return <section>
    <h5>Публікація YouTube · 16:9</h5>
    {publisher&&<a href={'/api/episodes/'+episode.id+'/versions/'+exportVersion+'/export'}>Завантажити текстовий ZIP · версія {exportVersion}</a>}
    {publication ? <>
      <p><a href={'https://www.youtube.com/watch?v='+publication.youtube_id} target="_blank" rel="noreferrer">
        Переглянути публікацію</a> · {formatTime(publication.published_at)} (Київ)</p>
      <p>Позначка AI-контенту в YouTube Studio: {publication.ai_disclosed?'підтверджена редактором':'не підтверджена'}</p>
      {publication.youtube_stats?.error_code?<p>Статистика YouTube: тимчасово недоступна ({publication.youtube_stats.error_code}).</p>:
        publication.youtube_stats&&<p>Власна статистика YouTube · {Number(publication.youtube_stats.views??0).toLocaleString('uk-UA')} переглядів ·
          {Number(publication.youtube_stats.likes??0).toLocaleString('uk-UA')} вподобань ·
          {Number(publication.youtube_stats.comments??0).toLocaleString('uk-UA')} коментарів · замір {formatTime(publication.youtube_stats.fetched_at)}</p>}
      {publication.media_revision_id&&<p>Допущений монтаж {publication.media_ordinal??'—'} · ревізія {publication.media_revision_id.slice(0,8)}</p>}
      <h6>Показники</h6>
      {publication.metrics.length>0&&<ul>{publication.metrics.map(metric=><li key={metric.day}>
        {metric.day} днів · {metric.views} переглядів · {metric.average_view_percent}% · {metric.source} · {formatTime(metric.measured_at)}
      </li>)}</ul>}
      {(publisher||editor)&&<details><summary>Додати замір</summary><Metrics publication={publication} /></details>}
      <h6>Виправлення</h6>
      {(editor||roles.includes('author'))&&<details><summary>Нове виправлення</summary><CorrectionForm publication={publication} /></details>}
      {publication.corrections.map(correction=><article className="workflow-card" key={correction.id}>
        <p><strong>{kinds[correction.kind]}</strong> · {states[correction.status]}</p>
        <p className="workflow-text">Було: {correction.original}</p><p className="workflow-text">Виправлено: {correction.replacement}</p>
        <p className="workflow-text">{correction.reason}</p>
        <p>Відповідальний: {correction.author}</p>
        {correction.review_comment&&<p className="workflow-text">{correction.review_comment}</p>}
        {correction.posting_location&&<p className="workflow-text">Місце публікації: {correction.posting_location}</p>}
        {((editor&&correction.status==='review')||(publisher&&correction.status==='approved'))&&
          <CorrectionForm key={correction.revision} publication={publication} correction={correction} />}
      </article>)}
      <details><summary>Історія публікації</summary>
        <ol>{publication.history.map(event=><li key={event.id}>
          {historyLabels[event.action]} · {event.actor} · {formatTime(event.created_at)}
        </li>)}</ol>
      </details>
    </> : <>
      {mediaRevisions.some(item=>item.releaseApproved&&item.sha256)?<Register episode={episode} media={mediaRevisions} />:
        <p>Реєстрація публікації відкриється після успішного аудиту Gemini та явного допуску цієї ревізії редактором.</p>}
    </>}
  </section>;
}
