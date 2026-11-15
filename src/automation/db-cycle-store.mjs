import {randomUUID} from 'node:crypto';
import {cycleStages} from './editorial-cycle.mjs';
import {activeMember} from '../access/membership.mjs';

const fromRow=r=>r?{id:r.id,state:r.state,stageIndex:r.stage_index,policy:r.policy,artifacts:r.artifacts,events:r.events,
 releaseState:r.release_state,youtubeId:r.youtube_id,promotionState:r.promotion_state,code:r.code}:null;
const uncertainStages=new Set(['factcheck','scenario','grok','render','audit','upload','comment']);
export function dbCycleStore(db,identity) {
 return {
  async create(policy) {
   const member=await activeMember(db,identity);
   if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
   if(!/^UC[\w-]{22}$/.test(policy.sourceChannelId??'')||!/^UC[\w-]{22}$/.test(policy.ownChannelId??'')
    ||!Number.isFinite(policy.scoreThreshold)||policy.scoreThreshold<0||policy.scoreThreshold>100
    ||typeof policy.publishApproved!=='boolean')throw Error('CYCLE_POLICY_INVALID');
   const id=randomUUID();
   const {rows:[row]}=await db.query(`INSERT INTO editorial_cycles(id,created_by,state,policy)
    VALUES($1,$2,'queued',$3::text::jsonb) RETURNING *`,[id,member.id,JSON.stringify(policy)]);
   return fromRow(row);
  },
  async load(id) {
   const member=await activeMember(db,identity);if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
   const {rows:[row]}=await db.query('SELECT * FROM editorial_cycles WHERE id=$1 AND created_by=$2',[id,member.id]);
   if(!row)throw Error('NOT_FOUND');return fromRow(row);
  },
  async claim(id,token,now) {
   return db.transaction(async tx=>{
    const member=await activeMember(tx,identity);if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
    const {rows:[row]}=await tx.query('SELECT * FROM editorial_cycles WHERE id=$1 AND created_by=$2 FOR UPDATE',[id,member.id]);
    if(!row)throw Error('NOT_FOUND');
    const stage=cycleStages[row.stage_index];
    if(row.state==='running'&&+new Date(row.lease_until)<now) {
     const promotion=row.release_state==='published'&&stage==='comment';
     const state=promotion?'completed':uncertainStages.has(stage)?'unknown':'queued';
     await tx.query(`UPDATE editorial_cycles SET state=$2,lease=NULL,lease_until=NULL,
      code='WORKER_INTERRUPTED',promotion_state=CASE WHEN $3 THEN 'unknown' ELSE promotion_state END,updated_at=now() WHERE id=$1`,[id,state,promotion]);
     if(state!=='queued')return null;
     row.state='queued';
    }
    if(!['queued','waiting'].includes(row.state)||row.retry_at&&+new Date(row.retry_at)>now)return null;
    const event=JSON.stringify([{at:new Date(now).toISOString(),stage,state:'running'}]);
    const {rows:[claimed]}=await tx.query(`UPDATE editorial_cycles SET state='running',lease=$2,
     lease_until=now()+interval '4 minutes',events=events||$3::text::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,[id,token,event]);
    return {job:fromRow(claimed),token};
   });
  },
  async finish(id,token,patch) {
   const {rows}=await db.query(`UPDATE editorial_cycles SET state=$3,stage_index=COALESCE($4,stage_index),
    artifacts=COALESCE($5::text::jsonb,artifacts),policy=COALESCE($6::text::jsonb,policy),
    release_state=COALESCE($7,release_state),youtube_id=COALESCE($8,youtube_id),
    promotion_state=COALESCE($9,promotion_state),code=$10,retry_at=$11,
    events=events||jsonb_build_array(jsonb_build_object('at',now(),'stage',($12::text[])[stage_index+1],'state',$3::text,'code',$10::text)),
    lease=NULL,lease_until=NULL,updated_at=now()
    WHERE id=$1 AND lease=$2 AND state='running' AND lease_until>now() RETURNING id`,
   [id,token,patch.state,patch.stageIndex??null,patch.artifacts?JSON.stringify(patch.artifacts):null,
    patch.policy?JSON.stringify(patch.policy):null,patch.releaseState??null,patch.youtubeId??null,
    patch.promotionState??null,patch.code??null,patch.retryAt?new Date(patch.retryAt):null,cycleStages]);
   if(!rows.length)throw Error('CYCLE_LEASE_LOST');
  },
 };
}
