import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {database} from '../../../../db/runtime.mjs';
import {initMontage,confirmMontage} from '../../../../db/montage.mjs';
import {montageUrl,montageHead} from '../../../../media/montage-storage.mjs';
export const maxDuration=300;
const digest=(s:string)=>createHash('sha256').update(s).digest();
const headers={'Cache-Control':'private, no-store'};
export async function POST(request:Request){
 const token=process.env.YOUTUBE_READER_TOKEN;
 if(!token||!timingSafeEqual(digest('Bearer '+token),digest(request.headers.get('authorization')??'')))return new Response(null,{status:403});
 try{
  const text=await request.text();if(text.length>300000)return new Response(null,{status:413});
  const input=JSON.parse(text),db=await database();
  if(input.action==='claim'){
   await db.query("UPDATE editorial_cycle_media_tasks SET state='unknown',error_code='CYCLE_WORKER_INTERRUPTED',lease=NULL,lease_until=NULL WHERE (state='preparing' AND updated_at<now()-interval '4 minutes') OR (state='running' AND lease_until<now())");
   const lease=randomUUID();
   const {rows:[task]}=await db.query(`WITH candidate AS (
    SELECT t.id FROM editorial_cycle_media_tasks t JOIN editorial_cycles c ON c.id=t.cycle_id
    JOIN members m ON m.id=c.created_by WHERE t.state='queued' AND m.revoked_at IS NULL
    AND EXISTS(SELECT 1 FROM member_roles WHERE member_id=m.id AND role='admin')
    AND c.state IN ('queued','waiting','running') ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1)
    UPDATE editorial_cycle_media_tasks t SET state='running',lease=$1,lease_until=now()+interval '15 minutes',updated_at=now()
    FROM candidate x WHERE t.id=x.id RETURNING t.id,t.cycle_id,t.kind,t.input,t.lease`,[lease]);
   if(!task)return Response.json(null,{headers});
   if(task.kind==='youtube_audio'){
    const {rows:[media]}=await db.query('SELECT * FROM episode_media_revisions WHERE id=$1',[task.input.mediaId]);
    task.input.baselineUrl=await montageUrl(media,'get',15);
   }
   return Response.json(task,{headers});
  }
  if(!/^[a-f0-9-]{36}$/i.test(input.id??'')||!/^[a-f0-9-]{36}$/i.test(input.lease??''))return new Response(null,{status:422});
  const {rows:[task]}=await db.query(`SELECT t.*,m.clerk_user_id,c.artifacts,c.policy FROM editorial_cycle_media_tasks t
   JOIN editorial_cycles c ON c.id=t.cycle_id JOIN members m ON m.id=c.created_by
   WHERE t.id=$1 AND t.lease=$2 AND t.state='running' AND t.lease_until>now() AND m.revoked_at IS NULL`,[input.id,input.lease]);
  if(!task)return new Response(null,{status:409});
  if(input.action==='prepare-upload'&&task.kind==='render'){
   if(!Number.isSafeInteger(input.bytes)||input.bytes<1000||input.bytes>128*1024*1024)return new Response(null,{status:422});
   const existing=task.output?.mediaId?(await db.query('SELECT * FROM episode_media_revisions WHERE id=$1',[task.output.mediaId])).rows[0]:null;
   const media=existing??await initMontage(db,task.clerk_user_id,task.artifacts.scenario.episodeId,{version:task.artifacts.scenario.version,bytes:input.bytes});
   if(media.expected_bytes!==input.bytes)return new Response(null,{status:409});
   if(media.state!=='uploading')return Response.json({mediaId:media.id,alreadyUploaded:true},{headers});
   const uploadUrl=await montageUrl(media,'put');
   await db.query(`UPDATE editorial_cycle_media_tasks SET output=jsonb_build_object('mediaId',$3::text),updated_at=now()
    WHERE id=$1 AND lease=$2 AND state='running'`,[task.id,input.lease,media.id]);
   return Response.json({mediaId:media.id,uploadUrl},{headers});
  }
  if(input.action==='finish'){
   if(input.errorCode){
    const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(input.errorCode)?input.errorCode:'CYCLE_WORKER_FAILED';
    await db.query("UPDATE editorial_cycle_media_tasks SET state='failed',error_code=$3,lease=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease=$2",[task.id,input.lease,code]);
    return Response.json({accepted:true},{headers});
   }
   if(task.kind==='render'){
    if(!task.output?.mediaId||!/^[a-f0-9]{64}$/.test(input.mediaHash??'')||input.audioContinuous!==true)return new Response(null,{status:422});
    const {rows:[media]}=await db.query('SELECT * FROM episode_media_revisions WHERE id=$1',[task.output.mediaId]);
    await confirmMontage(db,task.clerk_user_id,task.artifacts.scenario.episodeId,media.id,await montageHead(media.pathname));
    await db.query("UPDATE editorial_cycle_media_tasks SET state='done',output=$3::text::jsonb,lease=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease=$2",[task.id,input.lease,JSON.stringify({mediaId:media.id,mediaHash:input.mediaHash,audioContinuous:true,report:input.report})]);
   }else if(task.kind==='evidence'){
    // Revalidate exact source identity, quote and hash metadata; the trusted worker fetches the actual documents.
    const evidence=input.evidence;
    if(!evidence||!Array.isArray(evidence.evidence)||evidence.evidence.length!==task.input.seed.evidence.length)return new Response(null,{status:422});
    for(let i=0;i<evidence.evidence.length;i++){
     const actual=evidence.evidence[i],expected=task.input.seed.evidence[i];
     if(actual.url!==expected.url||actual.excerpt!==expected.excerpt||!/^[a-f0-9]{64}$/.test(actual.documentHash??'')||!Number.isFinite(Date.parse(actual.checkedAt))||Math.abs(Date.now()-Date.parse(actual.checkedAt))>300000)return new Response(null,{status:422});
    }
    const result={...task.input.seed.factcheck,evidence:evidence.evidence,discrepancy:true,confirmed:true,kind:'fact',paraphrase:false};
    await db.query("UPDATE editorial_cycle_media_tasks SET state='done',output=$3::text::jsonb,lease=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease=$2",[task.id,input.lease,JSON.stringify(result)]);
   }else{
    if(input.audioVerified!==true||!Array.isArray(input.correlations)||input.correlations.length<3||!input.correlations.every((v:number)=>Number.isFinite(v)&&v>=0.9&&v<=1))return new Response(null,{status:422});
    await db.query("UPDATE editorial_cycle_media_tasks SET state='done',output=$3::text::jsonb,lease=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease=$2",[task.id,input.lease,JSON.stringify({audioVerified:true,correlations:input.correlations,checkedAt:new Date().toISOString()})]);
   }
   return Response.json({accepted:true},{headers});
  }
  return new Response(null,{status:422});
 }catch(error){console.warn('EDITORIAL_CYCLE_WORKER_FAILED',{code:error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'REQUEST_FAILED'});return Response.json({error:'CYCLE_WORKER_FAILED'},{status:502,headers});}
}
