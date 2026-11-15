import {createHash} from 'node:crypto';
import {changeEditorial} from '../db/editorial-workflow.mjs';
const plain=value=>String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&[lr]aquo;/g,'"').replace(/&[lr]dquo;/g,'"').replace(/\s+/g,' ').trim();
const sourceHosts=new Set(['www.president.gov.ua','president.gov.ua','www.rada.gov.ua','zakon.rada.gov.ua','fisu.gov.ua','szru.gov.ua','www.radiosvoboda.org','www.pravda.com.ua','censor.net','interfax.com.ua','gov.uz']);
export async function verifyCaseEvidence(seed,{fetchImpl=fetch}={}) {
 if(!Array.isArray(seed.evidence)||seed.evidence.length<2||seed.evidence.length>6)throw Error('CYCLE_EVIDENCE_REQUIRED');
 const evidence=[];
 for(const item of seed.evidence) {
  const url=new URL(item.url);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!sourceHosts.has(url.hostname))throw Error('CYCLE_SOURCE_INVALID');
  const r=await fetchImpl(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('CYCLE_SOURCE_UNAVAILABLE');
  const chunks=[];let length=0;
  for await(const chunk of r.body){length+=chunk.length;if(length>2*1024*1024)throw Error('CYCLE_SOURCE_INVALID');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks),text=plain(bytes.toString());
  if(typeof item.excerpt!=='string'||item.excerpt.length<15||!text.includes(plain(item.excerpt)))throw Error('CYCLE_EVIDENCE_QUOTE_MISMATCH');
  evidence.push({...item,primary:/\.gov\.ua$|^gov\.uz$/.test(url.hostname),documentHash:createHash('sha256').update(bytes).digest('hex'),checkedAt:new Date().toISOString()});
 }
 return {...seed.factcheck,evidence,discrepancy:true,confirmed:true,kind:'fact',paraphrase:false};
}

// Explicit editorial case, not an unchecked model verdict. Admin authorization and revision rules
// remain in the normal claim/episode services, including their audit events.
export async function createCaseScenario(db,identity,artifacts,seed) {
 return db.transaction(async tx=>{
  const scope={...tx,transaction:fn=>fn(tx)};
  const {rows:[locked]}=await tx.query('SELECT id FROM videos WHERE id=$1 FOR UPDATE',[artifacts.discover.videoRecordId]);
  if(!locked)throw Error('NOT_FOUND');
  const key='automatic-cycle:'+seed.caseKey+':'+createHash('sha256').update(JSON.stringify(seed)).digest('hex');
  const {rows:[existing]}=await tx.query(`SELECT e.id,e.version,e.status,ev.content FROM episodes e
    JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=e.version
    WHERE ev.content->>'thumbnail'=$1 AND e.claim_id IN (SELECT id FROM claims WHERE video_id=$2)`,[key,locked.id]);
  let episode=existing;
  if(!episode) {
   const fact=artifacts.factcheck;
   let claim=await changeEditorial(scope,identity,'claim',{action:'create',parentId:locked.id,transcriptId:artifacts.captions.transcriptId,
    quote:fact.quote,context:fact.context,question:fact.question,verdict:fact.verdict,explanation:fact.explanation,startMs:fact.startMs,endMs:fact.endMs,
    evidence:fact.evidence.map(e=>({title:e.title,url:e.url,organization:e.organization,publicationDate:e.publicationDate??null,
      accessedOn:e.checkedAt.slice(0,10),locator:e.locator,coverage:e.excerpt+'\n'+e.coverage}))});
   for(const action of ['submit','approve'])claim=await changeEditorial(scope,identity,'claim',{action,id:claim.id,version:claim.version,expectedRevision:claim.revision,comment:'Перевірений редакційний кейс: '+seed.caseKey});
   episode=await changeEditorial(scope,identity,'episode',{action:'create',parentId:claim.id,claimVersion:claim.version,
    title:seed.scenario.title,script:seed.scenario.script,description:seed.scenario.description,thumbnail:key,subtitles:seed.scenario.subtitles??'',
    pinnedComment:seed.scenario.pinnedComment??'',fragments:`${fact.startMs/1000}–${fact.endMs/1000} с · оригінальне джерело`});
   for(const action of ['submit','approve'])episode=await changeEditorial(scope,identity,'episode',{action,id:episode.id,version:episode.version,expectedRevision:episode.revision,comment:'Автоматичний цикл за дорученням адміністратора'});
  }
  if(existing&&existing.content.script!==seed.scenario.script)throw Error('CYCLE_CASE_KEY_CONFLICT');
  if(episode.status!=='approved')throw Error('CYCLE_SCENARIO_NOT_APPROVED');
  return {episodeId:episode.id,version:episode.version,sourceVideoId:artifacts.discover.videoId,claimApproved:true,episodeApproved:true,
   scenarioHash:createHash('sha256').update(seed.scenario.script).digest('hex')};
 });
}
