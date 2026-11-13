import {database} from '../../../../db/runtime.mjs';
import {publicationError,publicationIdentity,publicationInput,publicationReply} from '../../../../access/publication-http';
import {readGrokAutoAcceptScore,updateGrokAutoAcceptScore} from '../../../../db/episode-grok.mjs';

export const dynamic='force-dynamic';
export async function GET(){
  try{const identity=await publicationIdentity();return publicationReply({autoAcceptScore:await readGrokAutoAcceptScore(await database(),identity)});}
  catch(error){return publicationError(error);}
}
export async function POST(request:Request){
  try{
    const identity=await publicationIdentity(request),input=await publicationInput(request);
    return publicationReply({autoAcceptScore:await updateGrokAutoAcceptScore(await database(),identity,input.autoAcceptScore)});
  }catch(error){return publicationError(error);}
}
