import Link from 'next/link';
import {redirect} from 'next/navigation';
import {clerkId} from '../../../access/session';
import {database} from '../../../db/runtime.mjs';
import {listMontagePlans} from '../../../db/montage-plans.mjs';
import {MontagePlansDashboard,type MontagePlan} from './plans-dashboard';

export const dynamic='force-dynamic';
export default async function MontagePlansPage(){
  const identity=await clerkId();if(!identity)redirect('/sign-in');
  const plans=await listMontagePlans(await database(),identity) as MontagePlan[];
  return <main className="editorial-workspace montage-plan-page">
    <Link href="/editorial">До редакції</Link>
    <h1>Монтажні плани</h1>
    <p>Поточний редакційний стандарт лишається типовим. Створюйте його копії, редагуйте вручну або просіть Gemini підготувати варіант. Перед збереженням перевіряйте повний план.</p>
    <p className="workflow-card">Горизонтальні плани 16:9 можна налаштовувати та зберігати. Тестовий рендер у цій версії доступний для Shorts 9:16: фрагменти склеюються, редактор може накласти перевірений SRT на готовий таймлайн, а штамп плану з’являється в останні 2 секунди. Ілюстрації та повний горизонтальний випуск ще не підключені.</p>
    <MontagePlansDashboard initialPlans={plans}/>
  </main>;
}
