import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { activeMember } from '../../../access/membership.mjs';
import { clerkId } from '../../../access/session';
import { database } from '../../../db/runtime.mjs';
import { listShariyChannelVideos } from '../../../youtube/shariy-channel.mjs';
import { YouTubeShortProposal } from '../youtube-short-proposal';
import { ChannelVideos } from '../channel-videos';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ pageToken?: string }>;

export default async function YouTubeChannelPage({ searchParams }: { searchParams: SearchParams }) {
  const identity = await clerkId();
  if (!identity) redirect('/sign-in');
  const member = await activeMember(await database(), identity);
  if (!member) return <main><UserButton />
    <h1>Доступ до редакції закрито</h1><Link href="/invite">Маю запрошення</Link></main>;

  const { pageToken } = await searchParams;
  let data;
  let errorCode = '';
  try { data = await listShariyChannelVideos(pageToken); }
  catch (error) { errorCode = error instanceof Error ? error.message : 'YOUTUBE_READ_FAILED'; }

  return <main className="editorial-workspace">
    <header className="editorial-header"><Link href="/editorial">← Відео редакції</Link><UserButton /></header>
    <h1>Випуски каналу Анатолія Шарія</h1>
    <p>Останні відео з YouTube. Новіші випуски зверху; сторінки містять по 20 відео.</p>
    {(member.roles.includes('author') || member.roles.includes('publisher')) && <YouTubeShortProposal />}
    {data ? <ChannelVideos data={data} pageToken={pageToken} /> : errorCode === 'YOUTUBE_API_NOT_CONFIGURED' ?
      <section className="workflow-card"><h2>Потрібне підключення YouTube Data API</h2>
        <p>Для списку випусків, статистики переглядів, вподобань і пагінації в Production потрібен серверний секрет <code>YOUTUBE_API_KEY</code> з доступом до YouTube Data API v3. Ключ не передається браузеру.</p>
      </section> : errorCode === 'YOUTUBE_CHANNEL_NOT_FOUND' ?
        <p role="alert">Не вдалося підтвердити ID каналу в YouTube. Перевірте конфігурацію каналу.</p> :
        <p role="alert">YouTube тимчасово не повернув список відео. Спробуйте оновити сторінку пізніше.</p>}
  </main>;
}
