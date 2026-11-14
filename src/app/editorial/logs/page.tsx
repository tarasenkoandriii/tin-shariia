import Link from 'next/link';
import {redirect} from 'next/navigation';
import {UserButton} from '@clerk/nextjs';
import {clerkId} from '../../../access/session';
import {activeMember} from '../../../access/membership.mjs';
import {database} from '../../../db/runtime.mjs';
import {loadProjectLog,logProcesses} from '../../../db/project-log.mjs';
import {LogRefresh} from './refresh';
import './style.css';
export const dynamic='force-dynamic';
type Row={key:string;process:string;state:string;time:string;linked_video_id:string|null;title:string;youtube_id:string|null;level:string;kind:string;message:string;error_code:string|null;explanation:string|null;details:Record<string,string|number|null>|null};
const detailLabels:Record<string,string>={sourceYoutubeId:'Вихідне відео',claimVersion:'Версія фактчеку',reasonId:'Категорія',secondaryReasonId:'Підкатегорія',reasonLabel:'Назва категорії',approvedBy:'Схвалив',actor:'Виконав',sentAt:'Надіслано',httpStatus:'Відповідь YouTube',reporterChannelId:'Канал скаржника'};
const levels:Record<string,string>={error:'Помилка',warning:'Потрібна увага',active:'У роботі',success:'Успішно / інформація'};
export default async function ProjectLogs({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const identity=await clerkId();if(!identity)redirect('/sign-in');
 const db=await database(),member=await activeMember(db,identity);if(!member?.roles.includes('admin'))redirect('/editorial');
 const data=await loadProjectLog(db,identity,await searchParams),f=data.filters;
 const pageLink=(page:number)=>{const p=new URLSearchParams();for(const [key,value] of Object.entries(f)){if(value&&key!=='page')p.set(key,String(value));}p.set('page',String(page));return '/editorial/logs?'+p;};
 return <main className="editorial-workspace project-log">
 <header className="editorial-header"><Link href="/editorial">← До редакції</Link><UserButton/></header>
 <h1>Журнал проєкту</h1><p>Що виконується, що завершилося та де потрібна увага. Час — Київ.</p>
 <LogRefresh/>
 <form className="log-filters" action="/editorial/logs">
 <label>Процес<select name="process" defaultValue={f.process}><option value="">Усі процеси</option>{Object.entries(logProcesses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
 <label>Результат<select name="level" defaultValue={f.level}><option value="">Усі результати</option>{Object.entries(levels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
 <label>Від<input type="date" name="from" defaultValue={f.from}/></label><label>До включно<input type="date" name="to" defaultValue={f.to}/></label>
 <label className="log-search">Пошук<input name="q" defaultValue={f.q} maxLength={160} placeholder="Назва, YouTube ID або код помилки"/></label>
 <button>Застосувати</button><Link href="/editorial/logs">Скинути</Link></form>
 <div className="log-summary"><span>Записів: <strong>{data.total}</strong></span><span>У роботі: <strong>{data.active}</strong></span><span>Помилки: <strong>{data.errors}</strong></span><span>Потребують уваги: <strong>{data.warnings}</strong></span></div>
 <p className="log-note">«Подія» — збережена дія в історії. «Поточний стан» — останній відомий стан завдання, а не історія всіх його переходів. Для монтажу час — створення завдання. Лічильники рахують записи, а не унікальні ролики. Внутрішні журнали VPS та Vercel сюди не входять.</p>
 <section aria-label="Записи журналу" className="log-list">{data.items.length?data.items.map((row:Row)=><article key={row.key} className={'log-entry log-'+row.level}>
 <div className="log-entry-meta"><time dateTime={row.time}>{new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'medium',timeZone:'Europe/Kyiv'}).format(new Date(row.time))}</time><span>{logProcesses[row.process as keyof typeof logProcesses]}</span><span className="log-badge">{levels[row.level]}</span><small>{row.kind==='event'?'Подія':'Поточний стан'}</small></div>
 <h2>{row.message}</h2><p>{row.linked_video_id?<Link href={'/editorial/videos/'+row.linked_video_id}>{row.title}</Link>:row.title}</p>
 {row.details&&<dl className="log-details">{Object.entries(row.details).filter(([,value])=>value!==null&&value!=='').map(([key,value])=><div key={key}><dt>{detailLabels[key]??key}</dt><dd>{key==='sentAt'?new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'medium',timeZone:'Europe/Kyiv'}).format(new Date(String(value))):String(value)}</dd></div>)}</dl>}
{row.error_code&&<p className="log-error">{row.explanation??'Відкрийте картку для подробиць; перед повторною відправкою перевірте результат попередньої спроби.'} Код: <code>{row.error_code}</code>.</p>}
 <details><summary>Ідентифікатор запису</summary><code>{row.key}</code></details></article>):<p>За цими фільтрами записів немає.</p>}</section>
 <nav className="log-pagination" aria-label="Сторінки журналу">{f.page>1&&<Link href={pageLink(f.page-1)}>← Попередня</Link>}<span>Сторінка {f.page} · по 50 записів</span>{f.page*50<data.total&&<Link href={pageLink(f.page+1)}>Наступна →</Link>}</nav>
 </main>;
}
