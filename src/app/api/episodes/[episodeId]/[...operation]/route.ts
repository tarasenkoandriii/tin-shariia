import { privateHeaders, publicationError, publicationIdentity, publicationInput, publicationReply } from '../../../../../access/publication-http';
import { database } from '../../../../../db/runtime.mjs';
import { publicationPackage, registerPublication } from '../../../../../db/publications.mjs';
import { packageZip } from '../../../../../editorial/publication-zip.mjs';

type Context={params:Promise<{episodeId:string;operation:string[]}>};

export async function GET(_request:Request,{params}:Context){
  try{
    const {episodeId,operation}=await params;
    if(operation.length!==3||operation[0]!=='versions'||operation[2]!=='export'||!/^\d+$/.test(operation[1])) {
      throw Error('NOT_FOUND');
    }
    const identity=await publicationIdentity();
    const snapshot=await publicationPackage(await database(),identity,episodeId,Number(operation[1]));
    const bytes=packageZip(snapshot);
    return new Response(Uint8Array.from(bytes),{headers:{
      ...privateHeaders,'Content-Type':'application/zip',
      'Content-Disposition':'attachment; filename="tin-shariia-'+episodeId+'-v'+snapshot.episodeVersion+'.zip"',
    }});
  }catch(error){return publicationError(error);}
}

export async function POST(request:Request,{params}:Context){
  try{
    const {episodeId,operation}=await params;
    if(operation.length!==1||operation[0]!=='publications') throw Error('NOT_FOUND');
    const identity=await publicationIdentity(request);
    const data=await registerPublication(await database(),identity,episodeId,await publicationInput(request));
    return publicationReply(data,data.deduplicated?200:201);
  }catch(error){return publicationError(error);}
}
