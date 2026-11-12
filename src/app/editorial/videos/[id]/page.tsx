import Link from 'next/link';
import { listMontage } from '../../../../db/montage.mjs';
import { MontagePanel, type Montage } from '../../montage-panel';
import { ShortsPanel } from '../../shorts-panel';
import { listShortRenders } from '../../../../db/shorts.mjs';
import { loadPublications } from '../../../../db/publications.mjs';
import { PublicationPanel, type Publication } from '../../publication-panel';
import { AnalysisPanel } from '../../analysis-panel';
import { notFound, redirect } from 'next/navigation';
import { clerkId } from '../../../../access/session';
import { database } from '../../../../db/runtime.mjs';
import { loadTranscript, loadWorkflow } from '../../../../db/editorial-workflow.mjs';
import { ClaimForm, EpisodeForm, TranscriptForm, Transitions } from '../../workflow-controls';
import { verdictLabels } from "../../workflow-types";
import type { Claim, ClaimContent, Episode, Transcript } from '../../workflow-types';

type Segment = { position: number; start_ms: string | null; end_ms: string | null; body: string };
type WorkflowEvent = {
  claim_id: string | null; episode_id: string | null; version: number; revision: number;
  action: string; comment: string; actor: string; created_at: string | Date;
};
const statuses: Record<string,string> = { draft:'Чернетка', review:'На перевірці', approved:'Погоджено', withdrawn:'Знято з роботи' };
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
  const [publications,montages]: [Publication[],Montage[]] = await Promise.all([loadPublications(db,id,videoId),listMontage(db,id,videoId)]);
  const byEpisode = new Map(publications.map(publication=>[publication.episode_id,publication]));
  const author = workflow.roles.includes('author');
  const transcripts: Transcript[] = workflow.transcripts;
  const claims: Claim[] = workflow.claims;
  const episodes: Episode[] = workflow.episodes;
  const events: WorkflowEvent[] = workflow.events;
  const shortsByEpisode=new Map(await Promise.all(episodes.map(async episode=>
    [episode.id,await listShortRenders(db,id,episode.id)] as const)));
  const requestedTranscript = (await searchParams).transcript;
  const chosen = transcripts.find(t=>t.id===requestedTranscript);
  const segments: Segment[] = chosen ? await loadTranscript(db,id,videoId,chosen.id) : [];
  const source = 'https://www.youtube.com/watch?v='+video.youtube_id;

  return <main>
    <Link href="/editorial">До редакції</Link>
    <h1>Відео {video.youtube_id}</h1>
    <a href={source} target="_blank" rel="noreferrer">Відкрити оригінал на YouTube</a>
    <details>
      <summary>Переглянути відео</summary>
      <iframe title="Відео YouTube" loading="lazy" className="video-player"
        src={'https://www.youtube-nocookie.com/embed/'+video.youtube_id} allowFullScreen />
    </details>
    <section>
      <h2>Розшифрування</h2>
      {author && <TranscriptForm videoId={videoId} />}
      {transcripts.length ? <ul>{transcripts.map(t=><li key={t.id}>
        <Link href={'?transcript='+t.id}>Версія {t.version} · {t.format.toUpperCase()}</Link>
      </li>)}</ul> : <p>Розшифрувань ще немає.</p>}
      {chosen && <ol className="transcript-preview">{segments.map(segment=><li key={segment.position}>
        {segment.start_ms !== null && <><a href={source+'&t='+Math.floor(Number(segment.start_ms)/1000)} target="_blank" rel="noreferrer">
          {Number(segment.start_ms)/1000} с</a>{' · '}</>}{segment.body}
      </li>)}</ol>}
      {segments.length===300 && <p>Показано перші 300 фрагментів.</p>}
    </section>
    <AnalysisPanel videoId={videoId} transcripts={transcripts} canRun={author} />
    <section>
      <h2>Твердження</h2>
      {author && <details><summary>Нове твердження</summary><ClaimForm videoId={videoId} transcripts={transcripts} /></details>}
      {claims.map(claim=><article className="workflow-card" key={claim.id}>
        <h3>{claim.content.question}</h3>
        <p>{statuses[claim.status]} · версія {claim.version} · ревізія {claim.revision}</p>
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
        {episodes.filter(episode=>episode.claim_id===claim.id).map(episode=><article className="workflow-card" key={episode.id}>
          <h5>{episode.content.title}</h5>
          <p>{byEpisode.has(episode.id)?'Опубліковано':episode.stale?'Потрібне повторне погодження':statuses[episode.status]} · версія {episode.version} · ревізія {episode.revision} · твердження {episode.claim_version}</p>
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
          <MontagePanel episode={episode} items={montages.filter(item=>item.episode_id===episode.id)}
            canUpload={author&&episode.status==='approved'&&!episode.stale&&!byEpisode.has(episode.id)}
            canReview={workflow.roles.includes('editor')} />
          <ShortsPanel episode={episode}
            sources={montages.filter(item=>item.episode_id===episode.id).map(item=>({id:item.id,episode_version:item.episode_version,state:item.state}))}
            items={shortsByEpisode.get(episode.id)??[]}
            canCreate={author&&episode.status==='approved'&&!episode.stale&&!byEpisode.has(episode.id)} />
          <PublicationPanel episode={episode} publication={byEpisode.get(episode.id)} roles={workflow.roles}
            mediaRevisions={montages.filter(item=>item.episode_id===episode.id).map(item=>({
              id:item.id,ordinal:item.ordinal,version:item.episode_version,sha256:item.sha256,
              releaseApproved:item.release_approved&&item.state==='passed'&&item.episode_version===episode.version,
            }))} />
        </article>)}
      </article>)}
    </section>
    {events.length>0 && <section><h2>Історія погоджень</h2><ol>{events.map(event=><li key={(event.claim_id ?? event.episode_id)+':'+event.revision}>
      {event.episode_id?'Сценарій':'Твердження'} · {eventLabels[event.action]} · версія {event.version}
      {' · '}{new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Kyiv'}).format(new Date(event.created_at))}
       · {event.actor}{event.comment && <> · {event.comment}</>}
    </li>)}</ol></section>}
  </main>;
}
