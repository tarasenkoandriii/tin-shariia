import {redirect} from 'next/navigation';
import {activeMember} from '../../../access/membership.mjs';
import {clerkId} from '../../../access/session';
import {database} from '../../../db/runtime.mjs';
import {listMontagePlans} from '../../../db/montage-plans.mjs';
import {MontagePlansDashboard,type MontagePlan} from './plans-dashboard';
import {PageHeader} from '../ui';

export const dynamic='force-dynamic';
export default async function MontagePlansPage(){
  const identity=await clerkId();if(!identity)redirect('/sign-in');
  const db=await database();
  // listMontagePlans throws FORBIDDEN for non-admins; send them back instead of failing with 500.
  const member=await activeMember(db,identity);if(!member?.roles.includes('admin'))redirect('/editorial');
  const plans=await listMontagePlans(db,identity) as MontagePlan[];
  return <main className="editorial-workspace montage-plan-page">
    <PageHeader title="Монтажні плани"
      lead="Поточний редакційний стандарт лишається типовим. Створюйте його копії, редагуйте вручну або просіть Gemini підготувати варіант. Перед збереженням перевіряйте повний план." />
    <p className="workflow-card">Горизонтальні плани 16:9 можна налаштовувати та зберігати. Тестовий рендер у цій версії доступний для Shorts 9:16: фрагменти склеюються, редактор може накласти перевірений SRT на готовий таймлайн, а штамп плану з’являється в останні 2 секунди. Ілюстрації та повний горизонтальний випуск ще не підключені.</p>
    <MontagePlansDashboard initialPlans={plans}/>
  </main>;
}
