import {createHash,randomUUID} from 'node:crypto';
import {put} from '@vercel/blob';
import {montageUrl} from '../media/montage-storage.mjs';
import {initShortRender,createShortAuditMedia,updateShortRender} from '../db/shorts.mjs';

// The compositor already produced a complete 1080x1920 Short. Register its exact bytes;
// do not run the cutting/stamping pipeline a second time over its authored final frame.
export async function registerGeneratedShort(db,identity,episodeId,mediaId,metadata) {
 const {rows:[source]}=await db.query('SELECT * FROM episode_media_revisions WHERE id=$1 AND episode_id=$2',[mediaId,episodeId]);
 if(!source||source.state!=='passed'||source.report?.width!==1080||source.report?.height!==1920
  ||source.report.durationMs<30000||source.report.durationMs>60000)throw Error('SHORTS_TECH_CHECK_REJECTED');
 const key='cycle-complete-'+mediaId;
 const {rows:[previous]}=await db.query('SELECT id,audit_media_revision_id,state FROM shorts_renders WHERE idempotency_key=$1',[key]);
 if(previous?.state==='ready')return {shortId:previous.id,mediaId:previous.audit_media_revision_id,hash:source.sha256};
 const response=await fetch(await montageUrl(source,'get'),{signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('MONTAGE_OBJECT_MISSING');
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length!==source.expected_bytes||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('MONTAGE_OBJECT_MISMATCH');
 const path='cycle-shorts/'+mediaId+'.mp4';
 // A deterministic path makes a retry copy harmless; identical bytes are hash-checked above.
 await put(path,bytes,{access:'private',contentType:'video/mp4',addRandomSuffix:false,allowOverwrite:true});
 return db.transaction(async tx=>{
  const scope={...tx,transaction:fn=>fn(tx)};
  const short=await initShortRender(scope,identity,episodeId,{mediaId,manifest:{clips:[{startMs:0,endMs:source.report.durationMs}],hook:metadata.title,title:metadata.title,description:metadata.description}});
  const token=randomUUID();
  await tx.query(`UPDATE shorts_renders SET state='technical_check',idempotency_key=$2,pathname=$3,expected_bytes=$4,sha256=$5,
   run_token=$6,run_lease=now()+interval '3 minutes' WHERE id=$1 AND state='queued'`,[short.id,key,path,bytes.length,source.sha256,token]);
  const auditMedia=await createShortAuditMedia(scope,short.id,token,source.report);
  if(!auditMedia)throw Error('MEDIA_NOT_READY');
  if(!await updateShortRender(tx,short.id,token,{state:'ready',auditMediaRevisionId:auditMedia,technicalReport:source.report,lease:null}))throw Error('MEDIA_NOT_READY');
  return {shortId:short.id,mediaId:auditMedia,hash:source.sha256};
 });
}
