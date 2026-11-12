import { activeMember } from '../access/membership.mjs';
import { database } from '../db/runtime.mjs';

export async function reserveSoniox(identity: string, requestId: string) {
    const db = await database();
    await db.transaction(async (tx:{query:typeof db.query})=>{
      await tx.query('SELECT pg_advisory_xact_lock(72036601)');
      const member = await activeMember(tx,identity);
      if (!member?.roles.some((role:string)=>['admin','author','editor'].includes(role))) throw Error('FORBIDDEN');
      const {rows:[existing]} = await tx.query('SELECT id FROM soniox_requests WHERE id=$1',[requestId]);
      if (existing) throw Error('SONIOX_DUPLICATE');
      const {rows:[count]} = await tx.query(`SELECT count(*) AS total,
        count(*) FILTER (WHERE member_id=$1) AS actor FROM soniox_requests
        WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[member.id]);
      if (Number(count.total)>=10 || Number(count.actor)>=3) throw Error('SONIOX_QUOTA');
      await tx.query('INSERT INTO soniox_requests(id,member_id) VALUES($1,$2)',[requestId,member.id]);
    });
}
