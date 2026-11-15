// Read-only editorial overview: what needs a human, what is moving through production, what was published.
// Every query is limited (LIMIT or a time window); nothing here writes or changes existing behaviour.
import {activeMember} from '../access/membership.mjs';
import {commentStatus} from '../editorial/comment-status.mjs';
import {loadRecentProjectLog} from './project-log.mjs';

const COMMENT_ROLES=['admin','editor','publisher'];
const TONE_RANK={danger:0,warning:1,info:2,active:3,neutral:4,success:5};
const SAFE_CODE=/^[A-Z][A-Z0-9_]{1,99}$/;
const TITLE_MAX=140;

const step=(key,stage,label,tone,action,anchor=stage==='published'?'publication':stage)=>({key,stage,label,tone,anchor,action});

/** Pure mapping of an episode's latest known artefacts to one precise status and the one main next action. */
export function episodeStage(row={}){
  const {status,stale,published,grokState,mediaState,releaseApproved,renderState,uploadState}=row;
  if(published||uploadState==='published')return step('published','published','Опубліковано','success','Перевірити публікацію');
  if(status==='draft')return step('script:draft','script','Сценарій · чернетка','neutral','Відкрити сценарій');
  if(status==='review')return step('script:review','script','Сценарій · чекає рішення редактора','warning','Прийняти рішення');
  if(status!=='approved')return step('script:unknown','script','Сценарій · стан невідомий','neutral','Відкрити сценарій');
  if(stale)return step('script:stale','script','Потрібне повторне погодження','warning','Відкрити сценарій');
  switch(uploadState){
    case 'queued':case 'uploading':return step('publication:uploading','publication','Публікація · завантажується в YouTube','active','Перевірити публікацію');
    case 'processing':return step('publication:processing','publication','Публікація · YouTube обробляє','active','Перевірити публікацію');
    case 'failed':return step('publication:failed','publication','Публікація · помилка','danger','Переглянути помилку');
    case 'unknown':return step('publication:unknown','publication','Публікація · результат невідомий','warning','Перевірити публікацію');
  }
  switch(renderState){
    case 'queued':case 'rendering':case 'technical_check':return step('shorts:rendering','shorts','Shorts · рендер','active','Відкрити Shorts');
    case 'failed':return step('shorts:failed','shorts','Shorts · помилка рендеру','danger','Переглянути помилку');
    case 'ready':return step('shorts:ready','shorts','Shorts · готовий до публікації','info','Відкрити Shorts');
  }
  // An expired render (or none) falls back to the montage state below.
  switch(mediaState){
    case 'uploading':return step('montage:uploading','montage','Монтаж · очікує відео','info','Завантажити монтаж');
    case 'queued':case 'checking':return step('montage:checking','montage','Монтаж · технічна перевірка','active','Відкрити монтаж');
    case 'failed':return step('montage:failed','montage','Монтаж · помилка','danger','Переглянути помилку');
    case 'passed':return releaseApproved
      ?step('shorts:waiting','shorts','Shorts · очікує збірки','info','Відкрити Shorts')
      :step('montage:approval','montage','Монтаж · чекає погодження','warning','Прийняти рішення');
    case 'expired':return step('montage:expired','montage','Монтаж · очікує відео','neutral','Завантажити монтаж');
  }
  switch(grokState){
    case 'queued':case 'submitting':case 'submitted':return step('grok:running','grok','Перевірка Grok · виконується','active','Відкрити перевірку');
    case 'succeeded':return step('grok:decision','grok','Перевірка Grok · чекає рішення','warning','Прийняти рішення');
    case 'failed':return step('grok:failed','grok','Перевірка Grok · помилка','danger','Переглянути помилку');
    case 'unknown':return step('grok:unknown','grok','Перевірка Grok · результат невідомий','warning','Переглянути помилку');
    case 'accepted':return step('montage:waiting','montage','Монтаж · очікує відео','info','Завантажити монтаж');
  }
  return step('grok:none','grok','Перевірка Grok · не запускалася','info','Запустити перевірку');
}

async function requireMember(db,identity){
  const member=await activeMember(db,identity);
  if(!member)throw Error('FORBIDDEN');
  return member;
}

function logFailure(section,error){
  const code=typeof error?.code==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(error.code)?error.code
    :typeof error?.message==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)?error.message:'ERROR';
  console.error('EDITORIAL_OVERVIEW_SECTION_FAILED',{section,code});
}
async function guarded(section,fallback,operation){
  try{return await operation();}catch(error){logFailure(section,error);return fallback;}
}

const iso=value=>value==null?null:new Date(value).toISOString();
const trimTitle=value=>{const text=String(value??'').trim();return text.length>TITLE_MAX?text.slice(0,TITLE_MAX-1).trimEnd()+'…':text;};
const withCode=(text,code)=>SAFE_CODE.test(code??'')?`${text}. Код: ${code}`:text;
const videoHref=(videoId,hash='')=>`/editorial/videos/${encodeURIComponent(videoId)}${hash?'#'+hash:''}`;
const episodeHref=(videoId,episodeId,anchor='script')=>videoHref(videoId,`episode-${episodeId}-${anchor}`);
const commentHref=id=>`/editorial/youtube-comments#comment-${encodeURIComponent(id)}`;
const num=value=>value==null?null:Number(value);

// ---------- shared SQL ----------
// Title of an episode / claim / video: current episode title → current claim question → «Відео <id>».
const claimQuestion=`(SELECT NULLIF(btrim(cv.content->>'question'),'') FROM claim_versions cv WHERE cv.claim_id=cl.id AND cv.version=cl.version)`;
const episodeTitle=`left(COALESCE(NULLIF(btrim(ev.content->>'title'),''),${claimQuestion},'Відео '||v.youtube_id),200)`;
const notPublished=alias=>`NOT EXISTS(SELECT 1 FROM publications p WHERE p.episode_id=${alias}.id)
  AND NOT EXISTS(SELECT 1 FROM youtube_short_uploads pu WHERE pu.episode_id=${alias}.id AND pu.state='published')`;
const inProduction=alias=>`${alias}.status='approved' AND cl.status='approved' AND cl.version=ev.claim_version AND ${notPublished(alias)}`;
const episodeBase=`episodes e JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=e.version
  JOIN claims cl ON cl.id=e.claim_id JOIN videos v ON v.id=cl.video_id`;

// Published Shorts: YouTube uploads in state published (time of the 'published' event, else updated_at)
// plus registered publications that are not one of those uploads. $1 = lower time bound, $2 = per-branch limit.
const publishedShorts=`(
  SELECT * FROM (SELECT u.youtube_id,u.episode_id,u.title AS short_title,
      COALESCE((SELECT max(x.created_at) FROM youtube_upload_events x WHERE x.upload_id=u.id AND x.action='published'),u.updated_at) AS published_at
    FROM youtube_short_uploads u WHERE u.state='published' AND u.youtube_id IS NOT NULL AND u.updated_at>=$1
    ORDER BY u.updated_at DESC LIMIT $2) up
  UNION ALL
  SELECT * FROM (SELECT p.youtube_id,p.episode_id,p.snapshot->'episode'->>'title' AS short_title,p.published_at
    FROM publications p WHERE p.published_at>=$1
      AND NOT EXISTS(SELECT 1 FROM youtube_short_uploads u WHERE u.youtube_id=p.youtube_id AND u.state='published')
    ORDER BY p.published_at DESC LIMIT $2) pb
)`;

// Everything episodeStage needs for one episode (alias e, joined through episodeBase).
const episodeDetails=`e.id AS episode_id,e.status,v.id AS video_id,v.youtube_id,${episodeTitle} AS title,
  (cl.status<>'approved' OR cl.version<>ev.claim_version) AS stale,
  COALESCE(pub.published_at,upub.published_at) AS published_at,
  g.state AS grok_state,g.updated_at AS grok_at,
  m.state AS media_state,m.created_at AS media_at,COALESCE(m.release_approved,false) AS release_approved,
  r.state AS render_state,r.created_at AS render_at,
  u.state AS upload_state,u.updated_at AS upload_at,
  (SELECT max(x.created_at) FROM editorial_events x WHERE x.episode_id=e.id) AS event_at
  FROM ${episodeBase}
  LEFT JOIN publications pub ON pub.episode_id=e.id
  LEFT JOIN LATERAL (SELECT COALESCE((SELECT max(x.created_at) FROM youtube_upload_events x WHERE x.upload_id=pu.id AND x.action='published'),pu.updated_at) AS published_at
    FROM youtube_short_uploads pu WHERE pu.episode_id=e.id AND pu.state='published' ORDER BY pu.updated_at DESC LIMIT 1) upub ON true
  LEFT JOIN LATERAL (SELECT gr.state,gr.updated_at FROM episode_grok_reviews gr
    WHERE gr.episode_id=e.id AND gr.episode_version=e.version ORDER BY gr.round DESC LIMIT 1) g ON true
  LEFT JOIN LATERAL (SELECT mr.created_at,
      CASE WHEN mr.expires_at<=now() OR (mr.state='uploading' AND mr.upload_until<=now()) THEN 'expired' ELSE mr.state END AS state,
      (mr.state='passed' AND latest.reviewed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM audit_findings f
        LEFT JOIN audit_finding_reviews fr USING(job_id,attempt,position)
        WHERE f.job_id=latest.id AND f.attempt=latest.attempt AND fr.job_id IS NULL)) AS release_approved
    FROM episode_media_revisions mr
    LEFT JOIN LATERAL (SELECT j.id,j.attempt,a.reviewed_at FROM ai_jobs j JOIN prepublication_audits a
      ON a.job_id=j.id AND a.attempt=j.attempt WHERE j.media_revision_id=mr.id AND j.mode='video' AND j.status='succeeded'
      ORDER BY a.completed_at DESC,j.created_at DESC,j.id DESC LIMIT 1) latest ON true
    WHERE mr.episode_id=e.id AND mr.episode_version=e.version AND mr.kind='montage' ORDER BY mr.ordinal DESC LIMIT 1) m ON true
  LEFT JOIN LATERAL (SELECT CASE WHEN sr.state='ready' AND sr.expires_at<=now() THEN 'expired' ELSE sr.state END AS state,sr.created_at
    FROM shorts_renders sr WHERE sr.episode_id=e.id AND sr.episode_version=e.version ORDER BY sr.created_at DESC LIMIT 1) r ON true
  LEFT JOIN LATERAL (SELECT su.state,su.updated_at FROM youtube_short_uploads su
    WHERE su.episode_id=e.id ORDER BY su.created_at DESC LIMIT 1) u ON true`;

const stageOf=row=>episodeStage({status:row.status,stale:row.stale,published:row.published_at!=null,grokState:row.grok_state,
  mediaState:row.media_state,releaseApproved:row.release_approved,renderState:row.render_state,uploadState:row.upload_state});

// ---------- attention ----------
const ATTENTION_CAP=50;
function attentionSources(roles){
  const can=role=>roles.includes(role);
  const sources=[];
  if(can('factchecker'))sources.push({name:'claims_review',sql:`SELECT cl.id,v.id AS video_id,v.youtube_id,
      left(COALESCE(${claimQuestion},'Відео '||v.youtube_id),200) AS title,
      COALESCE((SELECT max(x.created_at) FROM editorial_events x WHERE x.claim_id=cl.id),v.created_at) AS time
    FROM claims cl JOIN videos v ON v.id=cl.video_id WHERE cl.status='review' ORDER BY time DESC LIMIT ${ATTENTION_CAP}`,
  map:row=>({key:'claim-review:'+row.id,kind:'claim',stage:'factcheck',reason:'Фактчек · твердження чекає перевірки',tone:'warning',
    href:videoHref(row.video_id,'claim-'+row.id)})});
  if(can('editor'))sources.push({name:'episodes_review',sql:`SELECT e.id,v.id AS video_id,v.youtube_id,${episodeTitle} AS title,
      COALESCE((SELECT max(x.created_at) FROM editorial_events x WHERE x.episode_id=e.id),ev.created_at) AS time
    FROM ${episodeBase} WHERE e.status='review' ORDER BY time DESC LIMIT ${ATTENTION_CAP}`,
  map:row=>({key:'episode-review:'+row.id,kind:'episode',stage:'script',reason:'Сценарій чекає рішення',tone:'warning',
    href:episodeHref(row.video_id,row.id,'script')})});
  if(can('author'))sources.push({name:'episodes_stale',sql:`SELECT e.id,v.id AS video_id,v.youtube_id,${episodeTitle} AS title,
      COALESCE((SELECT max(x.created_at) FROM editorial_events x WHERE x.claim_id=cl.id),ev.created_at) AS time
    FROM ${episodeBase} WHERE e.status='approved' AND (cl.status<>'approved' OR cl.version<>ev.claim_version) AND ${notPublished('e')}
    ORDER BY time DESC LIMIT ${ATTENTION_CAP}`,
  map:row=>({key:'episode-stale:'+row.id,kind:'episode',stage:'script',reason:'Потрібне повторне погодження: твердження змінилося після погодження сценарію',
    tone:'warning',href:episodeHref(row.video_id,row.id,'script')})});
  const grokStates=[...(can('editor')?['succeeded']:[]),...(can('author')?['failed','unknown']:[])];
  if(grokStates.length)sources.push({name:'grok',params:[grokStates],sql:`SELECT g.id,e.id AS episode_id,v.id AS video_id,v.youtube_id,
      ${episodeTitle} AS title,g.state,g.error_code,g.updated_at AS time
    FROM episode_grok_reviews g JOIN ${episodeBase} ON e.id=g.episode_id AND g.episode_version=e.version
    WHERE g.state=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM episode_grok_reviews n
      WHERE n.episode_id=g.episode_id AND n.episode_version=g.episode_version AND n.round>g.round)
      AND ${notPublished('e')}
    ORDER BY g.updated_at DESC LIMIT ${ATTENTION_CAP}`,
  map:row=>({key:'grok:'+row.id,kind:'episode',stage:'grok',
    reason:row.state==='succeeded'?'Grok оцінив сценарій · чекає рішення'
      :row.state==='failed'?withCode('Перевірка Grok завершилася помилкою',row.error_code)
        :withCode('Результат перевірки Grok невідомий — перевірте перед повтором',row.error_code),
    tone:row.state==='failed'?'danger':'warning',href:episodeHref(row.video_id,row.episode_id,'grok')})});
  if(can('author')){
    sources.push({name:'media',sql:`SELECT m.id,e.id AS episode_id,v.id AS video_id,v.youtube_id,${episodeTitle} AS title,m.error_code,m.created_at AS time
      FROM episode_media_revisions m JOIN ${episodeBase} ON e.id=m.episode_id AND m.episode_version=e.version
      WHERE m.kind='montage' AND m.state='failed' AND NOT EXISTS(SELECT 1 FROM episode_media_revisions n
        WHERE n.episode_id=m.episode_id AND n.kind='montage' AND n.ordinal>m.ordinal) AND ${notPublished('e')}
      ORDER BY m.created_at DESC LIMIT ${ATTENTION_CAP}`,
    map:row=>({key:'media:'+row.id,kind:'episode',stage:'montage',reason:withCode('Монтаж завершився помилкою',row.error_code),
      tone:'danger',href:episodeHref(row.video_id,row.episode_id,'montage')})});
    sources.push({name:'shorts',sql:`SELECT r.id,e.id AS episode_id,v.id AS video_id,v.youtube_id,${episodeTitle} AS title,r.error_code,r.created_at AS time
      FROM shorts_renders r JOIN ${episodeBase} ON e.id=r.episode_id AND r.episode_version=e.version
      WHERE r.state='failed' AND NOT EXISTS(SELECT 1 FROM shorts_renders n WHERE n.episode_id=r.episode_id AND n.created_at>r.created_at)
        AND ${notPublished('e')}
      ORDER BY r.created_at DESC LIMIT ${ATTENTION_CAP}`,
    map:row=>({key:'shorts:'+row.id,kind:'episode',stage:'shorts',reason:withCode('Збірка Shorts завершилася помилкою',row.error_code),
      tone:'danger',href:episodeHref(row.video_id,row.episode_id,'shorts')})});
    sources.push({name:'gemini',sql:`SELECT j.id,v.id AS video_id,v.youtube_id,j.status,j.error_code,j.updated_at AS time,
        left('Відео '||v.youtube_id,200) AS title
      FROM ai_jobs j JOIN videos v ON v.id=j.video_id
      WHERE j.status IN ('failed','unknown') AND j.updated_at>=now()-interval '14 days'
        AND NOT EXISTS(SELECT 1 FROM ai_jobs n WHERE n.video_id=j.video_id AND n.mode=j.mode AND n.created_at>j.created_at)
      ORDER BY j.updated_at DESC LIMIT ${ATTENTION_CAP}`,
    map:row=>({key:'gemini:'+row.id,kind:'video',stage:'analysis',
      reason:withCode(row.status==='failed'?'Аналіз Gemini · помилка':'Аналіз Gemini · результат невідомий',row.error_code),
      tone:row.status==='failed'?'danger':'warning',href:videoHref(row.video_id,'analysis')})});
    sources.push({name:'captions',sql:`SELECT c.video_id AS id,v.id AS video_id,v.youtube_id,c.error_code,c.updated_at AS time,
        left('Відео '||v.youtube_id,200) AS title
      FROM captions_import_jobs c JOIN videos v ON v.id=c.video_id WHERE c.status='failed'
      ORDER BY c.updated_at DESC LIMIT ${ATTENTION_CAP}`,
    map:row=>({key:'captions:'+row.id,kind:'video',stage:'transcripts',reason:withCode('Імпорт субтитрів YouTube · помилка',row.error_code),
      tone:'danger',href:videoHref(row.video_id,'transcripts')})});
  }
  if(can('publisher'))sources.push({name:'uploads',sql:`SELECT u.id,e.id AS episode_id,v.id AS video_id,v.youtube_id,${episodeTitle} AS title,
      u.state,u.error_code,u.updated_at AS time
    FROM youtube_short_uploads u JOIN ${episodeBase} ON e.id=u.episode_id
    WHERE u.state IN ('failed','unknown') AND NOT EXISTS(SELECT 1 FROM youtube_short_uploads n
      WHERE n.episode_id=u.episode_id AND n.created_at>u.created_at) AND ${notPublished('e')}
    ORDER BY u.updated_at DESC LIMIT ${ATTENTION_CAP}`,
  map:row=>({key:'upload:'+row.id,kind:'episode',stage:'publication',
    reason:row.state==='failed'?withCode('Завантаження в YouTube завершилося помилкою',row.error_code)
      :withCode('Результат завантаження в YouTube невідомий — перевірте канал перед повтором',row.error_code),
    tone:row.state==='failed'?'danger':'warning',href:episodeHref(row.video_id,row.episode_id,'publication')})});
  if(roles.some(role=>COMMENT_ROLES.includes(role)))sources.push({name:'comments',sql:`SELECT c.id,c.state,c.error_code,c.published_at,
      c.updated_at AS time,c.input_snapshot->'publicVisibility' AS public_visibility,
      (SELECT row_to_json(s) FROM (SELECT phase,linked_verified_at,checked_at FROM youtube_comment_steps WHERE comment_id=c.id) s) AS publication_steps,
      left(COALESCE(NULLIF(btrim(c.input_snapshot->>'parentTitle'),''),'Відео '||c.parent_video_id),200) AS title
    FROM youtube_short_comments c
    WHERE c.state IN ('succeeded','failed','unknown')
      OR (c.state='published' AND (c.input_snapshot->'publicVisibility'->>'code'='YOUTUBE_COMMENT_NOT_VISIBLE'
        OR EXISTS(SELECT 1 FROM youtube_comment_steps s WHERE s.comment_id=c.id AND s.phase='blocked')))
    ORDER BY c.updated_at DESC LIMIT ${ATTENTION_CAP}`,
  map:row=>{
    const href=commentHref(row.id);
    if(row.state==='succeeded')return {key:'comment:'+row.id,kind:'comment',stage:'comments',reason:'Коментар чекає схвалення',tone:'warning',href};
    if(row.state==='failed'||row.state==='unknown')return {key:'comment:'+row.id,kind:'comment',stage:'comments',
      reason:withCode('Коментар: помилка відправлення',row.error_code),tone:row.state==='failed'?'danger':'warning',href};
    const {visibility}=commentStatus(row);
    if(visibility?.value!=='not_confirmed')return null;
    return {key:'comment:'+row.id,kind:'comment',stage:'comments',
      reason:'YouTube прийняв коментар, але видимість після перезавантаження не підтверджена',tone:'warning',href};
  }});
  return sources;
}

async function loadAttention(db,roles){
  const items=[];
  for(const source of attentionSources(roles)){
    const rows=await guarded('attention.'+source.name,[],async()=>(await db.query(source.sql,source.params??[])).rows);
    for(const row of rows){
      const item=source.map(row);
      if(item)items.push({key:item.key,kind:item.kind,title:trimTitle(row.title),stage:item.stage,reason:item.reason,tone:item.tone,time:iso(row.time),href:item.href});
    }
  }
  items.sort((a,b)=>(TONE_RANK[a.tone]-TONE_RANK[b.tone])||String(b.time??'').localeCompare(String(a.time??'')));
  return {total:items.length,items:items.slice(0,5)};
}

// ---------- stats ----------
async function loadStats(db,canComments){
  const count=(section,sql,params=[])=>guarded('stats.'+section,null,async()=>num((await db.query(sql,params)).rows[0]?.n));
  const week=new Date(Date.now()-7*24*3600*1000);
  return {
    inReview:await count('inReview',`SELECT (SELECT count(*) FROM (SELECT 1 FROM claims WHERE status='review' LIMIT 1000) a)
      +(SELECT count(*) FROM (SELECT 1 FROM episodes WHERE status='review' LIMIT 1000) b) AS n`),
    inProduction:await count('inProduction',`SELECT count(*) AS n FROM (SELECT 1 FROM ${episodeBase} WHERE ${inProduction('e')} LIMIT 1000) x`),
    publishedShorts7d:await count('publishedShorts7d',`SELECT count(DISTINCT youtube_id) AS n FROM ${publishedShorts} s WHERE s.published_at>=$1`,[week,1000]),
    verifiedComments7d:canComments?await count('verifiedComments7d',`SELECT count(*) AS n FROM (SELECT 1 FROM youtube_comment_steps s
      JOIN youtube_short_comments c ON c.id=s.comment_id
      WHERE s.phase='verified' AND COALESCE(s.linked_verified_at,s.checked_at)>=$1 LIMIT 1000) x`,[week]):null,
  };
}

// ---------- pipeline ----------
async function loadPipeline(db){
  const episodes=await guarded('pipeline.episodes',[],async()=>(await db.query(`WITH candidates AS (
      SELECT episode_id AS id FROM (SELECT episode_id FROM editorial_events WHERE episode_id IS NOT NULL ORDER BY id DESC LIMIT 100) a
      UNION SELECT episode_id FROM (SELECT episode_id FROM episode_grok_reviews ORDER BY updated_at DESC LIMIT 50) b
      UNION SELECT episode_id FROM (SELECT episode_id FROM episode_media_revisions ORDER BY created_at DESC LIMIT 50) c
      UNION SELECT episode_id FROM (SELECT episode_id FROM shorts_renders ORDER BY created_at DESC LIMIT 50) d
      UNION SELECT episode_id FROM (SELECT episode_id FROM youtube_short_uploads ORDER BY updated_at DESC LIMIT 50) f
    ), detailed AS (SELECT ${episodeDetails} WHERE e.id IN (SELECT id FROM candidates))
    SELECT *,GREATEST(event_at,grok_at,media_at,render_at,upload_at,published_at) AS time FROM detailed
    WHERE published_at IS NULL OR published_at>=now()-interval '3 days'
    ORDER BY time DESC NULLS LAST LIMIT 8`)).rows);
  const claims=await guarded('pipeline.claims',[],async()=>(await db.query(`SELECT cl.id,cl.status,v.id AS video_id,v.youtube_id,
      left(COALESCE(${claimQuestion},'Відео '||v.youtube_id),200) AS title,
      GREATEST(v.created_at,(SELECT max(x.created_at) FROM editorial_events x WHERE x.claim_id=cl.id)) AS time
    FROM claims cl JOIN videos v ON v.id=cl.video_id
    WHERE cl.id IN (SELECT claim_id FROM (SELECT claim_id FROM editorial_events WHERE claim_id IS NOT NULL ORDER BY id DESC LIMIT 100) r)
      AND cl.status IN ('draft','review') AND NOT EXISTS(SELECT 1 FROM episodes e WHERE e.claim_id=cl.id)
    ORDER BY time DESC LIMIT 8`)).rows);
  const videos=await guarded('pipeline.videos',[],async()=>(await db.query(`SELECT v.id,v.youtube_id,
      GREATEST(v.created_at,(SELECT updated_at FROM captions_import_jobs c WHERE c.video_id=v.id),
        (SELECT max(j.updated_at) FROM (SELECT updated_at FROM ai_jobs WHERE video_id=v.id ORDER BY created_at DESC LIMIT 5) j)) AS time
    FROM videos v WHERE v.created_at>=now()-interval '14 days' AND NOT EXISTS(SELECT 1 FROM claims cl WHERE cl.video_id=v.id)
    ORDER BY v.created_at DESC LIMIT 8`)).rows);
  const items=[
    ...episodes.map(row=>{const s=stageOf(row);return {key:'episode:'+row.episode_id,videoId:row.video_id,youtubeId:row.youtube_id,
      title:trimTitle(row.title),stage:s.stage,label:s.label,tone:s.tone,time:iso(row.time),href:episodeHref(row.video_id,row.episode_id,s.anchor),action:s.action};}),
    ...claims.map(row=>({key:'claim:'+row.id,videoId:row.video_id,youtubeId:row.youtube_id,title:trimTitle(row.title),stage:'factcheck',
      label:row.status==='review'?'Фактчек · на перевірці':'Фактчек · чернетка',tone:row.status==='review'?'warning':'neutral',
      time:iso(row.time),href:videoHref(row.video_id,'claim-'+row.id),action:'Відкрити твердження'})),
    ...videos.map(row=>({key:'video:'+row.id,videoId:row.id,youtubeId:row.youtube_id,title:trimTitle('Відео '+row.youtube_id),stage:'factcheck',
      label:'Фактчек · ще немає тверджень',tone:'info',time:iso(row.time),href:videoHref(row.id,'transcripts'),action:'Почати фактчек'})),
  ];
  items.sort((a,b)=>String(b.time??'').localeCompare(String(a.time??''))||a.key.localeCompare(b.key));
  return items.slice(0,8);
}

// ---------- publications ----------
async function loadPublications(db,canComments){
  const shorts=await guarded('publications',[],async()=>(await db.query(`SELECT s.youtube_id,s.published_at,s.episode_id,
      v.id AS video_id,v.youtube_id AS source_youtube_id,
      left(COALESCE(NULLIF(btrim(ev.content->>'title'),''),NULLIF(btrim(s.short_title),''),${claimQuestion},'Відео '||v.youtube_id),200) AS title
    FROM ${publishedShorts} s JOIN ${episodeBase} ON e.id=s.episode_id
    ORDER BY s.published_at DESC LIMIT 5`,['-infinity',20])).rows);
  const byShort=new Map(shorts.map(row=>[row.youtube_id,[]]));
  if(canComments&&shorts.length){
    const rows=await guarded('publications.comments',[],async()=>(await db.query(`SELECT c.* FROM unnest($1::text[]) AS t(short_id)
      CROSS JOIN LATERAL (SELECT c.id,c.short_video_id,c.target_kind,c.parent_video_id,c.state,c.published_at,c.youtube_comment_id,
          c.input_snapshot->'publicVisibility' AS public_visibility,
          (SELECT row_to_json(s) FROM (SELECT phase,linked_verified_at,checked_at FROM youtube_comment_steps WHERE comment_id=c.id) s) AS publication_steps
        FROM youtube_short_comments c WHERE c.short_video_id=t.short_id
        ORDER BY COALESCE(c.published_at,c.updated_at) DESC LIMIT 3) c`,[shorts.map(row=>row.youtube_id)])).rows);
    for(const row of rows){
      const {send,visibility}=commentStatus(row);
      const commentUrl=row.state==='published'&&row.youtube_comment_id
        ?`https://www.youtube.com/watch?v=${encodeURIComponent(row.parent_video_id)}&lc=${encodeURIComponent(row.youtube_comment_id)}`:null;
      byShort.get(row.short_video_id)?.push({id:row.id,targetKind:row.target_kind,parentVideoId:row.parent_video_id,
        send:{...send,at:iso(send.at)},visibility:visibility&&{...visibility,checkedAt:iso(visibility.checkedAt)},commentUrl,href:commentHref(row.id)});
    }
  }
  return shorts.map(row=>({key:'short:'+row.youtube_id,shortYoutubeId:row.youtube_id,title:trimTitle(row.title),publishedAt:iso(row.published_at),
    sourceYoutubeId:row.source_youtube_id,videoId:row.video_id,episodeId:row.episode_id,
    href:episodeHref(row.video_id,row.episode_id,'publication'),comments:byShort.get(row.youtube_id)??[]}));
}

// ---------- events ----------
const eventLabels={
  claim:{create:'Твердження створено',edit:'Твердження змінено',submit:'Твердження передано на перевірку',approve:'Твердження погоджено',
    return:'Твердження повернуто на доопрацювання',withdraw:'Твердження знято з роботи'},
  episode:{create:'Сценарій створено',edit:'Сценарій змінено',submit:'Сценарій передано на перевірку',approve:'Сценарій погоджено',
    return:'Сценарій повернуто на доопрацювання',withdraw:'Сценарій відкликано'},
};
const eventTones={submit:'info',approve:'success',return:'warning',withdraw:'neutral',create:'neutral',edit:'neutral'};
const levelTones={error:'danger',warning:'warning',active:'active',success:'success'};

async function loadEvents(db,identity,roles){
  if(roles.includes('admin'))return guarded('events',{full:true,items:[]},async()=>{
    const items=await loadRecentProjectLog(db,identity,6);
    return {full:true,items:items.map(row=>({key:row.key,time:iso(row.time),label:row.message,title:trimTitle(row.title),
      href:row.linked_video_id?videoHref(row.linked_video_id):null,tone:levelTones[row.level]??'neutral'}))};
  });
  return guarded('events',{full:false,items:[]},async()=>{
    const {rows}=await db.query(`SELECT x.id,x.claim_id,x.episode_id,x.action,x.created_at,v.id AS video_id,v.youtube_id,
        left(COALESCE(NULLIF(btrim(ev.content->>'title'),''),${claimQuestion},'Відео '||v.youtube_id),200) AS title
      FROM (SELECT * FROM editorial_events WHERE action<>'edit' ORDER BY id DESC LIMIT 6) x
      LEFT JOIN episodes e ON e.id=x.episode_id
      LEFT JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=e.version
      JOIN claims cl ON cl.id=COALESCE(x.claim_id,e.claim_id) JOIN videos v ON v.id=cl.video_id
      ORDER BY x.id DESC`);
    return {full:false,items:rows.map(row=>{const kind=row.episode_id?'episode':'claim';return {key:'editorial:'+row.id,time:iso(row.created_at),
      label:eventLabels[kind][row.action]??'Стан оновлено',title:trimTitle(row.title),
      href:kind==='episode'?episodeHref(row.video_id,row.episode_id,'script'):videoHref(row.video_id,'claim-'+row.claim_id),
      tone:eventTones[row.action]??'neutral'};})};
  });
}

// ---------- series ----------
async function loadSeries(db,canComments){
  return guarded('series',null,async()=>{
    const {rows}=await db.query(`WITH days AS (
        SELECT d::date AS day FROM generate_series((now() AT TIME ZONE 'Europe/Kyiv')::date-6,(now() AT TIME ZONE 'Europe/Kyiv')::date,interval '1 day') d
      ), bounds AS (SELECT (min(day)::timestamp AT TIME ZONE 'Europe/Kyiv') AS since FROM days),
      shorts AS (SELECT (s.published_at AT TIME ZONE 'Europe/Kyiv')::date AS day,count(DISTINCT s.youtube_id) AS n
        FROM ${publishedShorts} s WHERE s.published_at>=$1 GROUP BY 1),
      comments AS (SELECT (COALESCE(st.linked_verified_at,st.checked_at) AT TIME ZONE 'Europe/Kyiv')::date AS day,count(*) AS n
        FROM youtube_comment_steps st JOIN youtube_short_comments c ON c.id=st.comment_id
        WHERE $3::boolean AND st.phase='verified' AND COALESCE(st.linked_verified_at,st.checked_at)>=(SELECT since FROM bounds) GROUP BY 1)
      SELECT to_char(d.day,'YYYY-MM-DD') AS day,COALESCE(s.n,0) AS shorts,COALESCE(c.n,0) AS comments
      FROM days d LEFT JOIN shorts s ON s.day=d.day LEFT JOIN comments c ON c.day=d.day ORDER BY d.day LIMIT 7`,
    [new Date(Date.now()-8*24*3600*1000),1000,canComments]);
    return {timeZone:'Europe/Kyiv',days:rows.map(row=>({day:row.day,shorts:Number(row.shorts),verifiedComments:canComments?Number(row.comments):null}))};
  });
}

export async function loadEditorialOverview(db,identity){
  const member=await requireMember(db,identity);
  const roles=member.roles;
  const canComments=roles.some(role=>COMMENT_ROLES.includes(role));
  const attention=await guarded('attention',{total:0,items:[]},()=>loadAttention(db,roles));
  const stats=await loadStats(db,canComments);
  const pipeline=await guarded('pipeline',[],()=>loadPipeline(db));
  const publications=await guarded('publications',[],()=>loadPublications(db,canComments));
  const events=await loadEvents(db,identity,roles);
  const series=await loadSeries(db,canComments);
  return {roles,generatedAt:new Date().toISOString(),attention,stats,pipeline,publications,events,series};
}

// ---------- video list ----------
export const videoStages={factcheck:'Фактчек',review:'На перевірці',production:'У виробництві',published:'Опубліковано',idle:'Без активних задач'};
const videoTones={factcheck:'info',review:'warning',production:'active',published:'success',idle:'neutral'};

export async function listEditorialVideos(db,identity,{stage='',q=''}={}){
  await requireMember(db,identity);
  const stageFilter=typeof stage==='string'&&Object.hasOwn(videoStages,stage)?stage:'';
  const query=typeof q==='string'?q.trim().slice(0,160):'';
  const {rows}=await db.query(`WITH candidates AS (
      SELECT id FROM (SELECT id FROM videos ORDER BY created_at DESC,id LIMIT 1000) recent
      UNION SELECT id FROM (SELECT id FROM videos WHERE $2<>'' AND strpos(lower(youtube_id),lower($2))>0 ORDER BY created_at DESC LIMIT 200) matched
    ), summary AS (
      SELECT v.id,v.youtube_id,v.created_at,
        (SELECT count(*) FROM claims cl WHERE cl.video_id=v.id) AS claims,
        (SELECT count(*) FROM episodes e JOIN claims cl ON cl.id=e.claim_id WHERE cl.video_id=v.id) AS episodes,
        EXISTS(SELECT 1 FROM claims cl WHERE cl.video_id=v.id AND cl.status='review')
          OR EXISTS(SELECT 1 FROM episodes e JOIN claims cl ON cl.id=e.claim_id WHERE cl.video_id=v.id AND e.status='review') AS in_review,
        EXISTS(SELECT 1 FROM episodes e JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=e.version
          JOIN claims cl ON cl.id=e.claim_id WHERE cl.video_id=v.id AND ${inProduction('e')}) AS in_production,
        EXISTS(SELECT 1 FROM episodes e JOIN claims cl ON cl.id=e.claim_id WHERE cl.video_id=v.id AND NOT (${notPublished('e')})) AS is_published,
        (EXISTS(SELECT 1 FROM claims cl WHERE cl.video_id=v.id AND cl.status='draft')
          OR NOT EXISTS(SELECT 1 FROM claims cl WHERE cl.video_id=v.id)) AS in_factcheck,
        left(COALESCE(
          (SELECT NULLIF(btrim(ev.content->>'title'),'') FROM episodes e JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=e.version
            JOIN claims cl ON cl.id=e.claim_id WHERE cl.video_id=v.id AND NULLIF(btrim(ev.content->>'title'),'') IS NOT NULL
            ORDER BY ev.created_at DESC LIMIT 1),
          (SELECT NULLIF(btrim(cv.content->>'question'),'') FROM claims cl JOIN claim_versions cv ON cv.claim_id=cl.id AND cv.version=cl.version
            WHERE cl.video_id=v.id AND NULLIF(btrim(cv.content->>'question'),'') IS NOT NULL ORDER BY cv.created_at DESC LIMIT 1),
          'Відео '||v.youtube_id),200) AS title,
        GREATEST(v.created_at,
          (SELECT max(x.created_at) FROM editorial_events x JOIN claims cl ON cl.id=x.claim_id WHERE cl.video_id=v.id),
          (SELECT max(x.created_at) FROM editorial_events x JOIN episodes e ON e.id=x.episode_id JOIN claims cl ON cl.id=e.claim_id WHERE cl.video_id=v.id)) AS time
      FROM videos v WHERE v.id IN (SELECT id FROM candidates)
    ), staged AS (
      SELECT *,CASE WHEN in_review THEN 'review' WHEN in_production THEN 'production' WHEN is_published THEN 'published'
        WHEN in_factcheck THEN 'factcheck' ELSE 'idle' END AS stage FROM summary
    )
    SELECT * FROM staged WHERE ($1='' OR stage=$1)
      AND ($2='' OR strpos(lower(youtube_id),lower($2))>0 OR strpos(lower(title),lower($2))>0)
    ORDER BY created_at DESC,id LIMIT 200`,[stageFilter,query]);
  return rows.map(row=>({id:row.id,youtubeId:row.youtube_id,createdAt:iso(row.created_at),title:trimTitle(row.title),stage:row.stage,
    label:videoStages[row.stage],tone:videoTones[row.stage],time:iso(row.time),claims:Number(row.claims),episodes:Number(row.episodes)}));
}
