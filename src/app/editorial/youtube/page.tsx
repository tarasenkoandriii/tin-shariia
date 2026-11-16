import { redirect } from 'next/navigation';
import { activeMember } from '../../../access/membership.mjs';
import { clerkId } from '../../../access/session';
import { database } from '../../../db/runtime.mjs';
import { getYouTubeConnection } from '../../../db/youtube-uploads.mjs';
import { YouTubeConnectionPanel } from '../youtube-connection-panel';
import { PageHeader } from '../ui';

export const dynamic = 'force-dynamic';

export default async function YouTubeConnectionPage({ searchParams }: { searchParams: Promise<{ youtube?: string }> }) {
  const identity = await clerkId();
  if (!identity) redirect('/sign-in');
  const db = await database();
  const member = await activeMember(db, identity);
  // Same rule as getYouTubeConnection: only publishers manage the channel connection.
  if (!member?.roles.includes('publisher')) redirect('/editorial');
  const connection = await getYouTubeConnection(db, identity);
  const configured = Boolean(process.env.GOOGLE_YOUTUBE_CLIENT_ID && process.env.GOOGLE_YOUTUBE_CLIENT_SECRET
    && process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
  return <main>
    <PageHeader title="Підключення YouTube"
      lead="Канал, від імені якого редакція завантажує Shorts і публікує схвалені коментарі. Дозвіл на коментарі надається окремо на сторінці коментарів." />
    <section className="ed-card ed-youtube-connection">
      <YouTubeConnectionPanel connection={connection} result={(await searchParams).youtube} configured={configured} />
    </section>
  </main>;
}
