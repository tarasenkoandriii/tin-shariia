import {sleep} from 'workflow';
import {advanceProductionCycle} from '../automation/production-cycle';
async function advance(id:string){
 'use step';
 return advanceProductionCycle(id);
}
export async function runEditorialCycle(id:string){
 'use workflow';
 for(let attempt=0;attempt<480;attempt++){
  const result=await advance(id);if(result.done)return;
  if(result.state==='waiting'||result.claimed===false)await sleep('15s');
 }
}
