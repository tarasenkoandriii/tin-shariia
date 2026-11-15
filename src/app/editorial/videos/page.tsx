import Link from 'next/link';
import { redirect } from 'next/navigation';
import { activeMember } from '../../../access/membership.mjs';
import { clerkId } from '../../../access/session';
import { listEditorialVideos } from '../../../db/editorial-overview.mjs';
import { database } from '../../../db/runtime.mjs';
import { EditorialVideosTable, type EditorialVideo } from '../editorial-videos-table';
import { can } from '../sections';
import { Empty, PageHeader } from '../ui';
import { VideoForm } from '../workflow-controls';

export const dynamic = 'force-dynamic';

const stages = [
  { key: '', label: 'Усі' }, { key: 'review', label: 'На перевірці' }, { key: 'production', label: 'У виробництві' },
  { key: 'published', label: 'Опубліковано' }, { key: 'factcheck', label: 'Фактчек' }, { key: 'idle', label: 'Без активних задач' },
];

export default async function EditorialVideosPage({ searchParams }: { searchParams: Promise<{ stage?: string; add?: string }> }) {
  const identity = await clerkId();
  if (!identity) redirect('/sign-in');
  const db = await database();
  const member = await activeMember(db, identity);
  if (!member) redirect('/editorial');
  const params = await searchParams;
  const requested = params.stage ?? '';
  const stage = stages.some(item => item.key === requested) ? requested : '';
  const videos: EditorialVideo[] = (await listEditorialVideos(db, identity, { stage })).map((video: EditorialVideo & { createdAt: string | Date; time: string | Date | null }) => ({
    ...video, createdAt: new Date(video.createdAt).toISOString(), time: video.time ? new Date(video.time).toISOString() : null,
  }));
  const addVideo = can.addVideo(member.roles);

  return <main>
    <PageHeader title="Відео редакції"
      lead="Ролики, які редакція перевіряє: від першого твердження до опублікованого Shorts. Етап рахується за фактичними статусами."
      actions={addVideo ? <Link className="ed-button ed-primary" href={'/editorial/videos?add=1' + (stage ? '&stage=' + stage : '') + '#add-video'}>Додати відео</Link> : undefined} />
    <nav className="ed-chips" aria-label="Фільтр за етапом">
      {stages.map(item => <Link key={item.key || 'all'} className="ed-chip" aria-current={item.key === stage ? 'true' : undefined}
        href={item.key ? '/editorial/videos?stage=' + item.key : '/editorial/videos'}>{item.label}</Link>)}
    </nav>
    {addVideo && <details className="ed-card ed-add-video" id="add-video" open={params.add === '1'}>
      <summary>Додати відео за посиланням YouTube</summary>
      <VideoForm />
    </details>}
    {videos.length ? <EditorialVideosTable videos={videos} />
      : <Empty>{stage ? 'На цьому етапі відео немає.' : 'Відео ще немає. Додайте перше за посиланням YouTube.'}</Empty>}
    {videos.length === 200 && <p className="ed-meta">Показано 200 останніх відео.</p>}
  </main>;
}
