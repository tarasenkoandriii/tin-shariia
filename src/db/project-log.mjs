import {activeMember} from '../access/membership.mjs';

export const logProcesses={captions:'Субтитри YouTube',gemini:'Аналіз Gemini',grok:'Перевірка Grok',render:'Монтаж і Shorts',upload:'Публікація YouTube',comments:'Коментарі YouTube',editorial:'Редакційні рішення',links:'Короткі посилання'};
const states={queued:'У черзі',running:'Виконується',done:'Завершено',succeeded:'Завершено',accepted:'Прийнято',failed:'Помилка',unknown:'Результат невідомий — потрібна перевірка',submitting:'Передається провайдеру',submitted:'Обробляється провайдером',rendering:'Збирається відео',ready:'Відео готове',expired:'Термін дії минув',uploading:'Завантажується',processing:'YouTube обробляє відео',published:'Опубліковано',scheduled:'Заплановано',publishing:'Відправляється',rejected:'Відхилено',checking:'Технічна перевірка',passed:'Перевірку пройдено',waiting_plain:'Перевірка видимості тексту без посилання',link_ready:'Текст видимий — очікується додавання посилання',link_sending:'Додавання посилання',waiting_link:'Перевірка видимості після додавання посилання',verified:'Видимість із посиланням підтверджено',blocked:'Видимість не підтверджено',create:'Створено',edit:'Збережено нову версію',submit:'Передано на перевірку',approve:'Схвалено',return:'Повернуто на доопрацювання',withdraw:'Відкликано',drafted:'Чернетку збережено',approved:'Точний текст і посилання схвалено',session_started:'Почато завантаження',chunk_accepted:'Частину відео прийнято',disconnected:'Канал від’єднано',prepared:'Коротке посилання підготовлено'};
const explanations={
 YOUTUBE_TOKEN_REFRESH_REVOKED:'Google відкликав дозвіл. Перепідключіть канал.',
 YOUTUBE_COMMENT_OUTCOME_UNKNOWN:'YouTube не підтвердив результат. Не повторюйте відправлення до перевірки коментаря.',
 YOUTUBE_COMMENT_NOT_VISIBLE:'Коментар не знайдено під час перевірки видимості.',
 YOUTUBE_COMMENTSDISABLED:'Автор відео вимкнув коментарі.',
 YOUTUBE_COMMENT_SCOPE_REQUIRED:'Потрібно надати дозвіл YouTube на коментарі.',
 YOUTUBE_COMMENT_SHORT_NOT_PUBLIC:'Shorts не є публічним або не належить підключеному каналу.',
 YOUTUBE_COMMENT_SHORTENER_UNAVAILABLE:'Сервіси скорочення посилань недоступні. Відправлення не починалося.',
 GROK_BATCH_CREATE_FAILED:'Не вдалося створити запит Grok Batch. Перевірте доступ провайдера.',
 BUDGET_EXHAUSTED:'Досягнуто ліміт витрат.',
 LOGIN_REQUIRED:'YouTube вимагає авторизацію для отримання матеріалу.',
};
export function logLevel(state){if(['failed','blocked'].includes(state))return 'error';if(['unknown','expired','rejected','return','disconnected'].includes(state))return 'warning';if(['queued','running','submitting','submitted','rendering','uploading','processing','publishing','checking','waiting_plain','link_ready','link_sending','waiting_link','scheduled'].includes(state))return 'active';return 'success';}
export function logFilters(input={}){
 const value=key=>typeof input[key]==='string'?input[key]:'';
 const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 return {process:Object.hasOwn(logProcesses,value('process'))?value('process'):'',level:['error','warning','active','success'].includes(value('level'))?value('level'):'',q:value('q').trim().slice(0,160),from:validDate(value('from'))?value('from'):'',to:validDate(value('to'))?value('to'):'',page:Math.min(100000,Math.max(1,Number.parseInt(value('page'),10)||1))};
}
const union=`
 SELECT 'captions:'||video_id AS key,'captions' AS process,status AS state,updated_at AS time,video_id,NULL::uuid AS episode_id,error_code,'snapshot' AS kind FROM captions_import_jobs
 UNION ALL SELECT 'gemini:'||id,'gemini',status,updated_at,video_id,NULL,error_code,'snapshot' FROM ai_jobs
 UNION ALL SELECT 'grok:'||id,'grok',state,updated_at,NULL,episode_id,error_code,'snapshot' FROM episode_grok_reviews
 UNION ALL SELECT 'render:'||id,'render',state,created_at,NULL,episode_id,error_code,'snapshot' FROM shorts_renders
 UNION ALL SELECT 'media:'||id,'render',state,created_at,NULL,episode_id,error_code,'snapshot' FROM episode_media_revisions
 UNION ALL SELECT 'upload:'||id,'upload',state,updated_at,NULL,episode_id,error_code,'snapshot' FROM youtube_short_uploads
 UNION ALL SELECT 'comment:'||id,'comments',state,updated_at,NULL,episode_id,error_code,'snapshot' FROM youtube_short_comments
 UNION ALL SELECT 'visibility:'||s.comment_id,'comments',s.phase,s.updated_at,NULL,c.episode_id,s.error_code,'snapshot' FROM youtube_comment_steps s JOIN youtube_short_comments c ON c.id=s.comment_id
 UNION ALL SELECT 'comment-event:'||ev.id,'comments',ev.action,ev.created_at,NULL,c.episode_id,NULL,'event' FROM youtube_short_comment_events ev JOIN youtube_short_comments c ON c.id=ev.comment_id
 UNION ALL SELECT 'upload-event:'||ev.id,'upload',ev.action,ev.created_at,NULL,u.episode_id,NULL,'event' FROM youtube_upload_events ev JOIN youtube_short_uploads u ON u.id=ev.upload_id
 UNION ALL SELECT 'editorial:'||ev.id,'editorial',ev.action,ev.created_at,cl.video_id,ev.episode_id,NULL,'event' FROM editorial_events ev LEFT JOIN claims cl ON cl.id=ev.claim_id
 UNION ALL SELECT 'link:'||c.id,'links','prepared',c.updated_at,NULL,c.episode_id,NULL,'snapshot' FROM youtube_short_comments c WHERE c.input_snapshot->>'preparedShortLink' IS NOT NULL
`;
export async function loadProjectLog(db,identity,input={}){
 const member=await activeMember(db,identity);
 if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
 const filters=logFilters(input);
 const {rows:[result]}=await db.query(`WITH raw AS (${union}), enriched AS (
 SELECT r.*,COALESCE(r.video_id,cl.video_id) AS linked_video_id,v.youtube_id,
 left(COALESCE(ver.content->>'title',v.youtube_id,'Проєкт'),200) AS title,
 CASE WHEN r.state IN ('failed','blocked') THEN 'error'
 WHEN r.state IN ('unknown','expired','rejected','return','disconnected') THEN 'warning'
 WHEN r.state IN ('queued','running','submitting','submitted','rendering','uploading','processing','publishing','checking','waiting_plain','link_ready','link_sending','waiting_link','scheduled') THEN 'active' ELSE 'success' END AS level
 FROM raw r LEFT JOIN episodes e ON e.id=r.episode_id LEFT JOIN claims cl ON cl.id=e.claim_id
 LEFT JOIN videos v ON v.id=COALESCE(r.video_id,cl.video_id)
 LEFT JOIN episode_versions ver ON ver.episode_id=e.id AND ver.version=e.version
 ), filtered AS (SELECT * FROM enriched WHERE ($1='' OR process=$1) AND ($2='' OR level=$2)
 AND ($3='' OR strpos(lower(concat_ws(' ',key,title,youtube_id,error_code,state)),lower($3))>0)
 AND ($4::date IS NULL OR time>=($4::date::timestamp AT TIME ZONE 'Europe/Kyiv'))
 AND ($5::date IS NULL OR time<(($5::date+1)::timestamp AT TIME ZONE 'Europe/Kyiv'))
 ), page AS (SELECT * FROM filtered ORDER BY time DESC,key DESC LIMIT 50 OFFSET $6)
 SELECT (SELECT count(*)::integer FROM filtered) AS total,
 (SELECT count(*)::integer FROM filtered WHERE level='error') AS errors,
 (SELECT count(*)::integer FROM filtered WHERE level='active') AS active,
 (SELECT count(*)::integer FROM filtered WHERE level='warning') AS warnings,
 COALESCE((SELECT json_agg(page ORDER BY time DESC,key DESC) FROM page),'[]'::json) AS items`,[filters.process,filters.level,filters.q,filters.from||null,filters.to||null,(filters.page-1)*50]);
 return {...result,filters,items:result.items.map(row=>({...row,explanation:explanations[row.error_code]??null,message:states[row.state]??'Стан оновлено',error_code:/^[A-Z][A-Z0-9_]{0,99}$/.test(row.error_code??'')?row.error_code:null}))};
}
// Latest journal rows for the overview page: no counters and no filters, only `limit` rows leave the database.
export async function loadRecentProjectLog(db,identity,limit=6){
 const member=await activeMember(db,identity);
 if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
 const size=Math.min(20,Math.max(1,Number.parseInt(limit,10)||6));
 const {rows}=await db.query(`WITH raw AS (${union}), latest AS (SELECT * FROM raw ORDER BY time DESC,key DESC LIMIT $1)
 SELECT r.*,COALESCE(r.video_id,cl.video_id) AS linked_video_id,v.youtube_id,
 left(COALESCE(ver.content->>'title',v.youtube_id,'Проєкт'),200) AS title
 FROM latest r LEFT JOIN episodes e ON e.id=r.episode_id LEFT JOIN claims cl ON cl.id=e.claim_id
 LEFT JOIN videos v ON v.id=COALESCE(r.video_id,cl.video_id)
 LEFT JOIN episode_versions ver ON ver.episode_id=e.id AND ver.version=e.version
 ORDER BY r.time DESC,r.key DESC`,[size]);
 return rows.map(row=>({...row,level:logLevel(row.state),explanation:explanations[row.error_code]??null,message:states[row.state]??'Стан оновлено',
  error_code:/^[A-Z][A-Z0-9_]{0,99}$/.test(row.error_code??'')?row.error_code:null}));
}
