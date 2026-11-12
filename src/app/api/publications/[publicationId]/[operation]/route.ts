import { publicationError, publicationIdentity, publicationInput, publicationReply } from '../../../../../access/publication-http';
import { database } from '../../../../../db/runtime.mjs';
import { changeCorrection, recordMetrics } from '../../../../../db/publications.mjs';

export async function POST(request:Request,{params}:{
  params:Promise<{publicationId:string;operation:string}>;
}){
  try{
    const {publicationId,operation}=await params;
    if(operation!=='metrics'&&operation!=='corrections') throw Error('NOT_FOUND');
    const identity=await publicationIdentity(request);
    const input=await publicationInput(request);
    const db=await database();
    return publicationReply(operation==='metrics'?await recordMetrics(db,identity,publicationId,input):
      await changeCorrection(db,identity,publicationId,input));
  }catch(error){return publicationError(error);}
}
