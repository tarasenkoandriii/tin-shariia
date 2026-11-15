import {start,getRun} from 'workflow/api';
import {database} from '../db/runtime.mjs';
import {runEditorialCycle} from './editorial-cycle';
export async function dispatchEditorialCycle(id:string){
 const db=await database();
 const {rows:[row]}=await db.query(`SELECT id,state,workflow_run_id FROM editorial_cycles WHERE id=$1 AND state IN ('queued','waiting','running')`,[id]);
 if(!row)return {started:false};
 if(row.workflow_run_id){try{const status=await getRun(row.workflow_run_id).status;if(['pending','running'].includes(status))return {started:false};}catch{return {started:false,code:'WORKFLOW_STATUS_UNAVAILABLE'};}}
 const {rows:[claimed]}=await db.query(`UPDATE editorial_cycles SET dispatch_until=now()+interval '5 minutes'
  WHERE id=$1 AND (dispatch_until IS NULL OR dispatch_until<now()) RETURNING id`,[id]);
 if(!claimed)return {started:false};
 const run=await start(runEditorialCycle,[id]);
 await db.query('UPDATE editorial_cycles SET workflow_run_id=$2,dispatch_until=NULL WHERE id=$1',[id,run.runId]);
 return {started:true};
}
export async function dispatchEditorialCycles(){
 const db=await database();const {rows}=await db.query(`SELECT id FROM editorial_cycles WHERE state IN ('queued','waiting','running') ORDER BY updated_at LIMIT 3`);
 const results=[];for(const row of rows)results.push(await dispatchEditorialCycle(row.id));return results;
}
