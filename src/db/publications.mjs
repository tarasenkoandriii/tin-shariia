import { activeMember } from '../access/membership.mjs';
import { parseYouTubeUrl } from '../editorial/youtube-url.mjs';
import { string, uuid } from '../editorial/workflow-input.mjs';

const correctionKinds=['quote','context','fact','translation','metadata','other'];
const json=value=>JSON.stringify(value);

async function memberWith(db,identity,roles=[]){
  if(!identity) throw Error('AUTH_REQUIRED');
  const member=await activeMember(db,identity);
  if(!member||(roles.length&&!roles.some(role=>member.roles.includes(role)))) throw Error('FORBIDDEN');
  return member;
}

function timestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw Error('INVALID_INPUT');
  const date=new Date(value);
  if(!Number.isFinite(+date)||date.toISOString()!==value||+date>Date.now()+60000||value<'2005-01-01') throw Error('INVALID_INPUT');
  return value;
}

async function event(tx,publicationId,actor,action,details,correctionId=null){
  await tx.query(`INSERT INTO publication_events (publication_id,correction_id,actor_id,action,details)
    VALUES ($1,$2,$3,$4,$5::text::jsonb)`,[publicationId,correctionId,actor,action,json(details)]);
}

async function packageFor(tx,episode,version){
  if(!episode) throw Error('NOT_FOUND');
  if(!Number.isSafeInteger(version)||version<1) throw Error('INVALID_INPUT');
  if(episode.status!=='approved'||version!==episode.version) throw Error('APPROVAL_REQUIRED');
  const {rows:[data]}=await tx.query(`SELECT ev.content AS episode,ev.claim_version,cv.content AS claim,cv.transcript_id,
    c.version AS current_claim_version,c.status AS claim_status,c.id AS claim_id,v.youtube_id,
    COALESCE((SELECT jsonb_agg(e.snapshot ORDER BY e.position) FROM claim_evidence e
      WHERE e.claim_id=c.id AND e.claim_version=ev.claim_version),'[]'::jsonb) AS sources
    FROM episode_versions ev JOIN claims c ON c.id=ev.claim_id
    JOIN claim_versions cv ON cv.claim_id=c.id AND cv.version=ev.claim_version
    JOIN videos v ON v.id=c.video_id WHERE ev.episode_id=$1 AND ev.version=$2 FOR SHARE OF c`,
  [episode.id,version]);
  if(!data||data.claim_status!=='approved'||data.claim_version!==data.current_claim_version) throw Error('CLAIM_STALE');
  return {
    schema:1,episodeId:episode.id,episodeVersion:version,claimId:data.claim_id,claimVersion:data.claim_version,
    transcriptId:data.transcript_id,sourceVideo:'https://www.youtube.com/watch?v='+data.youtube_id,
    format:'16:9',episode:data.episode,claim:data.claim,sources:data.sources,
  };
}

export function publicationPackage(db,identity,episodeId,version){
  return db.transaction(async tx=>{
    await memberWith(tx,identity,['publisher']);
    const {rows:[episode]}=await tx.query('SELECT * FROM episodes WHERE id=$1 FOR SHARE',[uuid(episodeId)]);
    if(!episode) throw Error('NOT_FOUND');
    const {rows:[published]}=await tx.query('SELECT episode_version,snapshot FROM publications WHERE episode_id=$1',[episode.id]);
    if(published?.episode_version===version) return published.snapshot;
    return packageFor(tx,episode,version);
  });
}

export function registerPublication(db,identity,episodeId,input){
  return db.transaction(async tx=>{
    const member=await memberWith(tx,identity,['publisher']);
    const youtube=parseYouTubeUrl(input.url);
    if(!youtube||!Number.isSafeInteger(input.version)||input.version<1||input.confirmed!==true) throw Error('INVALID_INPUT');
    const when=timestamp(input.publishedAt);
    const {rows:[episode]}=await tx.query('SELECT * FROM episodes WHERE id=$1 FOR UPDATE',[uuid(episodeId)]);
    if(!episode) throw Error('NOT_FOUND');
    const {rows:[existing]}=await tx.query(
      `SELECT id,episode_id,episode_version,youtube_id,published_at FROM publications
       WHERE episode_id=$1 OR youtube_id=$2 ORDER BY (episode_id=$1) DESC LIMIT 1`,[episodeId,youtube.youtubeId],
    );
    if(existing){
      if(existing.episode_id===episodeId&&existing.youtube_id===youtube.youtubeId&&existing.episode_version===input.version
        &&new Date(existing.published_at).toISOString()===when) return {...existing,deduplicated:true};
      throw Error('PUBLICATION_CONFLICT');
    }
    const snapshot=await packageFor(tx,episode,input.version);
    const {rows:[created]}=await tx.query(
      `INSERT INTO publications (episode_id,episode_version,youtube_id,published_at,recorded_by,snapshot)
       VALUES ($1,$2,$3,$4,$5,$6::text::jsonb) ON CONFLICT DO NOTHING
       RETURNING id,episode_id,episode_version,youtube_id,published_at`,
      [episode.id,input.version,youtube.youtubeId,when,member.id,json(snapshot)],
    );
    if(!created) throw Error('PUBLICATION_CONFLICT');
    await event(tx,created.id,member.id,'register',{version:input.version,youtubeId:youtube.youtubeId});
    return {...created,deduplicated:false};
  });
}

export function recordMetrics(db,identity,publicationId,input){
  return db.transaction(async tx=>{
    const member=await memberWith(tx,identity,['publisher','editor']);
    const {day,views,averageViewPercent}=input;
    const measured=timestamp(input.measuredAt);
    const source=string(input.source,500,true);
    if(![7,28].includes(day)||!Number.isSafeInteger(views)||views<0||!Number.isFinite(averageViewPercent)
      ||averageViewPercent<0||averageViewPercent>99999.999) throw Error('INVALID_INPUT');
    const {rows:[publication]}=await tx.query('SELECT id,published_at FROM publications WHERE id=$1 FOR UPDATE',[uuid(publicationId)]);
    if(!publication) throw Error('NOT_FOUND');
    if(Date.parse(measured)<new Date(publication.published_at).getTime()+day*86400000) throw Error('METRIC_TOO_EARLY');
    const percent=Number(averageViewPercent.toFixed(3));
    const {rows:[existing]}=await tx.query('SELECT * FROM metric_snapshots WHERE publication_id=$1 AND day=$2',[publicationId,day]);
    if(existing&&Date.parse(measured)<=new Date(existing.measured_at).getTime()){
      if(Date.parse(measured)===new Date(existing.measured_at).getTime()&&Number(existing.views)===views
        &&Number(existing.average_view_percent)===percent&&existing.source===source) return {day,deduplicated:true};
      throw Error('METRIC_CONFLICT');
    }
    await tx.query(`INSERT INTO metric_snapshots (publication_id,day,measured_at,views,average_view_percent,source,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (publication_id,day) DO UPDATE SET
      measured_at=EXCLUDED.measured_at,views=EXCLUDED.views,average_view_percent=EXCLUDED.average_view_percent,
      source=EXCLUDED.source,recorded_by=EXCLUDED.recorded_by`,[publicationId,day,measured,views,percent,source,member.id]);
    await event(tx,publicationId,member.id,'metrics',{day,views,percent,source,measured});
    return {day,deduplicated:false};
  });
}

export function changeCorrection(db,identity,publicationId,input){
  return db.transaction(async tx=>{
    const {action}=input;
    const roles=action==='propose'?['author','editor']:action==='post'?['publisher']:['editor'];
    const member=await memberWith(tx,identity,roles);
    publicationId=uuid(publicationId);
    const {rows:[publication]}=await tx.query('SELECT id FROM publications WHERE id=$1 FOR SHARE',[publicationId]);
    if(!publication) throw Error('NOT_FOUND');
    if(action==='propose'){
      if(!correctionKinds.includes(input.kind)) throw Error('INVALID_INPUT');
      const original=string(input.original,12000,true), replacement=string(input.replacement,12000,true);
      const reason=string(input.reason,4000,true);
      if(original===replacement) throw Error('INVALID_INPUT');
      const {rows:[correction]}=await tx.query(
        `INSERT INTO corrections (publication_id,created_by,kind,original,replacement,reason)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,status,revision`,
        [publicationId,member.id,input.kind,original,replacement,reason],
      );
      await event(tx,publicationId,member.id,action,{kind:input.kind},correction.id);
      return correction;
    }
    const {rows:[correction]}=await tx.query('SELECT * FROM corrections WHERE id=$1 AND publication_id=$2 FOR UPDATE',
      [uuid(input.id),publicationId]);
    if(!correction) throw Error('NOT_FOUND');
    if(input.expectedRevision!==correction.revision) throw Error('REVISION_CONFLICT');
    const review=['approve','return'].includes(action);
    if((review&&correction.status!=='review')||(action==='post'&&correction.status!=='approved')||(!review&&action!=='post')){
      throw Error('INVALID_TRANSITION');
    }
    if(action==='approve'&&correction.created_by===member.id) throw Error('SELF_APPROVAL');
    const comment=review?string(input.comment,4000,action==='return'):correction.review_comment;
    const location=action==='post'?string(input.location,2000,true):null;
    const status=action==='approve'?'approved':action==='return'?'returned':'posted';
    const {rows:[updated]}=await tx.query(
      `UPDATE corrections SET status=$2,revision=revision+1,review_comment=$3,posting_location=$4 WHERE id=$1
       RETURNING id,status,revision`,[correction.id,status,comment,location],
    );
    await event(tx,publicationId,member.id,action,{comment,location},correction.id);
    return updated;
  });
}

export async function loadPublications(db,identity,videoId){
  await memberWith(db,identity);
  const {rows}=await db.query(`SELECT p.id,p.episode_id,p.episode_version,p.youtube_id,p.published_at,
    COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.day) FROM metric_snapshots m WHERE m.publication_id=p.id),'[]'::jsonb) AS metrics,
    COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'created_by' ORDER BY c.created_at DESC) FROM corrections c WHERE c.publication_id=p.id),'[]'::jsonb) AS corrections
    FROM publications p JOIN episodes e ON e.id=p.episode_id JOIN claims c ON c.id=e.claim_id WHERE c.video_id=$1`,[uuid(videoId)]);
  return rows;
}
