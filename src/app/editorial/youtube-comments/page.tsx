import {redirect} from 'next/navigation';
import {activeMember} from '../../../access/membership.mjs';
import {clerkId} from '../../../access/session';
import {database} from '../../../db/runtime.mjs';
import {loadYouTubeCommentDashboard} from '../../../db/youtube-comments.mjs';
import {PageHeader} from '../ui';
import {YouTubeCommentDashboard,type CommentDashboardData,type VisibilityFilter} from './youtube-comment-dashboard';
import './style.css';

export const dynamic='force-dynamic';

// A value from a 'use client' module would arrive here as a client reference, so the list lives on the server side.
const visibilityFilters:VisibilityFilter[]=['confirmed','checking','not_confirmed'];

export default async function YouTubeCommentsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const identity=await clerkId();if(!identity)redirect('/sign-in');
  const db=await database(),member=await activeMember(db,identity);
  if(!member||!member.roles.some((role:string)=>['admin','editor','publisher'].includes(role)))redirect('/editorial');
  const initial=await loadYouTubeCommentDashboard(db,identity) as CommentDashboardData;
  const requested=(await searchParams).visibility;
  const visibility:VisibilityFilter|null=visibilityFilters.find(value=>value===requested)??null;
  return <main className="yc-page">
    <PageHeader title="Коментарі та переходи"
      lead="Grok готує чернетку коментаря до опублікованого Shorts; редактор перевіряє точний текст і посилання, і лише після схвалення коментар стає в чергу публікації. Тут же — перевірка видимості та статистика переходів." />
    <YouTubeCommentDashboard initial={initial} canManage={member.roles.includes('admin')} canApprove={member.roles.includes('editor')} visibilityFilter={visibility} />
  </main>;
}
