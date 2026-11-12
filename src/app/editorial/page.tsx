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

export const dynamic = 'force-dynamic';

export default async function Editorial({searchParams}:{searchParams:Promise<{youtube?:string}>}) {
  const id = await clerkId();
  if (!id) redirect('/sign-in');
  const db = await database();
  const member = await activeMember(db, id);
  if (!member) return <main><UserButton /><h1>Доступ до редакції закрито</h1><Link href="/invite">Маю запрошення</Link></main>;
  const access = member.roles.includes('admin') ? await listAccess(db, id) : null;
  const youtubeConnection = member.roles.includes('publisher') ? await getYouTubeConnection(db,id) : null;
  const youtubeOAuthConfigured=Boolean(process.env.GOOGLE_YOUTUBE_CLIENT_ID&&process.env.GOOGLE_YOUTUBE_CLIENT_SECRET
    &&process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
  const { videos } = await loadWorkflow(db, id);
  const result=(await searchParams).youtube;

  return <main>
    <UserButton />
    <h1>Редакція «Тінь Шарія»</h1>
    {member.roles.includes('publisher')&&<YouTubeConnectionPanel connection={youtubeConnection} result={result} configured={youtubeOAuthConfigured} />}
    <p><Link href="/editorial/youtube-channel">Останні випуски каналу Шарія · YouTube</Link></p>
    <section><h2>Відео</h2>
      {member.roles.includes("author") && <VideoForm />}
      {videos.length ? <EditorialVideosTable videos={videos.map((video: {
        id: string; youtube_id: string; created_at: Date | string;
      }) => ({
        id: video.id, youtubeId: video.youtube_id, createdAt: new Date(video.created_at).toISOString(),
      }))} /> : <p>Відео ще немає.</p>}
    </section>
    {access && <>
      <h2>Запросити учасника</h2>
      <InviteForm />
      <h2>Учасники</h2>
      <ul>{access.members.map((member: { id: string; email: string; revoked_at: string | null; roles: string[] }) => <li key={member.id}>
        {member.email}
        {member.revoked_at ? <p>Доступ відкликано</p> : <MemberForm key={member.roles.join(',')} id={member.id} roles={member.roles} />}
      </li>)}</ul>
      <h2>Активні запрошення</h2>
      {access.invitations.length === 0 ? <p>Активних запрошень немає.</p> :
        <ul>{access.invitations.map((invite: { email: string }) => <li key={invite.email}>{invite.email}<CancelInviteForm email={invite.email} /></li>)}</ul>}
    </>}
  </main>;
}
