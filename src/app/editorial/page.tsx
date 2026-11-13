import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { activeMember, listAccess } from '../../access/membership.mjs';
import { clerkId } from '../../access/session';
import { database } from '../../db/runtime.mjs';
import { CancelInviteForm, InviteForm, MemberForm } from './forms';
import { loadWorkflow } from "../../db/editorial-workflow.mjs";
import { VideoForm } from "./workflow-controls";
import { EditorialVideosTable } from './editorial-videos-table';
import { YouTubeConnectionPanel } from './youtube-connection-panel';
import { getYouTubeConnection } from '../../db/youtube-uploads.mjs';
import {GrokSettings} from './grok-settings';
import {readGrokAutoAcceptScore} from '../../db/episode-grok.mjs';

export const dynamic = 'force-dynamic';

export default async function Editorial({searchParams}:{searchParams:Promise<{youtube?:string}>}) {
  const id = await clerkId();
  if (!id) redirect('/sign-in');
  const db = await database();
  const member = await activeMember(db, id);
  if (!member) return <main><UserButton /><h1>Доступ до редакції закрито</h1><Link href="/invite">Маю запрошення</Link></main>;
  const access = member.roles.includes('admin') ? await listAccess(db, id) : null;
  const grokAutoAcceptScore = access ? await readGrokAutoAcceptScore(db,id) : null;
  const youtubeConnection = member.roles.includes('publisher') ? await getYouTubeConnection(db,id) : null;
  const youtubeOAuthConfigured=Boolean(process.env.GOOGLE_YOUTUBE_CLIENT_ID&&process.env.GOOGLE_YOUTUBE_CLIENT_SECRET
    &&process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
  const { videos } = await loadWorkflow(db, id);
  const result=(await searchParams).youtube;

  return <main className="editorial-workspace">
    <header className="editorial-header">
      <h1>Редакція «Тінь Шарія»</h1>
      <UserButton />
    </header>
    <nav className="editorial-nav" aria-label="Розділи редакції">
      <a href="#videos">Відео редакції</a>
      <Link href="/editorial/youtube-channel">Випуски з YouTube</Link>
      {access&&<Link href="/editorial/montage-plans">Монтажні плани</Link>}
      {member.roles.includes('publisher')&&<Link href="/editorial/youtube-comments">Коментарі та переходи</Link>}
      {member.roles.includes('publisher') && <a href="#youtube">Підключення YouTube</a>}
      {access && <a href="#team">Команда</a>}
    </nav>
    <section id="videos" className="editorial-panel" aria-labelledby="videos-title">
      <header className="editorial-section-heading">
        <h2 id="videos-title">Відео редакції</h2>
        <span>{videos.length} у списку</span>
      </header>
      {member.roles.includes('author') && <details className="editorial-import">
        <summary>Додати відео за посиланням</summary>
        <VideoForm />
      </details>}
      {videos.length ? <EditorialVideosTable videos={videos.map((video: {
        id: string; youtube_id: string; created_at: Date | string;
      }) => ({
        id: video.id, youtubeId: video.youtube_id, createdAt: new Date(video.created_at).toISOString(),
      }))} /> : <p>Відео ще немає.</p>}
    </section>
    {member.roles.includes('publisher') && <section id="youtube" aria-label="Підключення YouTube">
      <YouTubeConnectionPanel connection={youtubeConnection} result={result} configured={youtubeOAuthConfigured} />
    </section>}
    {access && <section id="team" className="editorial-panel" aria-labelledby="team-title">
      <h2 id="team-title">Команда</h2>
      <details><summary>Запросити учасника</summary><InviteForm /></details>
      <details>
        <summary>Учасники · {access.members.length}</summary>
        <ul>{access.members.map((member: { id: string; email: string; revoked_at: string | null; roles: string[] }) => <li key={member.id}>
          {member.email}
          {member.revoked_at ? <p>Доступ відкликано</p> : <MemberForm key={member.roles.join(',')} id={member.id} roles={member.roles} />}
        </li>)}</ul>
      </details>
      <details>
        <summary>Активні запрошення · {access.invitations.length}</summary>
        {access.invitations.length === 0 ? <p>Активних запрошень немає.</p> :
          <ul>{access.invitations.map((invite: { email: string }) => <li key={invite.email}>{invite.email}<CancelInviteForm email={invite.email} /></li>)}</ul>}
      </details>
    </section>}
    {access&&grokAutoAcceptScore!==null&&<GrokSettings initialScore={grokAutoAcceptScore} />}
  </main>;
}
