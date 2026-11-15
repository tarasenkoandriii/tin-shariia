import {after} from 'next/server';
import {publicationIdentity,publicationInput,publicationReply,publicationError} from '../../../../access/publication-http';
import {database} from '../../../../db/runtime.mjs';
import {activeMember} from '../../../../access/membership.mjs';
import {dbCycleStore} from '../../../../automation/db-cycle-store.mjs';
import {cycleSeedSchema} from '../../../../automation/cycle-input.mjs';
import {dispatchEditorialCycle} from '../../../../workflows/editorial-cycle-dispatch';
export const maxDuration=300;
export async function GET(){try{
 const identity=await publicationIdentity(),db=await database(),member=await activeMember(db,identity);
 if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
 const {rows}=await db.query(`SELECT id,state,stage_index,release_state,youtube_id,promotion_state,code,events,
  artifacts->'scenario' AS scenario,artifacts->'grok' AS grok,artifacts->'audit' AS audit,created_at,updated_at
  FROM editorial_cycles WHERE created_by=$1 ORDER BY created_at DESC LIMIT 30`,[member.id]);
 return publicationReply(rows);
}catch(e){return publicationError(e);}}
export async function POST(request:Request){try{
 const identity=await publicationIdentity(request),db=await database(),input=await publicationInput(request);
 const member=await activeMember(db,identity);if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
 if(input.action==='resume'&&typeof input.id==='string'){
  const job=await dbCycleStore(db,identity).load(input.id);
  if(!job)throw Error('NOT_FOUND');
  if(!['queued','waiting'].includes(job.state))throw Error('CYCLE_NOT_RECOVERABLE');
  if(!job)throw Error('NOT_FOUND');
 after(()=>dispatchEditorialCycle(job.id));return publicationReply({id:job.id},202);
 }
 if(input.confirmed!==true)throw Error('CYCLE_PUBLICATION_NOT_AUTHORIZED');
 const parsed=cycleSeedSchema.safeParse(input.seed);if(!parsed.success)throw Error('INVALID_INPUT');
 const {rows:[connection]}=await db.query('SELECT channel_id FROM youtube_connections WHERE owner_id=$1 AND disconnected_at IS NULL',[member.id]);
 if(!connection)throw Error('YOUTUBE_NOT_CONNECTED');
 const {rows:[settings]}=await db.query('SELECT auto_accept_score,grok_mode FROM editorial_ai_settings WHERE id=1');
 if(settings?.grok_mode!=='direct')throw Error('CYCLE_DIRECT_MODE_REQUIRED');
 const job=await dbCycleStore(db,identity).create({sourceChannelId:input.sourceChannelId,ownChannelId:connection.channel_id,
  scoreThreshold:Number(settings.auto_accept_score),publishApproved:true,promotionEnabled:false,maxCandidates:1,seed:parsed.data});
 if(!job)throw Error('NOT_FOUND');
 after(()=>dispatchEditorialCycle(job.id));return publicationReply({id:job.id},202);
}catch(e){return publicationError(e);}}
