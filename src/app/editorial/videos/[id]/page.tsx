import Link from 'next/link';
import { listMontage } from '../../../../db/montage.mjs';
import { MontagePanel, type Montage } from '../../montage-panel';
import { ShortsPanel } from '../../shorts-panel';
import { listShortRenders } from '../../../../db/shorts.mjs';
import { loadPublications } from '../../../../db/publications.mjs';
import { PublicationPanel, type Publication } from '../../publication-panel';
import { AnalysisPanel } from '../../analysis-panel';
import { CaptionsBookmarklet } from '../../captions-bookmarklet';
import { captionsBookmarkletHref } from '../../../../youtube/captions-bookmarklet.mjs';
import { ScenarioGeminiButton } from '../../scenario-gemini-button';
import {EpisodeGrokReviewPanel,type EpisodeGrokReview} from '../../episode-grok-review-panel';
import {listEpisodeGrokReviewsForEpisodes} from '../../../../db/episode-grok.mjs';
import {listUsableMontagePlans} from '../../../../db/montage-plans.mjs';
import { notFound, redirect } from 'next/navigation';
import { clerkId } from '../../../../access/session';
import { database } from '../../../../db/runtime.mjs';
import { loadTranscript, loadWorkflow } from '../../../../db/editorial-workflow.mjs';
import { ClaimForm, EpisodeForm, TranscriptForm, Transitions, YouTubeCaptionsImport } from '../../workflow-controls';
import { episodeStage } from '../../../../db/editorial-overview.mjs';
import { verdictLabels } from "../../workflow-types";
import type { Claim, ClaimContent, Episode, Transcript } from '../../workflow-types';
import type {MontagePlanOption} from '../../shorts-panel';
import { Badge, Empty, PageHeader, SectionHead, type Tone } from '../../ui';
import './style.css';

type Segment = { position: number; start_ms: string | null; end_ms: string | null; body: string };
type WorkflowEvent = {
  claim_id: string | null; episode_id: string | null; version: number; revision: number;
  action: string; comment: string; actor: string; created_at: string | Date;
};
const statuses: Record<string,string> = { draft:'Чернетка', review:'На перевірці', approved:'Погоджено', withdrawn:'Знято з роботи' };
const statusTones: Record<string,Tone> = { draft:'neutral', review:'info', approved:'active', withdrawn:'neutral' };
type Stage = 'script' | 'grok' | 'montage' | 'shorts' | 'publication';
const stages: [Stage,string][] = [
  ['script','Сценарій'], ['grok','Перевірка Grok'], ['montage','Монтаж'], ['shorts','Shorts'], ['publication','Публікація'],
];
const eventLabels: Record<string,string> = { create:'Створено', edit:'Збережено нову версію', submit:'Передано на перевірку',
  approve:'Погоджено', return:'Повернуто', withdraw:'Знято з роботи' };

const fieldLabels: Record<keyof ClaimContent,string> = {
  quote:'Цитата', translation:'Переклад', context:'Контекст', question:'Питання',
  verdict:'Висновок', explanation:'Пояснення', startMs:'Початок, мс', endMs:'Кінець, мс',
};

function ClaimChanges({ claim }: { claim: Claim }) {
  const previous = claim.previous_content;
  if (!previous) return null;
  const changed = (Object.keys(fieldLabels) as (keyof ClaimContent)[]).filter(key=>previous[key]!==claim.content[key]);
  const evidenceChanged = JSON.stringify(claim.previous_evidence)!==JSON.stringify(claim.evidence);
  if (!changed.length && !evidenceChanged) return null;
  const label = (key: keyof ClaimContent, value: string | number | null) =>
    key==='verdict' ? verdictLabels[String(value)] ?? '—' : value ?? '—';
  return <details><summary>Зміни від попередньої версії</summary>
    <ul>{changed.map(key=><li key={key}><strong>{fieldLabels[key]}</strong>
      <p className="workflow-text">Було: {label(key,previous[key])}</p>
      <p className="workflow-text">Стало: {label(key,claim.content[key])}</p>
    </li>)}</ul>
    {evidenceChanged && <><p>Попередні джерела</p>
      <ul>{claim.previous_evidence.map((source,index)=><li key={index}>
        <a href={source.url} rel="noreferrer" target="_blank">{source.title}</a> · {source.locator} · {source.coverage}
      </li>)}</ul>
    </>}
  </details>;
}

function actions(status: string, author: boolean, reviewer: boolean, claim: boolean, stale = false) {
  return [
    ...(author && status==='draft' && !stale ? ['submit'] : []),
    ...(reviewer && status==='review' ? (stale ? ['return'] : ['approve','return']) : []),
    ...(author && claim && status!=='withdrawn' ? ['withdraw'] : []),
  ];
}

export default async function VideoPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ transcript?: string }>;
}) {
  const id = await clerkId();
  if (!id) redirect('/sign-in');
  const { id: videoId } = await params;
  const db = await database();
  const workflow = await loadWorkflow(db,id,videoId).catch((error: Error)=>{
    if (error.message==='FORBIDDEN') redirect('/editorial');
    if (['NOT_FOUND','INVALID_INPUT'].includes(error.message)) notFound();
    throw error;
  });
  if (!workflow.video) notFound();
  const video = workflow.video;
  const [publications,montages,planOptions]: [Publication[],Montage[],MontagePlanOption[]] = await Promise.all([
    loadPublications(db,id,videoId),listMontage(db,id,videoId),listUsableMontagePlans(db,id),
  ]);
  const byEpisode = new Map(publications.map(publication=>[publication.episode_id,publication]));
  const author = workflow.roles.includes('author');
  const transcripts: Transcript[] = workflow.transcripts;
  const claims: Claim[] = workflow.claims;
  const episodes: Episode[] = workflow.episodes;
  const events: WorkflowEvent[] = workflow.events;
  const shortsByEpisode=new Map(await Promise.all(episodes.map(async episode=>
    [episode.id,await listShortRenders(db,id,episode.id)] as const)));
  const grokRows=await listEpisodeGrokReviewsForEpisodes(db,id,episodes.map(episode=>episode.id)) as (EpisodeGrokReview&{episode_id:string})[];
  const grokByEpisode=new Map<string,EpisodeGrokReview[]>(episodes.map(episode=>[
    episode.id,grokRows.filter(row=>row.episode_id===episode.id),
  ]));
  const requestedTranscript = (await searchParams).transcript;
  const chosen = transcripts.find(t=>t.id===requestedTranscript);
  const segments: Segment[] = chosen ? await loadTranscript(db,id,videoId,chosen.id) : [];
  const source = 'https://www.youtube.com/watch?v='+video.youtube_id;
  // Title of the most recently touched episode (events are newest first), as in the video list.
  const latestEpisode = episodes.find(episode=>episode.id===events.find(event=>event.episode_id)?.episode_id) ?? episodes[0];
  const pageTitle = latestEpisode?.content.title || claims[0]?.content.question || 'Відео '+video.youtube_id;

  return <main className="video-card-page">
    <PageHeader
      crumbs={[{ href:'/editorial/videos', label:'Відео редакції' }, { label: pageTitle }]}
      title={pageTitle}
      lead={<>YouTube <code>{video.youtube_id}</code>{' · '}
        <a href={source} target="_blank" rel="noreferrer">Відкрити оригінал на YouTube</a></>}
      actions={<Link className="ed-button" href="/editorial/videos">← До списку відео</Link>} />
    <nav className="video-jump" aria-label="Розділи картки відео">
      <a href="#transcripts">Розшифрування</a>
      <a href="#analysis">Аналіз</a>
      <a href="#claims">Твердження · {claims.length}</a>
      <a href="#history">Історія погоджень</a>
    </nav>
    <details className="ed-card video-preview">
      <summary>Переглянути відео</summary>
      <iframe title="Відео YouTube" loading="lazy" className="video-player"
        src={'https://www.youtube-nocookie.com/embed/'+video.youtube_id} allowFullScreen />
    </details>
    <section id="transcripts" className="ed-section ed-card" aria-labelledby="transcripts-title">
      <SectionHead id="transcripts-title" title="Розшифрування" meta={transcripts.length ? 'Версій: '+transcripts.length : undefined} />
      {author && <>
        {process.env.YOUTUBE_READER_TOKEN && <YouTubeCaptionsImport videoId={videoId} />}
        <TranscriptForm videoId={videoId} />
      </>}
      {author && <CaptionsBookmarklet href={captionsBookmarkletHref()} youtubeId={video.youtube_id} />}
      {transcripts.length ? <ul className="video-transcripts">{transcripts.map(t=><li key={t.id}>
        <Link href={'?transcript='+t.id+'#transcripts'} aria-current={chosen?.id===t.id ? 'true' : undefined}>Версія {t.version} · {t.format.toUpperCase()}</Link>
      </li>)}</ul> : <Empty unavailable>Розшифрувань ще немає.</Empty>}
      {chosen && <ol className="transcript-preview">{segments.map(segment=><li key={segment.position}>
        {segment.start_ms !== null && <><a href={source+'&t='+Math.floor(Number(segment.start_ms)/1000)} target="_blank" rel="noreferrer">
          {Number(segment.start_ms)/1000} с</a>{' · '}</>}{segment.body}
      </li>)}</ol>}
      {segments.length===300 && <p className="ed-meta">Показано перші 300 фрагментів.</p>}
    </section>
    <div id="analysis" className="ed-section ed-card video-analysis">
      <AnalysisPanel videoId={videoId} transcripts={transcripts} canRun={author} />
    </div>
    <section id="claims" className="ed-section" aria-labelledby="claims-title">
      <SectionHead id="claims-title" title="Твердження" meta={'Тверджень: '+claims.length+' · сценаріїв: '+episodes.length} />
      {author && <details className="ed-card video-new"><summary>Нове твердження</summary><ClaimForm videoId={videoId} transcripts={transcripts} /></details>}
      {!claims.length && <Empty unavailable>Тверджень ще немає.</Empty>}
      {claims.map(claim=><article className="workflow-card video-claim" id={'claim-'+claim.id} key={claim.id}>
        <h3>{claim.content.question}</h3>
        <p className="video-status"><Badge tone={statusTones[claim.status] ?? 'neutral'}>{statuses[claim.status] ?? claim.status}</Badge>
          <span className="ed-meta">версія {claim.version} · ревізія {claim.revision}</span></p>
        <blockquote>{claim.content.quote}</blockquote>
        {claim.content.translation && <p>{claim.content.translation}</p>}
        {claim.content.context && <p>{claim.content.context}</p>}
        {claim.content.startMs!==null && <p><a href={source+'&t='+Math.floor(claim.content.startMs/1000)}
          target="_blank" rel="noreferrer">{claim.content.startMs/1000}–{(claim.content.endMs ?? 0)/1000} с</a></p>}
        {claim.content.verdict && <p>{verdictLabels[claim.content.verdict]} · {claim.content.explanation}</p>}
        {claim.evidence.length>0 && <ul>{claim.evidence.map((e,i)=><li key={i}>
          <a href={e.url} target="_blank" rel="noreferrer">{e.title}</a>
          {e.organization && <> · {e.organization}</>} · {e.locator} · {e.coverage}
          {e.publicationDate && <> · {e.publicationDate}</>} · перевірено {e.accessedOn}
          {e.primaryUrl && <> · <a href={e.primaryUrl} target="_blank" rel="noreferrer">Первинний документ</a></>}
        </li>)}</ul>}
        <ClaimChanges claim={claim} />
        <Transitions collection="claims" item={claim} actions={actions(claim.status,author,workflow.roles.includes('factchecker'),true)} />
        {author && claim.status!=='withdrawn' && <details><summary>Редагувати твердження</summary>
          <ClaimForm key={claim.revision} videoId={videoId} transcripts={transcripts} claim={claim} />
        </details>}
        <h4>Сценарії</h4>
        {author && claim.status==='approved' && <details><summary>Новий сценарій</summary><EpisodeForm claim={claim} /></details>}
        {author && claim.status==='approved' && <ScenarioGeminiButton claimId={claim.id} />}
        {episodes.filter(episode=>episode.claim_id===claim.id).map(episode=>{
          const reviews=grokByEpisode.get(episode.id)??[];
          const current=reviews.filter(item=>item.episode_version===episode.version).sort((a,b)=>b.round-a.round)[0];
          const preflightAccepted=current?.state==='accepted';
          const montageItems=montages.filter(item=>item.episode_id===episode.id);
          const shortsItems=shortsByEpisode.get(episode.id)??[];
          const published=byEpisode.has(episode.id);
          // Same stage rule as the overview and the video list (episodeStage), from what this page already loaded.
          const latestMontage=montageItems.filter(item=>item.episode_version===episode.version).sort((a,b)=>b.ordinal-a.ordinal)[0];
          const latestShort=[...shortsItems].filter(item=>item.episode_version===episode.version)
            .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
          const progress=episodeStage({status:episode.status,stale:episode.stale,published,grokState:current?.state??null,
            mediaState:latestMontage?.state??null,releaseApproved:Boolean(latestMontage?.release_approved),
            renderState:latestShort?.state??null,uploadState:latestShort?.youtube_upload_state??null});
          const stage=progress.anchor as Stage;
          const anchor=(part: Stage)=>'episode-'+episode.id+'-'+part;
          return <article className="workflow-card video-episode" id={'episode-'+episode.id} key={episode.id}>
            <nav className="video-stages" aria-label={'Етапи сценарію «'+episode.content.title+'»'}>
              <ol>{stages.map(([key,label])=><li key={key}>
                <a href={'#'+anchor(key)} aria-current={stage===key ? 'step' : undefined}>{label}</a>
              </li>)}</ol>
            </nav>
            <p className="video-stage-now">Поточний етап: <Badge tone={progress.tone as Tone}>{progress.label}</Badge></p>
            <div id={anchor('script')} className="video-stage">
              <h5>{episode.content.title}</h5>
              <p className="video-status">
                <Badge tone={published ? 'success' : episode.stale ? 'warning' : statusTones[episode.status] ?? 'neutral'}>
                  {published?'Опубліковано':episode.stale?'Потрібне повторне погодження':statuses[episode.status]}
                </Badge>
                <span className="ed-meta">версія {episode.version} · ревізія {episode.revision} · твердження {episode.claim_version}</span>
              </p>
              <p className="workflow-text">{episode.content.script}</p>
              <details><summary>Матеріали сценарію</summary>
                {Object.entries(episode.content).filter(([key,value])=>!['title','script'].includes(key)&&value)
                  .map(([key,value])=><p className="workflow-text" key={key}>{value}</p>)}
              </details>
              {!byEpisode.has(episode.id) && <Transitions collection="episodes" item={episode}
                actions={actions(episode.status,author,workflow.roles.includes('editor'),false,episode.stale)} />}
              {author && claim.status==='approved' && !byEpisode.has(episode.id) && <details><summary>Редагувати сценарій</summary>
                <EpisodeForm key={episode.revision} claim={claim} episode={episode} />
              </details>}
            </div>
            <div id={anchor('grok')} className="video-stage">
              <EpisodeGrokReviewPanel episode={episode} reviews={reviews}
                canRun={author&&episode.status==='approved'&&!episode.stale&&!byEpisode.has(episode.id)}
                canAccept={workflow.roles.includes('editor')&&episode.status==='approved'} />
            </div>
            <div id={anchor('montage')} className="video-stage">
              <MontagePanel episode={episode} items={montages.filter(item=>item.episode_id===episode.id)}
                canUpload={author&&preflightAccepted&&episode.status==='approved'&&!episode.stale&&!byEpisode.has(episode.id)}
                canReview={workflow.roles.includes('editor')} />
            </div>
            <div id={anchor('shorts')} className="video-stage">
              <ShortsPanel episode={episode}
                plans={planOptions}
                sources={montages.filter(item=>item.episode_id===episode.id).map(item=>({id:item.id,episode_version:item.episode_version,state:item.state}))}
                items={shortsByEpisode.get(episode.id)??[]}
                canCreate={author&&preflightAccepted&&episode.status==='approved'&&!episode.stale&&!byEpisode.has(episode.id)}
                canReview={workflow.roles.includes('editor')} canPublish={workflow.roles.includes('publisher')} />
            </div>
            <div id={anchor('publication')} className="video-stage">
              <PublicationPanel episode={episode} publication={byEpisode.get(episode.id)} roles={workflow.roles}
                mediaRevisions={montages.filter(item=>item.episode_id===episode.id).map(item=>({
                  id:item.id,ordinal:item.ordinal,version:item.episode_version,sha256:item.sha256,
                  releaseApproved:item.release_approved&&item.state==='passed'&&item.episode_version===episode.version,
                }))} />
            </div>
          </article>;
        })}
      </article>)}
    </section>
    <section id="history" className="ed-section" aria-labelledby="history-title">
      <SectionHead id="history-title" title="Історія погоджень" meta="Час — за Києвом" />
      {events.length>0 ? <ol className="ed-card video-history">{events.map(event=><li key={(event.claim_id ?? event.episode_id)+':'+event.revision}>
        {event.episode_id?'Сценарій':'Твердження'} · {eventLabels[event.action]} · версія {event.version}
        {' · '}{new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Kyiv'}).format(new Date(event.created_at))}
         · {event.actor}{event.comment && <> · {event.comment}</>}
      </li>)}</ol> : <Empty unavailable>Погоджень ще не було.</Empty>}
    </section>
  </main>;
}
