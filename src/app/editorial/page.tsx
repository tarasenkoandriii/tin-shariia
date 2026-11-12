import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { activeMember, listAccess } from '../../access/membership.mjs';
import { clerkId } from '../../access/session';
import { database } from '../../db/runtime.mjs';
import { CancelInviteForm, InviteForm, MemberForm } from './forms';
import { loadWorkflow } from "../../db/editorial-workflow.mjs";
import { VideoForm } from "./workflow-controls";

export const dynamic = 'force-dynamic';

export default async function Editorial() {
  const id = await clerkId();
  if (!id) redirect('/sign-in');
  const db = await database();
  const member = await activeMember(db, id);
  if (!member) return <main><UserButton /><h1>Доступ до редакції закрито</h1><Link href="/invite">Маю запрошення</Link></main>;
  const access = member.roles.includes('admin') ? await listAccess(db, id) : null;
  const { videos } = await loadWorkflow(db, id);

  return <main>
    <UserButton />
    <h1>Редакція «Тінь Шарія»</h1>
    <p><Link href="/editorial/youtube-channel">Останні випуски каналу Шарія · YouTube</Link></p>
    <section><h2>Відео</h2>
      {member.roles.includes("author") && <VideoForm />}
      {videos.length ? <ul>{videos.map((video: { id: string; youtube_id: string }) => <li key={video.id}>
        <Link href={"/editorial/videos/"+video.id}>{video.youtube_id}</Link>
      </li>)}</ul> : <p>Відео ще немає.</p>}
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
