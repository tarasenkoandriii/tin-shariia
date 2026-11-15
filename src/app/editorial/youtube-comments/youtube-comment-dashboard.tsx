'use client';

import {useMemo,useState} from 'react';
import Link from 'next/link';
import {commentStatus,visibilityLabels} from '../../../editorial/comment-status.mjs';
import {Badge,Empty,KyivTime,SectionHead,type Tone} from '../ui';

type CommentRow={public_visibility:{code:string;checkedAt:string}|null;test_click_count:number;last_click_at:string|null;prepared_short_link:string|null;id:string;episode_title:string|null;parent_video_id:string;short_video_id:string;state:string;draft_text:string|null;final_text:string|null;
  scheduled_at:string|null;published_at:string|null;youtube_comment_id:string|null;error_code:string|null;click_count:number;tracking_token:string;target_kind:string;approved_channel_id:string|null;publication_steps:{phase:string;plain_verified_at:string|null;linked_verified_at:string|null;checked_at?:string|null;error_code:string|null}|null;verification_pending:boolean;can_recover:boolean};
export type CommentDashboardData={settings:{enabled:boolean;interval_hours:number};connection:{channelTitle:string;channelId:string;commentScope:boolean}|null;
  comments:CommentRow[];chart:{hour:string;clicks:number}[];candidates:{id:string;kind:'upload'|'publication';title:string;short_video_id:string;source_video_id:string}[];publishedMarkers:{id:string;parentVideoId:string;publishedAt:string;shortVideoId:string;clicks:number}[];shortLinkOrigin:string;testClicks:number;totalClicks:number;chartEnd:string};
export type VisibilityFilter='confirmed'|'checking'|'not_confirmed';

const labels:Record<string,string>={queued:'У черзі Grok',submitting:'Передається Grok',submitted:'Grok аналізує',succeeded:'Чекає схвалення',scheduled:'Заплановано',publishing:'Публікується',published:'Опубліковано',failed:'Помилка',rejected:'Відхилено',unknown:'Потрібна перевірка'};
const stepLabels:Record<string,string>={
  waiting_plain:'Перевіряємо текст без посилання після перезавантаження',
  link_ready:'Текст видимий · готуємо схвалене посилання',
  link_sending:'Додаємо схвалене посилання до того самого коментаря',
  waiting_link:'Перевіряємо коментар із посиланням після перезавантаження',
  verified:'Видимість із посиланням була підтверджена після перезавантаження',
  blocked:'Видимість не підтверджено · потрібна перевірка редактора',
};
const stamp=(value:string|null)=>value?new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Kyiv'}).format(new Date(value)):'—';
const targetLabel=(kind:string)=>kind==='source'?'Вихідне відео':'Наш основний випуск';
const watchUrl=(id:string)=>`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
const shortsUrl=(id:string)=>`https://www.youtube.com/shorts/${encodeURIComponent(id)}`;
const commentUrl=(item:CommentRow)=>`https://www.youtube.com/watch?v=${encodeURIComponent(item.parent_video_id)}&lc=${encodeURIComponent(item.youtube_comment_id??'')}`;
const filterOrder:VisibilityFilter[]=['confirmed','checking','not_confirmed'];

// A link exactly as it goes into the comment. Only a full http(s) address becomes clickable; a direct
// `youtube.com/shorts/…` without a scheme stays plain text so nobody mistakes a rewritten URL for the sent one.
function SentLink({value}:{value:string}){
  return /^https?:\/\//i.test(value)?<a href={value} target="_blank" rel="noreferrer"><code>{value}</code></a>:<code>{value}</code>;
}

export function YouTubeCommentDashboard({initial,canManage,canApprove,visibilityFilter=null}:{initial:CommentDashboardData;canManage:boolean;canApprove:boolean;visibilityFilter?:VisibilityFilter|null}){
  const [data,setData]=useState(initial),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[enabled,setEnabled]=useState(initial.settings.enabled),[hours,setHours]=useState(initial.settings.interval_hours);
  const [consented,setConsented]=useState(false);
  const [targetKind,setTargetKind]=useState('main');
  const [shortLinks,setShortLinks]=useState<Record<string,string>>({});
  const [edits,setEdits]=useState<Record<string,string>>({});
  const errors:Record<string,string>={
    YOUTUBE_COMMENT_SHORTENER_UNAVAILABLE:'Скорочувачі тимчасово недоступні. Коментар не відправлено.',
    YOUTUBE_COMMENT_SHORT_LINK_INVALID:'Коротке посилання не веде на точний лічильник цього коментаря.',
    YOUTUBE_COMMENT_SHORT_LINK_REQUIRED:'Спочатку скоротіть посилання та перевірте його перед схваленням.',
    YOUTUBE_COMMENT_GOOGLE_SHARE_REQUIRED:'Додайте посилання share.google, створене для адреси нашого лічильника.',
    YOUTUBE_COMMENT_GOOGLE_SHARE_UNVERIFIED:'Не вдалося підтвердити, що share.google веде саме на цей лічильник. Відправлення заблоковано.',
    YOUTUBE_COMMENT_NOT_VISIBLE:'Коментар більше не доступний через публічний API YouTube. Причина невідома.',
    YOUTUBE_COMMENT_LOOKUP_FAILED:'Не вдалося перевірити видимість через API YouTube.',
    YOUTUBE_COMMENT_LOOKUP_MISMATCH:'YouTube повернув коментар з іншим відео або автором.',
    YOUTUBE_COMMENT_AUTH_FAILED:'Не вдалося підготувати авторизацію YouTube.',
    YOUTUBE_OAUTH_NOT_CONFIGURED:'Налаштування OAuth YouTube відсутні або некоректні.',
    YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED:'Ключ шифрування токенів не налаштовано.',
    YOUTUBE_TOKEN_INVALID:'Не вдалося прочитати збережений токен YouTube.',
    YOUTUBE_TOKEN_REFRESH_FAILED:'YouTube не оновив токен доступу. Спробуйте пізніше.',
    YOUTUBE_TOKEN_REFRESH_REVOKED:'Google відхилив збережений дозвіл. Підключіть канал повторно.',
    YOUTUBE_TOKEN_REFRESH_CLIENT:'Google відхилив облікові дані OAuth застосунку.',
    YOUTUBE_COMMENT_WRONG_TARGET_CHANNEL:'Вихідне відео належить іншому каналу.',
    YOUTUBE_COMMENT_TARGET_UNVERIFIED:'Не вдалося підтвердити цільове відео через YouTube.',
    YOUTUBE_COMMENT_MAIN_EPISODE_REQUIRED:'Для цього Shorts оберіть вихідне відео. Окремий основний випуск до нього ще не прив’язано.',
    YOUTUBE_COMMENT_SHORT_NOT_PUBLIC:'Shorts має бути публічним і належати підключеному каналу.',
    YOUTUBE_COMMENT_APPROVAL_CHANGED:'Ціль, канал або посилання змінилися. Оновіть сторінку.',
    BUDGET_EXHAUSTED:'Ліміт Grok вичерпано. Ви можете написати коментар вручну.',
    YOUTUBE_COMMENT_SCOPE_REQUIRED:'Потрібен дозвіл YouTube на коментарі.',
    YOUTUBE_COMMENT_TEXT_INVALID:'Введіть текст коментаря без посилань (до 1200 символів).',
    YOUTUBE_COMMENTSDISABLED:'YouTube вимкнув коментарі до цього відео.',
    YOUTUBE_FORBIDDEN:'YouTube відмовив у публікації коментаря.',
    YOUTUBE_COMMENT_OUTCOME_UNKNOWN:'Результат невідомий. Перевірте коментарі на YouTube.',
  };
  const bins=useMemo(()=>{
    const end=new Date(data.chartEnd).getTime(),start=end-7*24*60*60*1000,step=3*60*60*1000,count=56;
    const values=Array.from({length:count},(_,i)=>({time:start+i*step,clicks:0}));
    for(const item of data.chart){const time=new Date(item.hour).getTime(),index=Math.floor((time-start)/step);if(index>=0&&index<count)values[index].clicks+=item.clicks;}
    const max=Math.max(1,...values.map(item=>item.clicks));
    const markers=data.publishedMarkers.map(item=>({x:(new Date(item.publishedAt).getTime()-start)/(end-start)*100,item})).filter(item=>item.x>=0&&item.x<=100);
    return {values,max,markers,start,end};
  },[data]);
  async function refresh(){const response=await fetch('/api/editorial/youtube-comments',{cache:'no-store'});if(!response.ok)throw Error('Не вдалося оновити статистику.');const body=await response.json();setData(body.data);}
  async function post(payload:Record<string,unknown>){setBusy(true);setMessage('');try{const response=await fetch('/api/editorial/youtube-comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const body=await response.json().catch(()=>null);if(!response.ok)throw Error(body?.error?.code??'Не вдалося зберегти.');if(payload.action==='tracking-probe'){const check=await fetch(body.data.url,{redirect:'manual',cache:'no-store'});if(![0,302].includes(check.status))throw Error('Не вдалося перевірити лічильник.');await refresh();setMessage('Тестовий перехід записано окремо від основного графіка.');return;}if(payload.action==='shorten'){setShortLinks(previous=>({...previous,[String(payload.id)]:body.data.url}));setMessage('Коротке посилання перевірено. Перевірте текст і схваліть публікацію.');return;}if(payload.action==='check-oauth'||payload.action==='check-published'){const code=body?.data?.code;if(payload.action==='check-published')await refresh();setMessage(code==='OK'?(payload.action==='check-oauth'?'OAuth працює. Канал підтверджено.':'Публічний API YouTube повернув цей коментар.'):errors[code]??code??'Не вдалося перевірити OAuth.');return;}await refresh();setMessage('Збережено.');}catch(error){setMessage(error instanceof Error?(errors[error.message]??error.message):'Сталася помилка.');}finally{setBusy(false);}}
  const needsScope=!data.connection?.commentScope;

  const published=data.comments.filter(item=>item.state==='published').map(item=>({item,visibility:commentStatus(item).visibility}));
  const filterCounts=Object.fromEntries(filterOrder.map(value=>[value,published.filter(row=>row.visibility?.value===value).length])) as Record<VisibilityFilter,number>;
  const visibleRows=visibilityFilter?published.filter(row=>row.visibility?.value===visibilityFilter):published;
  const filterHref=(value:VisibilityFilter|null)=>(value?`/editorial/youtube-comments?visibility=${value}`:'/editorial/youtube-comments')+'#visibility';

  return <div className="yc-dashboard">
    <nav className="yc-jump" aria-label="Розділи сторінки">
      <a href="#drafts">Чернетки й публікації</a>
      <a href="#visibility">Перевірка видимості</a>
      <a href="#clicks">Статистика переходів</a>
      {canManage&&<a href="#settings">Розклад і підключення</a>}
    </nav>
    {message&&<p className="yc-message" role="status">{message}</p>}

    {/* 1. Drafts and publications */}
    <section id="drafts" className="ed-section yc-section" aria-labelledby="drafts-title">
      <SectionHead id="drafts-title" title="Чернетки й публікації"
        meta="Клікабельність посилання залежить від YouTube. Перевірте її після публікації."
        action={canApprove&&data.connection&&<button type="button" disabled={busy}
          onClick={()=>void post({action:'check-oauth'})}>Перевірити OAuth YouTube</button>} />
      {needsScope&&<p className="yc-note yc-note-warning">Немає дозволу YouTube на коментарі, тому створення чернеток і публікацію вимкнено. <a href="#settings">Розклад і підключення</a></p>}
      {canApprove&&<form className="ed-card yc-draft-form" onSubmit={event=>{
        event.preventDefault();
        const form=new FormData(event.currentTarget);
        const generate=(event.nativeEvent as SubmitEvent).submitter?.getAttribute('value')==='grok';
        const selected=String(form.get('uploadId')??'');
        const source=selected.startsWith('publication:')?{publicationId:selected.slice(12)}:{uploadId:selected};
        void post({action:'draft',...source,targetKind:form.get('targetKind'),text:form.get('text'),generate});
      }}>
        <h3>Нова чернетка</h3>
        <label className="yc-field-wide">Shorts <select name="uploadId" required defaultValue="" onChange={event=>{
          if(event.target.value.startsWith('publication:'))setTargetKind('source');
        }}>
          <option value="" disabled>Оберіть публічний Shorts</option>
          {data.candidates.map(item=><option key={`${item.kind}:${item.id}`} value={item.kind==='publication'?`publication:${item.id}`:item.id}>{item.title} · {item.short_video_id}{item.kind==='publication'?' · YouTube Studio':''}</option>)}
        </select></label>
        <label>Ціль <select name="targetKind" value={targetKind} onChange={event=>setTargetKind(event.target.value)}><option value="main">Наш основний випуск</option><option value="source">Вихідне відео</option></select></label>
        <label className="yc-field-full">Текст українською <textarea name="text" maxLength={1200} /></label>
        <div className="ed-actions yc-field-full">
          <button disabled={busy||needsScope}>Створити чернетку</button>
          <button className="ed-primary" disabled={busy||needsScope} value="grok">Запропонувати текст через Grok</button>
        </div>
      </form>}
      {!data.comments.length&&<Empty unavailable>Коли буде опубліковано Shorts до основного відео, після ввімкнення розкладу Grok підготує чернетку.</Empty>}
      {data.comments.length>0&&<ol className="yc-list">{data.comments.map(item=>{
        const status=commentStatus(item),send=status.send,visibility=status.visibility;
        const hasActions=(item.state==='published'&&Boolean(item.youtube_comment_id))||(item.state==='published'&&canManage)||(item.can_recover&&canApprove)
          ||(item.state==='published'&&item.target_kind==='source'&&canManage&&item.public_visibility?.code!=='YOUTUBE_COMMENT_NOT_VISIBLE');
        return <li key={item.id}><article id={'comment-'+item.id} className="ed-card yc-comment" aria-labelledby={'comment-title-'+item.id}>
          <div className="yc-comment-main">
            <h3 id={'comment-title-'+item.id}>{item.episode_title||'Відео'}</h3>
            <p className="yc-source">
              <span><span className="yc-label">{targetLabel(item.target_kind)}:</span> <a href={watchUrl(item.parent_video_id)} target="_blank" rel="noreferrer">відкрити на YouTube</a></span>
              <span><span className="yc-label">Shorts:</span> <a href={shortsUrl(item.short_video_id)} target="_blank" rel="noreferrer">{item.short_video_id}</a></span>
            </p>
            <div className="yc-status">
              <span className="yc-label">Відправлення</span>
              <Badge tone={send.tone as Tone}>{send.label}</Badge>
              {item.published_at?<KyivTime value={item.published_at} />:item.scheduled_at?<span className="ed-meta">заплановано на <KyivTime value={item.scheduled_at} /></span>:null}
              {item.verification_pending&&item.state==='queued'&&<span className="ed-meta">Перевіряємо відео через YouTube</span>}
            </div>
            {visibility&&<div className="yc-status">
              <span className="yc-label">Видимість</span>
              <Badge tone={visibility.tone as Tone}>{visibility.label}</Badge>
              <span className="yc-reason">{visibility.reason}</span>
              <span className="ed-meta">{visibility.checkedAt?<>перевірено <KyivTime value={visibility.checkedAt} /></>:'ще не перевірялося'}</span>
            </div>}
            {item.public_visibility&&<p className={'yc-api-check'+(item.public_visibility.code==='OK'?'':' yc-warning-text')} role="status">
              Публічний API YouTube · <KyivTime value={item.public_visibility.checkedAt} /> · {item.public_visibility.code==='OK'?'Коментар доступний':errors[item.public_visibility.code]??item.public_visibility.code}
            </p>}
            {item.error_code&&<p className="yc-error" role="alert">{errors[item.error_code]??item.error_code}</p>}
          </div>
          <div className="yc-clicks">
            <strong>{item.click_count}</strong>
            <span>запитів до перенаправлення</span>
            {item.state==='published'&&<span className="ed-meta">тестових: {item.test_click_count??0} · останній: {stamp(item.last_click_at)}</span>}
          </div>

          {item.state==='succeeded'&&<div className="yc-approval yc-full">
            <blockquote><strong>Перевір текст із посиланням, який буде опубліковано:</strong><br/>{edits[item.id]?.trim()??item.draft_text}<br/><br/>
              <span>{(shortLinks[item.id]??item.prepared_short_link)?.trim() || `${data.shortLinkOrigin}/go/short/${encodeURIComponent(item.tracking_token)}`}</span></blockquote>
            {item.target_kind==='source'&&<p className="yc-note">Спочатку публікується текст без посилання.
              Після підтвердження видимості на перезавантаженій сторінці додається схвалене коротке посилання через наш лічильник.
              Потім сторінка перезавантажується для повторної перевірки.</p>}
            {item.target_kind==='source'&&<p className="yc-note">Натисніть «Скоротити посилання». Перевірене share.google має пріоритет; інакше використовується безкоштовний скорочувач. До схвалення ви побачите точну адресу.</p>}
            {canApprove&&<div className="yc-approve-form">
              <label className="yc-field-full">Текст коментаря <textarea maxLength={1200} value={edits[item.id]??item.draft_text??''}
                onChange={event=>setEdits(previous=>({...previous,[item.id]:event.target.value}))} /></label>
              <label className="yc-field-full">{item.target_kind==='source'?'Коротке посилання (Google — пріоритет)':'Коротке посилання TinyURL'} <input type="url" value={shortLinks[item.id]??item.prepared_short_link??''}
                onChange={event=>setShortLinks(previous=>({...previous,[item.id]:event.target.value}))} /></label>
              <div className="ed-actions yc-field-full">
                <button type="button" disabled={busy} onClick={()=>void post({action:'shorten',id:item.id,googleLink:shortLinks[item.id]?.trim()})}>Скоротити посилання</button>
                <button type="button" className="ed-primary" disabled={busy||!data.settings.enabled||needsScope||!(edits[item.id]??item.draft_text)?.trim()}
                  onClick={()=>void post({action:'approve',id:item.id,text:edits[item.id]??item.draft_text,
                    targetVideoId:item.parent_video_id,channelId:data.connection?.channelId,shortLink:(shortLinks[item.id]??item.prepared_short_link)?.trim(),
                    link:`${data.shortLinkOrigin}/go/short/${encodeURIComponent(item.tracking_token)}`})}>Схвалити й запланувати</button>
                <button type="button" disabled={busy||needsScope||!(edits[item.id]??item.draft_text)?.trim()}
                  onClick={()=>void post({action:'approve',id:item.id,publishNow:true,text:edits[item.id]??item.draft_text,
                    targetVideoId:item.parent_video_id,channelId:data.connection?.channelId,shortLink:(shortLinks[item.id]??item.prepared_short_link)?.trim(),
                    link:`${data.shortLinkOrigin}/go/short/${encodeURIComponent(item.tracking_token)}`})}>Схвалити й опублікувати</button>
                <button type="button" className="yc-danger-button" disabled={busy} onClick={()=>void post({action:'reject',id:item.id})}>Відхилити</button>
              </div>
              {!data.settings.enabled&&<p className="ed-meta yc-field-full">«Схвалити й запланувати» доступне, коли чергу схвалених коментарів увімкнено в розділі «Розклад і підключення».</p>}
            </div>}
          </div>}

          {hasActions&&<div className="yc-row-actions yc-full">
            {item.state==='published'&&item.youtube_comment_id&&<>
              <a className="ed-button" href={commentUrl(item)} target="_blank" rel="noreferrer">Відкрити коментар на YouTube</a>
              {canApprove&&<button type="button" disabled={busy}
                onClick={()=>void post({action:'check-published',id:item.id})}>Перевірити видимість</button>}
            </>}
            {item.state==='published'&&canManage&&<button type="button" disabled={busy} onClick={()=>void post({action:'tracking-probe',id:item.id})}>Перевірити лічильник (тест)</button>}
            {item.can_recover&&canApprove&&<button type="button" disabled={busy}
              onClick={()=>{
                const previousLink=item.final_text?.split('\n\n').at(-1);
                if(previousLink?.startsWith('https://tinyurl.com/'))
                  setShortLinks(previous=>({...previous,[item.id]:previousLink}));
                void post({action:'recover',id:item.id});
              }}>Повернути на схвалення</button>}
            {item.state==='published'&&item.target_kind==='source'&&canManage&&item.public_visibility?.code!=='YOUTUBE_COMMENT_NOT_VISIBLE'&&<details className="yc-replace">
              <summary>Замінити пряме посилання на коротке з обліком</summary>
              <p>Вставте точний поточний текст коментаря з прямою адресою Shorts. Спочатку перевіримо його видимість; потім замінимо посилання й перевіримо знову.</p>
              <label>Поточний текст<textarea value={edits[item.id]??''} onChange={e=>setEdits(previous=>({...previous,[item.id]:e.target.value}))}/></label>
              <div className="ed-actions">
                <button type="button" disabled={busy} onClick={()=>void post({action:'shorten',id:item.id})}>Підготувати коротке посилання</button>
                <button type="button" className="ed-primary" disabled={busy||!(shortLinks[item.id]??item.prepared_short_link)||!edits[item.id]?.trim()} onClick={()=>void post({action:'replace-published-link',id:item.id,currentText:edits[item.id],shortLink:shortLinks[item.id]??item.prepared_short_link,targetVideoId:item.parent_video_id,channelId:item.approved_channel_id})}>Схвалити заміну посилання</button>
              </div>
              <p>Посилання: {shortLinks[item.id]??item.prepared_short_link??'ще не підготовлено'}</p>
            </details>}
          </div>}

          <details className="ed-details yc-full">
            <summary>Деталі: текст, ідентифікатори, діагностика</summary>
            <div className="yc-details-body">
              {item.state!=='succeeded'&&item.draft_text&&<blockquote><strong>Текст чернетки з посиланням:</strong><br/>{edits[item.id]?.trim()??item.draft_text}<br/><br/>
                <span>{(shortLinks[item.id]??item.prepared_short_link)?.trim() || `${data.shortLinkOrigin}/go/short/${encodeURIComponent(item.tracking_token)}`}</span></blockquote>}
              {item.final_text&&<blockquote><strong>Точний схвалений текст:</strong><br/>{item.final_text}</blockquote>}
              <dl className="yc-facts">
                <div><dt>ID коментаря в редакції</dt><dd><code>{item.id}</code></dd></div>
                <div><dt>ID коментаря YouTube</dt><dd>{item.youtube_comment_id?<code>{item.youtube_comment_id}</code>:'—'}</dd></div>
                <div><dt>Токен лічильника</dt><dd><code>{item.tracking_token}</code></dd></div>
                <div><dt>Канал публікації</dt><dd>{item.approved_channel_id?<code>{item.approved_channel_id}</code>:data.connection?.channelTitle??'—'}</dd></div>
                <div><dt>{targetLabel(item.target_kind)}</dt><dd><code>{item.parent_video_id}</code></dd></div>
                <div><dt>Shorts</dt><dd><code>{item.short_video_id}</code></dd></div>
                <div><dt>Коротка адреса</dt><dd>{item.prepared_short_link?<SentLink value={item.prepared_short_link} />:'ще не підготовлена'}</dd></div>
                <div><dt>Адреса лічильника</dt><dd><code>{`${data.shortLinkOrigin}/go/short/${encodeURIComponent(item.tracking_token)}`}</code></dd></div>
              </dl>
              <dl className="yc-facts">
                <div><dt>Стан у системі</dt><dd>{labels[item.state]??item.state} · <code>{item.state}</code></dd></div>
                <div><dt>Етап публікації</dt><dd>{item.publication_steps?<>{stepLabels[item.publication_steps.phase]??item.publication_steps.phase} · <code>{item.publication_steps.phase}</code></>:'—'}</dd></div>
                {item.publication_steps&&<div><dt>Текст без посилання перевірено</dt><dd>{stamp(item.publication_steps.plain_verified_at)}</dd></div>}
                {item.publication_steps&&<div><dt>Текст із посиланням перевірено</dt><dd>{stamp(item.publication_steps.linked_verified_at)}</dd></div>}
                {item.publication_steps?.error_code&&<div><dt>Код помилки етапу</dt><dd><code>{item.publication_steps.error_code}</code></dd></div>}
                {item.error_code&&<div><dt>Код помилки</dt><dd><code>{item.error_code}</code></dd></div>}
                {item.public_visibility&&<div><dt>Публічний API YouTube</dt><dd><code>{item.public_visibility.code}</code> · {stamp(item.public_visibility.checkedAt)}</dd></div>}
                {item.state==='published'&&<div><dt>Запити до лічильника</dt><dd>{item.click_count} (тестових: {item.test_click_count??0}, некласифікованих: {item.click_count-(item.test_click_count??0)}) · останній: {stamp(item.last_click_at)}</dd></div>}
                {item.state==='published'&&<div><dt>Підтвердження нового посилання</dt><dd>{item.publication_steps?.phase==='verified'?'підтверджено після перезавантаження':'ще не підтверджено'}. Попередні відкриття прямої адреси Shorts не відстежувалися.</dd></div>}
              </dl>
            </div>
          </details>
        </article></li>;
      })}</ol>}
    </section>

    {/* 2. Visibility check */}
    <section id="visibility" className="ed-section yc-section" aria-labelledby="visibility-title">
      <SectionHead id="visibility-title" title="Перевірка видимості"
        meta="Опубліковані коментарі: коли YouTube API прийняв коментар і чи підтверджено його видимість після перезавантаження сторінки. Час за Києвом." />
      <nav className="yc-chips" aria-label="Фільтр за видимістю">
        <Link href={filterHref(null)} scroll={false} aria-current={visibilityFilter===null?'true':undefined}>Усі <span>{published.length}</span></Link>
        {filterOrder.map(value=><Link key={value} href={filterHref(value)} scroll={false} aria-current={visibilityFilter===value?'true':undefined}>
          {visibilityLabels[value]} <span>{filterCounts[value]}</span>
        </Link>)}
      </nav>
      {visibleRows.length?<div className="ed-table-wrap"><table className="ed-table yc-vis-table">
        <thead><tr><th scope="col">Shorts</th><th scope="col">Ціль</th><th scope="col">Прийнято YouTube API</th><th scope="col">Видимість</th><th scope="col">Остання перевірка</th><th scope="col">Коментар на YouTube</th></tr></thead>
        <tbody>{visibleRows.map(({item,visibility})=><tr key={item.id}>
          <td data-label="Shorts"><a href={shortsUrl(item.short_video_id)} target="_blank" rel="noreferrer">{item.short_video_id}</a>
            <small className="yc-cell-sub"><a href={'#comment-'+item.id}>{item.episode_title||'Відео'}</a></small></td>
          <td data-label="Ціль" className="yc-nowrap"><a href={watchUrl(item.parent_video_id)} target="_blank" rel="noreferrer">{targetLabel(item.target_kind)}</a></td>
          <td data-label="Прийнято YouTube API"><KyivTime value={item.published_at} /></td>
          <td data-label="Видимість">{visibility?<><Badge tone={visibility.tone as Tone}>{visibility.label}</Badge><small className="yc-cell-sub">{visibility.reason}</small></>:'—'}</td>
          <td data-label="Остання перевірка"><KyivTime value={visibility?.checkedAt} /></td>
          <td data-label="Коментар на YouTube"><div className="yc-cell-actions">
            {item.youtube_comment_id?<a href={commentUrl(item)} target="_blank" rel="noreferrer">Відкрити коментар</a>:<span className="ed-meta">ID ще невідомий</span>}
            {item.state==='published'&&item.youtube_comment_id&&canApprove&&<button type="button" disabled={busy}
              onClick={()=>void post({action:'check-published',id:item.id})}>Перевірити видимість</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>:<Empty unavailable>{visibilityFilter?'Немає коментарів із таким статусом':'Опублікованих коментарів ще немає.'}</Empty>}
    </section>

    {/* 3. Click statistics */}
    <section id="clicks" className="ed-section yc-section" aria-labelledby="clicks-title">
      <SectionHead id="clicks-title" title="Статистика переходів"
        meta="Останні 7 днів · час за Києвом · одиниця — запити до перенаправлення (позначені тести виключено)" />
      <div className="ed-card yc-chart">
        <p className="yc-chart-unit">Запити до перенаправлення за кожні 3 години</p>
        <div className="yc-chart-wrap"><svg viewBox="0 0 1000 260" role="img" aria-label="Графік запитів до перенаправлення з коментарів за останні 7 днів, час за Києвом">
          {[0,1,2,3].map(line=><line key={line} x1="48" x2="985" y1={24+line*62} y2={24+line*62} className="yc-chart-grid" />)}
          <text x="40" y="36" textAnchor="end">{bins.max}</text><text x="40" y="212" textAnchor="end">0</text>
          {bins.values.map((bin,index)=>{const width=937/bins.values.length,bar=Math.max(1,bin.clicks/bins.max*176);return <rect key={index} x={48+index*width+1} y={208-bar} width={Math.max(2,width-2)} height={bar} rx="2" className="yc-chart-bar"><title>{`${stamp(new Date(bin.time).toISOString())}: ${bin.clicks} запитів до перенаправлення`}</title></rect>;})}
          {bins.markers.map(({x,item})=><g key={item.id}><line x1={48+x*9.37} x2={48+x*9.37} y1="18" y2="218" className="yc-chart-publish"/><circle cx={48+x*9.37} cy="16" r="5" className="yc-chart-publish-dot"><title>{`Коментар опубліковано ${stamp(item.publishedAt)} · відео ${item.parentVideoId} · Shorts ${item.shortVideoId} · ${item.clicks} запитів до перенаправлення`}</title></circle></g>)}
          <text x="48" y="246">{stamp(new Date(bins.start).toISOString())}</text><text x="985" y="246" textAnchor="end">Зараз</text>
        </svg></div>
        <p className="yc-chart-legend"><span><i aria-hidden="true" /> запити до перенаправлення</span><span><b aria-hidden="true" /> час публікації коментаря (пунктир)</span></p>
        <p className="ed-meta">Рахуються запити до перенаправлення, а не унікальні люди: попередній перегляд посилання чи повторне натискання теж може враховуватися.</p>
      </div>
      <div className="ed-card yc-history">
        <h3>Історична статистика перенаправлень (за весь час)</h3>
        <dl className="yc-stats">
          <div><dt>Некласифіковані запити</dt><dd>{data.totalClicks-data.testClicks}</dd></div>
          <div><dt>Тестові запити</dt><dd>{data.testClicks}</dd></div>
          <div><dt>Усього запитів</dt><dd>{data.totalClicks}</dd></div>
        </dl>
        <p className="ed-meta">Ці числа не обмежені сімома днями графіка й охоплюють усі коментарі від початку обліку.</p>
      </div>
    </section>

    {/* 4. Schedule and connection */}
    <section id="settings" className="ed-section yc-section" aria-labelledby="settings-title">
      <SectionHead id="settings-title" title="Розклад і підключення"
        meta="За один інтервал вийде не більше одного коментаря. Нові тексти Grok не публікуються без схвалення редактора." />
      <div className="yc-settings-grid">
        <div className="ed-card yc-settings-card">
          <h3>Підключення YouTube</h3>
          <p>{data.connection?<>Канал: <strong>{data.connection.channelTitle}</strong></>:<strong>Канал YouTube не підключено</strong>}</p>
          <p><Badge tone={needsScope?'warning':'success'}>{needsScope?'Дозволу на коментарі немає':'Дозвіл на коментарі надано'}</Badge></p>
          {needsScope&&<p role="status">Для коментарів потрібна окрема згода YouTube. Читання статистики та завантаження відео працюють за чинним дозволом.</p>}
          {needsScope&&<Link className="ed-button ed-primary" href="/api/youtube/oauth/start?comments=1">Надати дозвіл на коментарі YouTube</Link>}
        </div>
        <div className="ed-card yc-settings-card">
          <h3>Розклад публікації</h3>
          <dl className="yc-facts">
            <div><dt>Черга схвалених коментарів</dt><dd><Badge tone={data.settings.enabled?'success':'neutral'}>{data.settings.enabled?'Увімкнено':'Вимкнено'}</Badge></dd></div>
            <div><dt>Інтервал між публікаціями</dt><dd>{data.settings.interval_hours} год</dd></div>
          </dl>
          {canManage&&<div className="yc-settings-form">
            <label className="yc-inline-field">Інтервал, годин
              <input type="number" min={3} max={168} value={hours} onChange={event=>setHours(Number(event.target.value))} />
            </label>
            <label className="yc-check"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)} /> Увімкнути чергу схвалених коментарів</label>
            {enabled&&<label className="yc-check"><input type="checkbox" checked={consented} onChange={event=>setConsented(event.target.checked)} />
              Я дозволяю публікацію тільки схвалених редактором коментарів від імені каналу {data.connection?.channelTitle??'YouTube'}.</label>}
            <div className="ed-actions">
              <button type="button" className="ed-primary" disabled={busy||needsScope||(enabled&&!consented)} onClick={()=>void post({action:'settings',enabled,intervalHours:hours,confirmed:consented})}>
                {busy?'Зберігаємо…':'Зберегти розклад'}
              </button>
            </div>
          </div>}
          {!canManage&&<p className="ed-meta">Змінювати розклад може адміністратор.</p>}
          <p className="ed-meta">Інтервал за замовчуванням — 3 години; мінімум також 3 години, щоб не перетворювати коментарі на частий повторюваний потік. Він розділяє публікації глобально. Нова настройка діє для майбутніх схвалень; уже запланований час не пересувається.</p>
        </div>
      </div>
    </section>
  </div>;
}
