'use client';

import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {Episode} from './workflow-types';
import {VideoAuditPanel} from './video-audit-panel';

type TikTokPublication={id:string;state:'ready_to_publish'|'published'|'failed';tiktok_url:string|null;published_at:string|null;
  ai_disclosed:boolean;sha256:string;title:string;description:string;error_note:string|null;created_at:string};
type Short={id:string;media_revision_id:string;episode_version:number;manifest:{hook:string;title:string;description:string;clips:{startMs:number;endMs:number}[]};
  montage_plan_id:string|null;montage_plan_version:number|null;
  state:string;expected_bytes:number|null;sha256:string|null;error_code:string|null;expires_at:string;created_at:string;
  technical_report:{durationMs:number;width:number;height:number;videoCodec:string;audioCodec:string;integratedLufs:number;truePeakDbtp:number;silence:{startMs:number;endMs:number}[]}|null;
  audit_media_revision_id:string|null;youtube_upload_id:string|null;youtube_upload_state:string|null;youtube_video_id:string|null;
  youtube_privacy_status:string|null;youtube_processing_status:string|null;youtube_actual_privacy_status:string|null;youtube_error_code:string|null;
  youtube_upload_offset:number|null;youtube_total_bytes:number|null;youtube_ai_disclosed:boolean|null;youtube_actual_ai_disclosed:boolean|null;
  youtube_stats:{views:string|null;likes:string|null;comments:string|null;fetched_at:string;error_code:string|null}|null;
  tiktok_publication:TikTokPublication|null};
type Source={id:string;episode_version:number;state:string};
export type MontagePlanOption={id:string;name:string;version:number;spec:Record<string,unknown>};
const labels:Record<string,string>={queued:'У черзі',rendering:'Збирається FFmpeg',technical_check:'FFmpeg перевіряє готовий файл',ready:'Чернетка пройшла технічну перевірку',failed:'Помилка складання або технічної перевірки',expired:'Термін зберігання минув'};
const seconds=(milliseconds:number)=>(milliseconds/1000).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');

function downloadTikTokCaption(shortId: string, publication: TikTokPublication) {
  const caption = [publication.title, publication.description].filter(Boolean).join('\n\n');
  const url = URL.createObjectURL(new Blob([caption + '\n'], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = `tiktok-${shortId}-caption.txt`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function request<T>(url:string,method='GET',body?:object):Promise<T>{
  const response=await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const json=await response.json();
  if(!response.ok) throw Error(json.error?.code??'REQUEST_FAILED');
  return json.data;
}

export function ShortsPanel({episode,sources,items,plans,canCreate,canReview,canPublish}:{episode:Episode;sources:Source[];items:Short[];plans:MontagePlanOption[];canCreate:boolean;canReview:boolean;canPublish:boolean}){
  const router=useRouter();
  const formRef=useRef<HTMLFormElement>(null);
  const [busy,setBusy]=useState(false);
  const [suggesting,setSuggesting]=useState(false);
  const [message,setMessage]=useState('');
  const [suggestion,setSuggestion]=useState('');
  const base=`/api/episodes/${episode.id}/shorts`;
  const usablePlans=plans.filter(plan=>plan.spec.format==='9:16'&&Number(plan.spec.targetDurationSec)>=30&&Number(plan.spec.targetDurationSec)<=60);
  const active=items.some(item=>['queued','rendering','technical_check'].includes(item.state)
    ||['queued','uploading','processing','unknown'].includes(item.youtube_upload_state??''));
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>router.refresh(),5000);return()=>clearInterval(timer);},[active,router]);
  async function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;
    const form=new FormData(event.currentTarget);
    const clips=String(form.get('clips')??'').split(',').map(part=>{
      const [start,end]=part.split('-').map(Number);
      return {startMs:Math.round(start*1000),endMs:Math.round(end*1000)};
    });
    setBusy(true);setMessage('');
    try{
      const planId=String(form.get('montagePlanId')??''),plan=usablePlans.find(item=>item.id===planId);
      if(!plan)throw Error('MONTAGE_PLAN_FORMAT_UNSUPPORTED');
      const created=await request<{id:string}>(base,'POST',{mediaId:form.get('mediaId'),montagePlanId:plan.id,montagePlanVersion:plan.version,manifest:{
        hook:form.get('hook'),title:form.get('title'),description:form.get('description'),clips,subtitles:form.get('subtitles'),
      }});
      await request(`${base}/${created.id}`);router.refresh();
    }catch(error){const code=(error as Error).message;setMessage(code==='SHORTS_DURATION_INVALID'?'Загальна тривалість вибраних фрагментів має бути 30–60 секунд.'
      :code==='SHORTS_INVALID_SUBTITLES'?'Перевірте українські субтитри SRT: нумерацію, часкод і межі 30–60 секунд.'
      :'Не вдалося створити Shorts. Перевірте фрагменти й стан джерела.');}
    finally{setBusy(false);}
  }
  async function suggest(){
    const form=formRef.current;
    if(!form||suggesting)return;
    const fields=new FormData(form),mediaId=String(fields.get('mediaId')??''),planId=String(fields.get('montagePlanId')??''),plan=usablePlans.find(item=>item.id===planId);
    if(!mediaId||!plan)return;
    setSuggesting(true);setMessage('');setSuggestion('');
    try{
      const result=await request<{manifest:{hook:string;title:string;description:string;clips:{startMs:number;endMs:number}[]};
        reasons:string[];spentMicros:number}>(base,'POST',{action:'suggest',mediaId,montagePlanId:plan.id,montagePlanVersion:plan.version,requestId:crypto.randomUUID()});
      (form.elements.namedItem('hook') as HTMLInputElement).value=result.manifest.hook;
      (form.elements.namedItem('title') as HTMLInputElement).value=result.manifest.title;
      (form.elements.namedItem('description') as HTMLTextAreaElement).value=result.manifest.description;
      (form.elements.namedItem('clips') as HTMLInputElement).value=result.manifest.clips
        .map(clip=>`${seconds(clip.startMs)}-${seconds(clip.endMs)}`).join(', ');
      setSuggestion(`Gemini використав «${plan.name}», версія ${plan.version} (${(result.spentMicros/1_000_000).toFixed(4)} $). Перевірте пропозицію й за потреби змініть її до пробного рендеру.`);
    }catch{setMessage('Gemini не повернув перевірену пропозицію. Спробуйте пізніше або відредагуйте фрагменти вручну.');}
    finally{setSuggesting(false);}
  }
  async function publish(event:React.FormEvent<HTMLFormElement>,item:Short,manual=false){
    event.preventDefault();if(busy)return;
    const form=new FormData(event.currentTarget);setBusy(true);setMessage('');
    try{
      await request(`/api/episodes/${episode.id}/shorts/${item.id}/youtube-upload`,'POST',{
        ...(manual?{action:'register-manual',url:form.get('url')}:{}),
        title:form.get('title'),description:form.get('description'),privacyStatus:form.get('privacyStatus'),
        idempotencyKey:crypto.randomUUID(),reviewedSha256:item.sha256,confirmed:form.has('confirmed'),
        aiDisclosureConfirmed:form.has('aiDisclosureConfirmed'),
      });
      router.refresh();
    }catch(error){
      const code=(error as Error).message;
      setMessage(code==='YOUTUBE_OAUTH_NOT_CONFIGURED'||code==='YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED'
        ?'OAuth YouTube ще не налаштований у Production.'
        :code==='YOUTUBE_CHANNEL_NOT_CONNECTED'?'Спершу підключіть YouTube-канал у головному розділі редакції.'
        :code==='YOUTUBE_MANUAL_CHANNEL_MISMATCH'?'Посилання не веде на відео підключеного каналу.'
        :code==='YOUTUBE_PRIVACY_MISMATCH'?'Видимість у YouTube Studio не збігається з вибраною.'
        :code==='YOUTUBE_AI_DISCLOSURE_MISMATCH'?'YouTube не підтвердив позначку синтетичного контенту.'
        :code==='YOUTUBE_STATUS_UNAVAILABLE'?'Не вдалося підтвердити стан відео. Дочекайтеся обробки й повторіть.'
        :code==='YOUTUBE_RELEASE_APPROVAL_REQUIRED'?'Точний Shorts-файл ще не пройшов повний аудит і допуск редактора.'
        :'Не вдалося створити завантаження. Перевірте підключення каналу та допуск цього файлу.');
    }finally{setBusy(false);}
  }
  async function tiktokAction(event:React.FormEvent<HTMLFormElement>,item:Short,action:'prepare'|'register'|'fail'){
    event.preventDefault();if(busy)return;
    const form=new FormData(event.currentTarget);setBusy(true);setMessage('');
    try{
      const payload:Record<string,unknown>={action,reviewedSha256:item.sha256,confirmed:form.has('confirmed')};
      if(action==='prepare')payload.aiDisclosureConfirmed=form.has('aiDisclosureConfirmed');
      if(action==='register'){
        payload.url=form.get('url');payload.publishedAt=new Date(String(form.get('publishedAt')??'')).toISOString();
        payload.aiDisclosureConfirmed=form.has('aiDisclosureConfirmed');
      }
      if(action==='fail')payload.note=form.get('note');
      await request(`/api/episodes/${episode.id}/shorts/${item.id}/tiktok-publication`,'POST',payload);
      router.refresh();
    }catch(error){
      const code=(error as Error).message;
      setMessage(code==='TIKTOK_RELEASE_APPROVAL_REQUIRED'?'Цей точний MP4 ще не пройшов повний аудит і редакторський допуск.'
        :code==='TIKTOK_MEDIA_CONFIRMATION_REQUIRED'?'Файл змінився після підготовки. Звірте SHA-256 і створіть пакет повторно.'
        :code==='TIKTOK_INVALID_URL'?'Вставте повне публічне посилання TikTok на відео, наприклад https://www.tiktok.com/@handle/video/1234567890123456789.'
        :code==='TIKTOK_PUBLICATION_CONFLICT'?'Це посилання вже зареєстроване або цей Shorts має іншу зареєстровану публікацію. Звірте посилання і час.'
        :code==='TIKTOK_PACKAGE_REQUIRED'?'Спершу підготуйте пакет ручної публікації.'
        :code==='TIKTOK_DISCLOSURE_REQUIRED'?'Підтвердьте, що позначку AI-контенту ввімкнено у TikTok.'
        :'Не вдалося зберегти стан TikTok. Перевірте дані та права видавця.');
    }finally{setBusy(false);}
  }
  const uploadLabels:Record<string,string>={queued:'YouTube: у черзі',uploading:'YouTube: завантаження можна продовжити',
    processing:'YouTube обробляє відео',published:'YouTube: завантаження й видимість підтверджені',
    failed:'YouTube відхилив завантаження або перевірку',unknown:'YouTube: перевіряємо результат без повторного завантаження'};
  return <section>
    <h5>Shorts · вертикальний чернетковий монтаж</h5>
    <p>Виберіть монтажний план і перевірену медіаревізію. Це приватна тестова генерація MP4; нічого не публікується. FFmpeg склеює вибрані фрагменти, накладає SRT-субтитри на зібраний таймлайн і показує прямокутний штамп обраного плану в останні 2 секунди. Український переклад субтитрів редактор перевіряє та вставляє вручну. Ілюстрації ще не накладаються.</p>
    {canCreate&&<>
    <form ref={formRef} onSubmit={submit}>
      {usablePlans.length===0?<p>Немає активного плану Shorts на 30–60 секунд.</p>:<label>Монтажний план <select name="montagePlanId" required defaultValue={usablePlans[0].id}>
        {usablePlans.map(plan=><option key={plan.id} value={plan.id}>{plan.name} · v{plan.version} · {String(plan.spec.targetDurationSec)} с</option>)}
      </select></label>}
      <label>Відео-джерело <select name="mediaId" required defaultValue="">
        <option value="" disabled>Оберіть перевірений файл</option>
        {sources.filter(item=>item.state==='passed'&&item.episode_version===episode.version).map(item=>
          <option key={item.id} value={item.id}>Медіаревізія · {item.id.slice(0,8)}</option>)}
      </select></label>
      <button type="button" disabled={suggesting||busy||!usablePlans.length} onClick={()=>void suggest()}>
        {suggesting?'Gemini аналізує сценарій…':'Скласти план із Gemini за обраним шаблоном'}
      </button>
      <label>Фрагменти, с <input name="clips" required defaultValue="0-35" placeholder="12-28, 54-72" /></label>
      <label>Початкова фраза <input name="hook" required maxLength={160} /></label>
      <label>Заголовок <input name="title" required maxLength={100} /></label>
      <label>Опис <textarea name="description" required maxLength={2000} /></label>
      <label>Українські субтитри SRT<textarea name="subtitles" rows={8} maxLength={20000}
        placeholder={'1\n00:00:00,000 --> 00:00:03,000\nПеревірений український переклад цитати.'}/></label>
      <p>Часкоди вказуйте від початку склеєного Shorts; поле можна лишити порожнім. Зараз автоперекладу й синхронізації SRT немає.</p>
      <button disabled={busy||!usablePlans.length||!sources.some(item=>item.state==='passed'&&item.episode_version===episode.version)}>
        {busy?'Передаємо в чергу…':'Згенерувати тестовий MP4'}
      </button>
    </form>
    </>}
    {suggestion&&<p role="status">{suggestion}</p>}
    {message&&<p role="status">{message}</p>}
    {items.length>0&&<ol>{items.map(item=><li key={item.id}>
      <strong>{labels[item.state]??item.state}</strong> · {item.manifest.title} · {Math.round(item.manifest.clips.reduce((n,c)=>n+c.endMs-c.startMs,0)/1000)} с
      {item.montage_plan_id&&<p>План {plans.find(plan=>plan.id===item.montage_plan_id)?.name??item.montage_plan_id.slice(0,8)} · версія {item.montage_plan_version}</p>}
      {item.error_code&&<p>Код помилки: {item.error_code}</p>}
      {item.state==='ready'&&<>
        <p><a href={`${base}/${item.id}/download`} target="_blank" rel="noreferrer">Відкрити приватний MP4</a></p>
        {item.technical_report&&<details><summary>Повна технічна перевірка FFmpeg</summary>
          <p>{item.technical_report.width}×{item.technical_report.height} · {item.technical_report.durationMs/1000} с · {item.technical_report.videoCodec}/{item.technical_report.audioCodec}</p>
          <p>{item.technical_report.integratedLufs} LUFS · {item.technical_report.truePeakDbtp} dBTP</p>
          {item.technical_report.silence.length>0?<ul>{item.technical_report.silence.map(part=><li key={part.startMs}>Тиша {part.startMs/1000}–{part.endMs/1000} с</li>)}</ul>:<p>Тривалих тихих ділянок FFmpeg не виявив.</p>}
        </details>}
        {item.audit_media_revision_id&&<VideoAuditPanel short endpoint={`/api/episodes/${episode.id}/montages/${item.audit_media_revision_id}/audits`}
          canRun={canCreate} canReview={canReview} />}
        {item.state==='ready'&&<aside className="workflow-card" aria-label="Ручна публікація в TikTok">
          <strong>TikTok — обов’язкова ручна позначка AI-контенту</strong>
          <p>Під час завантаження цього MP4 відкрийте «More options / Додаткові параметри» і ввімкніть «AI-generated content / Контент, створений ШІ» до натискання «Опублікувати».</p>
          <p>Завантажуйте саме цей перевірений файл. Публікація через TikTok API не підключена: спочатку завантажте й опублікуйте ролик вручну, потім зареєструйте посилання нижче.</p>
          <a href="https://support.tiktok.com/en/using-tiktok/creating-videos/ai-generated-content/" target="_blank" rel="noreferrer">Офіційна інструкція TikTok</a>
          {canPublish&&(!item.tiktok_publication||item.tiktok_publication.state==='failed')&&item.sha256&&item.audit_media_revision_id&&<details>
            <summary>{item.tiktok_publication?'Підготувати повторне завантаження':'Підготувати ручну публікацію'}</summary>
            <p>Підготовка фіксує точний допущений файл, заголовок та опис. Вона нічого не завантажує й не публікує.</p>
            <p>Заголовок для TikTok: <strong>{item.manifest.title}</strong></p>
            {item.manifest.description&&<p style={{whiteSpace:'pre-wrap'}}>{item.manifest.description}</p>}
            <p>SHA-256: <code>{item.sha256}</code></p>
            <form onSubmit={event=>void tiktokAction(event,item,'prepare')}>
              <label><input type="checkbox" name="aiDisclosureConfirmed" required /> Підтверджую: цей ролик створено за допомогою ШІ, і під час ручного завантаження я ввімкну відповідну позначку TikTok.</label>
              <label><input type="checkbox" name="confirmed" required /> Перевірив цей MP4, заголовок та опис; підготувати пакет для ручної публікації.</label>
              <button disabled={busy}>{busy?'Зберігаємо…':'Підготувати пакет'}</button>
            </form>
          </details>}
          {canPublish&&item.tiktok_publication?.state==='ready_to_publish'&&<div>
            <p><strong>Пакет готовий до ручного завантаження.</strong> Переконайтеся, що під час публікації позначка AI-контенту ввімкнена. Після успіху вставте посилання на опубліковане відео.</p>
            <p>Звірений SHA-256: <code>{item.tiktok_publication.sha256}</code></p>
            <p>Заголовок для TikTok: <strong>{item.tiktok_publication.title}</strong></p>
            {item.tiktok_publication.description&&<p>Опис для TikTok: {item.tiktok_publication.description}</p>}
            <p><a href={`${base}/${item.id}/tiktok-download`}>Завантажити MP4 з пакета TikTok</a></p>
            <p><button type="button" onClick={()=>{
              if(item.tiktok_publication) downloadTikTokCaption(item.id,item.tiktok_publication);
            }}>Завантажити підпис для TikTok (.txt)</button></p>
            <form onSubmit={event=>void tiktokAction(event,item,'register')}>
              <label>Публічне посилання TikTok <input name="url" type="url" required placeholder="https://www.tiktok.com/@handle/video/…" /></label>
              <label>Час публікації (місцевий час) <input name="publishedAt" type="datetime-local" required /></label>
              <label><input type="checkbox" name="aiDisclosureConfirmed" required /> Підтверджую, що позначку «AI-generated content» фактично ввімкнено в TikTok.</label>
              <label><input type="checkbox" name="confirmed" required /> Підтверджую, що саме цей файл опубліковано за вказаним посиланням.</label>
              <button disabled={busy}>{busy?'Зберігаємо…':'Зареєструвати публікацію'}</button>
            </form>
            <details><summary>Завантаження завершилося помилкою</summary>
              <form onSubmit={event=>void tiktokAction(event,item,'fail')}>
                <label>Що сталося? <textarea name="note" required maxLength={1000} /></label>
                <label><input type="checkbox" name="confirmed" required /> Підтверджую, що відео не опубліковане за цим пакетом.</label>
                <button disabled={busy}>Зафіксувати помилку та дозволити повтор</button>
              </form>
            </details>
          </div>}
          {item.tiktok_publication?.state==='published'&&<p><strong>TikTok: опубліковано</strong>{item.tiktok_publication.published_at&&<> · {new Date(item.tiktok_publication.published_at).toLocaleString('uk-UA')}</>} · AI-позначку підтверджено вручну. <a href={item.tiktok_publication.tiktok_url??'#'} target="_blank" rel="noreferrer">Відкрити відео</a></p>}
          {canPublish&&item.tiktok_publication?.state==='failed'&&<p role="status">Попереднє ручне завантаження не завершилося: {item.tiktok_publication.error_note}. Перевірте стан TikTok перед повтором.</p>}
          {item.tiktok_publication&&<p>Стан TikTok: {item.tiktok_publication.state==='published'?'опубліковано':item.tiktok_publication.state==='failed'?'помилка':'готовий до ручної публікації'}</p>}
        </aside>}
        {item.youtube_upload_state&&<div className="workflow-card">
          <p><strong>{uploadLabels[item.youtube_upload_state]??item.youtube_upload_state}</strong>
            {item.youtube_actual_privacy_status&&<> · видимість: {item.youtube_actual_privacy_status}</>}
            {item.youtube_ai_disclosed&&<> · AI-позначка YouTube: {item.youtube_actual_ai_disclosed===true?'підтверджена':item.youtube_actual_ai_disclosed===false?'не підтверджена':'очікує перевірки'}</>}
            {item.youtube_processing_status&&<> · статус: {item.youtube_processing_status}</>}</p>
          {item.youtube_video_id&&<p><a href={`https://www.youtube.com/shorts/${item.youtube_video_id}`} target="_blank" rel="noreferrer">Відкрити Short на YouTube</a></p>}
          {item.youtube_stats&&!item.youtube_stats.error_code&&<p>Перегляди {Number(item.youtube_stats.views??0).toLocaleString('uk-UA')} · вподобання {Number(item.youtube_stats.likes??0).toLocaleString('uk-UA')} · коментарі {Number(item.youtube_stats.comments??0).toLocaleString('uk-UA')}</p>}
          {item.youtube_upload_state==='unknown'&&<p>Нова копія не створюється: система спочатку звіряє стан resumable-сесії.</p>}
          {item.youtube_error_code&&<p>Код стану: {item.youtube_error_code}</p>}
          {item.youtube_error_code==='YOUTUBE_AI_DISCLOSURE_MISMATCH'&&<p role="alert">YouTube не підтвердив AI-позначку. Цей upload позначено як помилковий; публікацію не вважати завершеною.</p>}
        </div>}
        {canPublish&&item.audit_media_revision_id&&item.sha256&&!item.youtube_upload_id&&<details>
          <summary>Завантажити допущений Shorts на YouTube</summary>
          <form onSubmit={event=>void publish(event,item)}>
            <label>Заголовок <input name="title" maxLength={100} required defaultValue={item.manifest.title} /></label>
            <label>Опис <textarea name="description" maxLength={5000} defaultValue={item.manifest.description} /></label>
            <label>Видимість <select name="privacyStatus" required defaultValue="private">
              <option value="private">Приватне</option><option value="unlisted">За посиланням</option><option value="public">Публічне</option>
            </select></label>
            <p>Завантажиться перевірений файл із SHA-256 <code>{item.sha256}</code>. Разом із ним YouTube отримає позначку про змінений або синтетичний контент.</p>
            <label><input type="checkbox" name="aiDisclosureConfirmed" required /> Підтверджую, що це AI-створений матеріал і YouTube має показати відповідну позначку.</label>
            <label><input type="checkbox" name="confirmed" required /> Підтверджую цей файл, текст і вибрану видимість.</label>
            <button disabled={busy}>{busy?'Передаємо завдання…':'Підтвердити й завантажити'}</button>
          </form>
        </details>}
        {canPublish&&item.audit_media_revision_id&&item.sha256&&!item.youtube_upload_id&&<details>
          <summary>Зареєструвати Shorts, завантажений через YouTube Studio</summary>
          <p><a href={`${base}/${item.id}/download`} target="_blank" rel="noreferrer">Відкрити допущений MP4</a></p>
          <form onSubmit={event=>void publish(event,item,true)}>
            <label>Посилання YouTube <input name="url" type="url" required /></label>
            <label>Видимість <select name="privacyStatus" defaultValue="private">
              <option value="private">Приватне</option><option value="unlisted">За посиланням</option><option value="public">Публічне</option>
            </select></label>
            <label><input type="checkbox" name="confirmed" required /> Підтверджую, що завантажив саме файл із SHA-256 <code>{item.sha256}</code>.</label>
            <label><input type="checkbox" name="aiDisclosureConfirmed" required /> Підтверджую, що увімкнув позначку синтетичного контенту в YouTube Studio.</label>
            <button disabled={busy}>Перевірити й зареєструвати посилання</button>
          </form>
        </details>}
      </>}
      {item.sha256&&<p>SHA-256: <code>{item.sha256}</code></p>}
    </li>)}</ol>}
  </section>;
}
