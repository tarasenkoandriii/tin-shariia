import {after} from 'next/server';
import { analysisConfig } from '../../../../../analysis/config.mjs';
import { enqueueVideoAudit } from '../../../../../analysis/queue.mjs';
import { videoAuditStatus } from '../../../../../analysis/video-status.mjs';
import { reviewVideoAudit } from '../../../../../db/video-audit.mjs';
import { dispatchSources } from '../../../../../workflows/dispatch';
import { privateHeaders, publicationError, publicationIdentity, publicationInput, publicationReply } from '../../../../../access/publication-http';
import { database } from '../../../../../db/runtime.mjs';
import { publicationPackage, registerPublication } from '../../../../../db/publications.mjs';
import { confirmMontage, initMontage, ownedMontage, readMontage } from '../../../../../db/montage.mjs';
import { packageZip } from '../../../../../editorial/publication-zip.mjs';
import { montageEnabled, montageHead, montageUrl } from '../../../../../media/montage-storage.mjs';
import { dispatchMontages } from '../../../../../workflows/montage-dispatch';

type Context={params:Promise<{episodeId:string;operation:string[]}>};
const isDownload=(operation:string[])=>operation.length===3&&operation[0]==='montages'&&operation[2]==='download';

const isAudit=(operation:string[])=>operation.length===3&&operation[0]==='montages'&&operation[2]==='audits';

export async function GET(_request:Request,{params}:Context){
  try{
    const {episodeId,operation}=await params;
    if(isAudit(operation)){
      const identity=await publicationIdentity();
      return publicationReply(await videoAuditStatus(await database(),identity,episodeId,operation[1]));
    }
    if(isDownload(operation)){
      const identity=await publicationIdentity();
      const row=await readMontage(await database(),identity,episodeId,operation[1]);
      return new Response(null,{status:302,headers:{...privateHeaders,Location:await montageUrl(row,'get'),'Referrer-Policy':'no-referrer'}});
    }
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
    if(operation.length===1&&operation[0]==='publications'){
      const identity=await publicationIdentity(request);
      const data=await registerPublication(await database(),identity,episodeId,await publicationInput(request));
      return publicationReply(data,data.deduplicated?200:201);
    }
    if(isAudit(operation)){
      const identity=await publicationIdentity(request);
      if(process.env.VIDEO_AUDIT_ENABLED!=='true') throw Error('VIDEO_AUDIT_DISABLED');
      const input=await publicationInput(request);
      if(input.action==='finding'||input.action==='approve'){
        return publicationReply(await reviewVideoAudit(await database(),identity,episodeId,operation[1],input));
      }
      if(input.confirmed!==true||(input.retry!==undefined&&typeof input.retry!=='boolean')
        ||(input.acknowledgeUnknown!==undefined&&typeof input.acknowledgeUnknown!=='boolean')) throw Error('INVALID_INPUT');
      const result=await enqueueVideoAudit(await database(),identity,episodeId,operation[1],input,analysisConfig());
      if(!result.deduplicated) after(async()=>{
        try{await dispatchSources();}catch{console.error('VIDEO_AUDIT_DISPATCH_FAILED');}
      });
      return publicationReply(result,202);
    }
    const init=operation.length===1&&operation[0]==='montages';
    const confirm=operation.length===3&&operation[0]==='montages'&&operation[2]==='confirm';
    if(!init&&!confirm) throw Error('NOT_FOUND');
    const identity=await publicationIdentity(request);
    if(!montageEnabled()) throw Error('MONTAGE_DISABLED');
    const db=await database();
    if(init){
      const row=await initMontage(db,identity,episodeId,await publicationInput(request));
      return publicationReply({id:row.id,uploadUrl:await montageUrl(row,'put')},201);
    }
    const existing=await ownedMontage(db,identity,episodeId,operation[1]);
    const row=existing.state==='uploading'?await confirmMontage(db,identity,episodeId,existing.id,await montageHead(existing.pathname)):existing;
    if(row.state==='queued'||row.state==='checking') after(async()=>{
      try{await dispatchMontages();}catch{console.error('MONTAGE_DISPATCH_FAILED');}
    });
    return publicationReply({id:row.id,state:row.state},202);
  }catch(error){return publicationError(error);}
}
