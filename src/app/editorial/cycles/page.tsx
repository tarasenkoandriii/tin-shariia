import {redirect} from 'next/navigation';
import {PageHeader} from '../ui';
import {clerkId} from '../../../access/session';
import {database} from '../../../db/runtime.mjs';
import {activeMember} from '../../../access/membership.mjs';
import {CyclePanel,type CycleRow} from './panel';
export const dynamic='force-dynamic';
export default async function Cycles(){const identity=await clerkId();if(!identity)redirect('/sign-in');
 const member=await activeMember(await database(),identity);if(!member?.roles.includes('admin'))return <main>Доступ закрито.</main>;
 const {rows}=await (await database()).query(`SELECT id,state,stage_index,release_state,youtube_id,promotion_state,code,events,artifacts->'scenario' AS scenario,artifacts->'grok' AS grok FROM editorial_cycles WHERE created_by=$1 ORDER BY created_at DESC LIMIT 30`,[member.id]);
 return <main><PageHeader title="Автоматичні випуски Shorts" /><CyclePanel initialRows={rows as CycleRow[]}/></main>;}
