import {database} from '../../../../db/runtime.mjs';
import {publicationError,publicationIdentity,publicationInput,publicationReply} from '../../../../access/publication-http';
import {aiEditMontagePlan,createMontagePlan,listMontagePlans,updateMontagePlan} from '../../../../db/montage-plans.mjs';

export const dynamic='force-dynamic';
export async function GET(){
  try{const identity=await publicationIdentity();return publicationReply(await listMontagePlans(await database(),identity));}
  catch(error){return publicationError(error);}
}
export async function POST(request:Request){
  try{
    const identity=await publicationIdentity(request),input=await publicationInput(request),db=await database();
    if(input.action==='create')return publicationReply(await createMontagePlan(db,identity,input),201);
    if(input.action==='save')return publicationReply(await updateMontagePlan(db,identity,input,input.changeSource==='gemini'?'gemini':'manual'));
    if(input.action==='ai-edit')return publicationReply(await aiEditMontagePlan(db,identity,input),200);
    throw Error('INVALID_INPUT');
  }catch(error){return publicationError(error);}
}
