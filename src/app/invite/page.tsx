import Link from 'next/link';
import { clerkId } from '../../access/session';
import { AcceptInvite } from './form';

export const dynamic = 'force-dynamic';

export default async function Invite() {
  return <main><h1>Запрошення до редакції</h1>
    {await clerkId() ? <AcceptInvite /> : <p><Link href="/sign-in">Увійти</Link> або <Link href="/sign-up">створити обліковий запис</Link> із запрошеною адресою.</p>}
  </main>;
}
