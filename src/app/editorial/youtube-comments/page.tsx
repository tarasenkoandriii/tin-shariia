import Link from 'next/link';
import {UserButton} from '@clerk/nextjs';
import {redirect} from 'next/navigation';
import {activeMember} from '../../../access/membership.mjs';
import {clerkId} from '../../../access/session';
import {database} from '../../../db/runtime.mjs';
import {loadYouTubeCommentDashboard} from '../../../db/youtube-comments.mjs';
import {YouTubeCommentDashboard,type CommentDashboardData} from './youtube-comment-dashboard';

export const dynamic='force-dynamic';

export default async function YouTubeCommentsPage(){
  const identity=await clerkId();if(!identity)redirect('/sign-in');
  const db=await database(),member=await activeMember(db,identity);
  if(!member||!member.roles.some((role:string)=>['admin','editor','publisher'].includes(role)))redirect('/editorial');
  const initial=await loadYouTubeCommentDashboard(db,identity) as CommentDashboardData;
  return <main className="editorial-workspace youtube-comment-page">
    <header className="editorial-header"><Link href="/editorial">← До редакції</Link><UserButton /></header>
    <h1>Коментарі до випусків і вихідних відео</h1>
    <p>Grok готує доречну чернетку для опублікованого Shorts. Редактор переглядає точний текст і посилання; тільки після схвалення коментар потрапляє в чергу публікації.</p>
    <YouTubeCommentDashboard initial={initial} canManage={member.roles.includes('admin')} canApprove={member.roles.includes('editor')} />
  </main>;
}
