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
import { failTikTokPublication, getShortRender, initShortRender, prepareTikTokPublication, readTikTokPackageMedia, registerTikTokPublication } from '../../../../../db/shorts.mjs';
import { startShortRender } from '../../../../../media/shorts-queue.mjs';
import { renderShort } from '../../../../../workflows/shorts-render';
import { start } from 'workflow/api';
import { reserveShortsProposal, settleShortsProposal } from '../../../../../db/shorts.mjs';
import { suggestShorts } from '../../../../../analysis/shorts-proposal.mjs';
import {queueEpisodeGrokReview,listEpisodeGrokReviews,acceptEpisodeGrokReview} from '../../../../../db/episode-grok.mjs';
import {grokBatchConfigured} from '../../../../../analysis/grok-batch.mjs';
import {runDirectGrokReviews} from '../../../../../analysis/episode-grok-review.mjs';

type Context={params:Promise<{episodeId:string;operation:string[]}>};
const isDownload=(operation:string[])=>operation.length===3&&operation[0]==='montages'&&operation[2]==='download';

const isAudit=(operation:string[])=>operation.length===3&&operation[0]==='montages'&&operation[2]==='audits';
const isShortDownload=(operation:string[])=>operation.length===3&&operation[0]==='shorts'&&operation[2]==='download';

async function dispatchShort(db:Awaited<ReturnType<typeof database>>,id:string){
  await startShortRender(db,id,async(shortId:string,token:string)=>{await start(renderShort,[shortId,token]);});
}

export async function GET(_request:Request,{params}:Context){
  try{
    const {episodeId,operation}=await params;
    if(operation.length===1&&operation[0]==='grok-review'){
      const identity=await publicationIdentity();
      return publicationReply(await listEpisodeGrokReviews(await database(),identity,episodeId));
    }
    if(isAudit(operation)){
      const identity=await publicationIdentity();
      return publicationReply(await videoAuditStatus(await database(),identity,episodeId,operation[1]));
    }
    if(isDownload(operation)){
      const identity=await publicationIdentity();
      const row=await readMontage(await database(),identity,episodeId,operation[1]);
      return new Response(null,{status:302,headers:{...privateHeaders,Location:await montageUrl(row,'get'),'Referrer-Policy':'no-referrer'}});
    }
    if(operation.length===2&&operation[0]==='shorts'){
      const identity=await publicationIdentity();
      const db=await database();
      const row=await getShortRender(db,identity,episodeId,operation[1]);
      if(['queued','rendering','technical_check'].includes(row.state)) after(async()=>{
        try{await dispatchShort(db,row.id);}catch{console.error('SHORTS_RENDER_DISPATCH_FAILED');}
      });
      return publicationReply({id:row.id,state:row.state,manifest:row.manifest,sha256:row.sha256,
        downloadUrl:row.state==='ready'?`/api/episodes/${episodeId}/shorts/${row.id}/download`:null,errorCode:row.error_code});
    }
    if (operation.length === 3 && operation[0] === 'shorts' && operation[2] === 'tiktok-download') {
      const identity = await publicationIdentity();
      const media = await readTikTokPackageMedia(await database(), identity, episodeId, operation[1]);
      const file = await fetch(await montageUrl(media, 'get'), {cache: 'no-store', signal: _request.signal});
      if (!file.ok || !file.body) throw Error('NOT_FOUND');
      return new Response(file.body, {headers: {
        ...privateHeaders,
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="tiktok-${media.id}.mp4"`,
      }});
    }
    if(isShortDownload(operation)){
      const identity=await publicationIdentity();
      const row=await getShortRender(await database(),identity,episodeId,operation[1]);
      if(row.state!=='ready'||!row.pathname) throw Error('NOT_FOUND');
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
    if(operation.length===3&&operation[0]==='shorts'&&operation[2]==='tiktok-publication'){
      const identity=await publicationIdentity(request),input=await publicationInput(request),db=await database();
      if(input.action==='prepare')return publicationReply(await prepareTikTokPublication(db,identity,episodeId,operation[1],input),201);
      if(input.action==='register')return publicationReply(await registerTikTokPublication(db,identity,episodeId,operation[1],input));
      if(input.action==='fail')return publicationReply(await failTikTokPublication(db,identity,episodeId,operation[1],input));
      throw Error('INVALID_INPUT');
    }
    if(operation.length===1&&operation[0]==='grok-review'){
      const identity=await publicationIdentity(request);
      const input=await publicationInput(request),db=await database();
      if(input.action==='accept')return publicationReply(await acceptEpisodeGrokReview(db,identity,episodeId,input.reviewId,input.version));
      if(input.action==='run'){
        if(!grokBatchConfigured())throw Error('GROK_NOT_CONFIGURED');
        const review=await queueEpisodeGrokReview(db,identity,episodeId);
        // Direct mode answers within one call; run it right after the response instead of waiting for cron.
        if(review.mode==='direct')after(async()=>{
          try{await runDirectGrokReviews(await database(),{id:review.id,limit:1});}
          catch{console.error('GROK_DIRECT_DISPATCH_FAILED');}
        });
        return publicationReply(review,202);
      }
      throw Error('INVALID_INPUT');
    }
    if(operation.length===1&&operation[0]==='shorts'){
      const identity=await publicationIdentity(request);
      const db=await database();
      const input=await publicationInput(request);
      if(input.action==='suggest'){
        const config=analysisConfig();
        const reservation=await reserveShortsProposal(db,identity,episodeId,input,config);
        if(reservation.cached) return publicationReply({id:reservation.id,manifest:reservation.plan});
        try{
          const result=await suggestShorts(reservation.context,config);
          await settleShortsProposal(db,reservation.id,{state:'succeeded',spent:result.spentMicros,plan:result.manifest});
          return publicationReply({id:reservation.id,manifest:result.manifest,reasons:result.reasons,
            spentMicros:result.spentMicros},200);
        }catch(error){
          if((error as Error & {usage?:{input:number;output:number}|null}).usage){
            const usage=(error as Error & {usage:{input:number;output:number}}).usage;
            await settleShortsProposal(db,reservation.id,{state:'failed',
              spent:usage.input*config.inputRate+usage.output*config.outputRate});
          }else await settleShortsProposal(db,reservation.id,{state:'unknown'});
          throw error;
        }
      }
      if(!montageEnabled()) throw Error('MONTAGE_DISABLED');
      const row=await initShortRender(db,identity,episodeId,input);
      after(async()=>{try{await dispatchShort(db,row.id);}catch{console.error('SHORTS_RENDER_DISPATCH_FAILED');}});
      return publicationReply({id:row.id,state:row.state},row.state==='queued'?202:200);
    }
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
