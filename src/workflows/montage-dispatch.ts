import {start} from 'workflow/api';
import {database} from '../db/runtime.mjs';
import {dispatchMontage} from '../media/montage-queue.mjs';
import {montageAudit} from './montage-audit';

export async function dispatchMontages(){
  return dispatchMontage(await database(),async(id:string,token:string)=>{ await start(montageAudit,[id,token]); });
}
