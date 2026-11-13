import {database} from '../../../../db/runtime.mjs';
import {publicationError,publicationIdentity,publicationInput,publicationReply} from '../../../../access/publication-http';
import {readGrokSettings,updateGrokSettings} from '../../../../db/episode-grok.mjs';

export const dynamic='force-dynamic';
export async function GET(){
  try{const identity=await publicationIdentity();return publicationReply(await readGrokSettings(await database(),identity));}
  catch(error){return publicationError(error);}
}
export async function POST(request:Request){
  try{
    const identity=await publicationIdentity(request),input=await publicationInput(request);
    return publicationReply(await updateGrokSettings(await database(),identity,{
      autoAcceptScore:input.autoAcceptScore,grokMode:input.grokMode,
    }));
  }catch(error){return publicationError(error);}
}
