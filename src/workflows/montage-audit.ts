import {sleep} from 'workflow';
import {database} from '../db/runtime.mjs';
import {montageStep,yieldMontage} from '../media/montage-queue.mjs';

async function advance(id:string,token:string){
  'use step';
  return montageStep(await database(),id,token);
}
async function relinquish(id:string,token:string){
  'use step';
  await yieldMontage(await database(),id,token);
}
export async function montageAudit(id:string,token:string){
  'use workflow';
  for(let index=0;index<24;index++){
    const result=await advance(id,token);
    if(result.done) return;
    await sleep('5s');
  }
  await relinquish(id,token);
}
