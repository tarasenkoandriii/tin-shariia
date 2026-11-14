import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {registerVideo} from '../src/db/editorial-import.mjs';
import {changeEditorial} from '../src/db/editorial-workflow.mjs';
import {claimYouTubeUpload,patchYouTubeUpload,releaseYouTubeUploadLease} from '../src/db/youtube-uploads.mjs';
import {encryptYouTubeSecret} from '../src/youtube/oauth.mjs';
import {youtubeUploadStep} from '../src/youtube/upload.mjs';

const SESSION='https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=lease-test';
const SOURCE='https://blob.example.test/short.mp4';
const ENV={GOOGLE_YOUTUBE_CLIENT_ID:'client',GOOGLE_YOUTUBE_CLIENT_SECRET:'secret',APP_ORIGIN:'https://example.test',
  YOUTUBE_TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('base64url')};

async function withUpload(work){
  const db=new PGlite(),previousEnv={},previousFetch=globalThis.fetch;
  for(const [key,value] of Object.entries(ENV)){previousEnv[key]=process.env[key];process.env[key]=value;}
  try{
    const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
    for(const {tag} of journal.entries)await db.exec(await readFile(new URL('../drizzle/'+tag+'.sql',import.meta.url),'utf8'));
    for(const [name,roles] of [['author',['author','publisher']],['reviewer',['editor','factchecker']]]){
      const {rows:[member]}=await db.query('INSERT INTO members(clerk_user_id,email) VALUES($1,$2) RETURNING id',[name,name+'@example.test']);
      await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])',[member.id,roles]);
    }
    const {rows:[member]}=await db.query("SELECT id FROM members WHERE clerk_user_id='author'");
    const video=await registerVideo(db,'https://youtu.be/SVIDu_m8UT4');
    const change=(identity,kind,action,item,extra={})=>changeEditorial(db,identity,kind,{
      ...extra,action,id:item?.id,version:item?.version,expectedRevision:item?.revision});
    let claim=await change('author','claim','create',null,{parentId:video.id,quote:'Quote',question:'Question?',
      verdict:'confirmed',explanation:'Test',evidence:[{title:'Report',url:'https://example.test/source',accessedOn:'2026-11-14',locator:'1',coverage:'Fact'}]});
    claim=await change('author','claim','submit',claim);
    claim=await change('reviewer','claim','approve',claim);
    let episode=await change('author','episode','create',null,{parentId:claim.id,claimVersion:claim.version,
      title:'Lease Short',script:'Approved script',pinnedComment:'Context'});
    episode=await change('author','episode','submit',episode);
    episode=await change('reviewer','episode','approve',episode);
    const {rows:[media]}=await db.query(`INSERT INTO episode_media_revisions(episode_id,episode_version,uploaded_by,
      ordinal,pathname,expected_bytes,upload_until,expires_at,snapshot,state,sha256)
      VALUES($1,$2,$3,1,'lease.mp4',100,now(),now()+interval '1 day','{}','passed',$4) RETURNING id`,
    [episode.id,episode.version,member.id,'a'.repeat(64)]);
    const {rows:[connection]}=await db.query(`INSERT INTO youtube_connections(owner_id,channel_id,channel_title,refresh_token_encrypted,scopes)
      VALUES($1,'ours','Our channel',$2,$3) RETURNING id`,[member.id,encryptYouTubeSecret('refresh-token'),['youtube.upload']]);
    const {rows:[upload]}=await db.query(`INSERT INTO youtube_short_uploads(episode_id,media_revision_id,connection_id,created_by,
      idempotency_key,title,description,privacy_status,total_bytes,sha256,contains_synthetic_media,state,upload_uri_encrypted)
      VALUES($1,$2,$3,$4,$5,'Lease Short','','private',100,$6,true,'uploading',$7) RETURNING id`,
    [episode.id,media.id,connection.id,member.id,randomUUID(),'a'.repeat(64),encryptYouTubeSecret(SESSION)]);
    const read=async()=>(await db.query('SELECT state,upload_offset,youtube_id,error_code,run_lease,run_token FROM youtube_short_uploads WHERE id=$1',[upload.id])).rows[0];
    await work({db,id:upload.id,read});
  }finally{
    globalThis.fetch=previousFetch;
    for(const [key,value] of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await db.close();
  }
}

test('YouTube upload lease belongs to one run token: busy second claim, stale patch and foreign release write nothing',async()=>{
  await withUpload(async({db,id,read})=>{
    const claims=await Promise.all([claimYouTubeUpload(db,id),claimYouTubeUpload(db,id)]);
    const owner=claims.find(claim=>claim.token),other=claims.find(claim=>!claim.token);
    assert.equal(owner.done,false);
    assert.match(owner.token,/^[0-9a-f-]{36}$/);
    assert.deepEqual(other,{busy:true});
    let row=await read();
    assert.equal(row.run_token,owner.token);
    assert.ok(new Date(row.run_lease).getTime()-Date.now()>100000,'lease lasts about 120 seconds');

    const stale=randomUUID();
    assert.equal(await patchYouTubeUpload(db,id,{state:'failed',errorCode:'YOUTUBE_UPLOAD_REJECTED'},stale),null);
    row=await read();
    assert.equal(row.state,'uploading');
    assert.equal(row.error_code,null);

    const saved=await patchYouTubeUpload(db,id,{state:'uploading',offset:40,errorCode:null},owner.token);
    assert.equal(Number(saved.upload_offset),40);
    row=await read();
    assert.equal(row.run_token,owner.token,'intermediate patches keep the lease');
    assert.notEqual(row.run_lease,null);

    assert.equal(await releaseYouTubeUploadLease(db,id,stale),false);
    row=await read();
    assert.equal(row.run_token,owner.token);
    assert.notEqual(row.run_lease,null);
    assert.equal(await releaseYouTubeUploadLease(db,id,owner.token),true);
    row=await read();
    assert.equal(row.run_token,null);
    assert.equal(row.run_lease,null);
    const {rows:events}=await db.query('SELECT action FROM youtube_upload_events WHERE upload_id=$1 ORDER BY id',[id]);
    assert.deepEqual(events.map(event=>event.action),['chunk_accepted']);
  });
});

test('published YouTube upload is final: later patches and claims never overwrite it',async()=>{
  await withUpload(async({db,id,read})=>{
    const {token}=await claimYouTubeUpload(db,id);
    await patchYouTubeUpload(db,id,{state:'published',youtubeId:'QdaWfN4b6Bg',offset:100,errorCode:null},token);
    assert.equal(await patchYouTubeUpload(db,id,{state:'failed',errorCode:'YOUTUBE_UPLOAD_REJECTED'},token),null);
    assert.equal(await patchYouTubeUpload(db,id,{state:'unknown',errorCode:'YOUTUBE_UPLOAD_OUTCOME_UNKNOWN'}),null);
    const row=await read();
    assert.equal(row.state,'published');
    assert.equal(row.youtube_id,'QdaWfN4b6Bg');
    assert.equal(row.error_code,null);
    await releaseYouTubeUploadLease(db,id,token);
    assert.deepEqual(await claimYouTubeUpload(db,id),{done:true,state:'published'});
    await db.query("UPDATE youtube_short_uploads SET state='failed' WHERE id=$1",[id]);
    assert.equal(await patchYouTubeUpload(db,id,{state:'uploading',errorCode:null}),null,'failed changes only via explicit recovery');
    assert.equal((await patchYouTubeUpload(db,id,{state:'failed',errorCode:'YOUTUBE_DISCONNECTED',allowFinal:true})).state,'failed');
  });
});

const googleToken=()=>Response.json({access_token:'access',expires_in:3600});

test('chunk PUT timeout leaves the upload unknown and releases the lease',async()=>{
  await withUpload(async({db,id,read})=>{
    const calls=[];
    globalThis.fetch=async(input,init={})=>{
      const url=String(input);calls.push(`${init.method??'GET'} ${url}`);
      assert.ok(init.signal instanceof AbortSignal,`fetch without timeout: ${url}`);
      if(url==='https://oauth2.googleapis.com/token')return googleToken();
      if(url===SOURCE)return new Response(new Uint8Array(100),{status:206});
      if(url===SESSION&&init.headers['Content-Range']==='bytes */100')return new Response(null,{status:308});
      if(url===SESSION)return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason)));
      throw Error(`unexpected fetch ${url}`);
    };
    const result=await youtubeUploadStep(db,id,{sourceUrl:()=>SOURCE,timeouts:{chunk:50}});
    assert.deepEqual(result,{done:false,state:'unknown'});
    const row=await read();
    assert.equal(row.state,'unknown');
    assert.equal(row.error_code,'YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
    assert.equal(row.run_token,null);
    assert.equal(row.run_lease,null);
    assert.equal(calls.filter(call=>call.startsWith('PUT')).length,2);
  });
});

test('upload step stops without further network calls after losing its lease',async()=>{
  await withUpload(async({db,id,read})=>{
    const calls=[],thief=randomUUID();
    globalThis.fetch=async(input,init={})=>{
      const url=String(input);calls.push(url);
      if(url==='https://oauth2.googleapis.com/token')return googleToken();
      if(url===SESSION&&init.headers['Content-Range']==='bytes */100'){
        await db.query("UPDATE youtube_short_uploads SET run_token=$2,run_lease=now()+interval '120 seconds' WHERE id=$1",[id,thief]);
        return new Response(null,{status:308,headers:{range:'bytes=0-39'}});
      }
      throw Error(`unexpected fetch ${url}`);
    };
    const result=await youtubeUploadStep(db,id,{sourceUrl:()=>SOURCE});
    assert.deepEqual(result,{done:false,busy:true,lostLease:true});
    assert.deepEqual(calls,['https://oauth2.googleapis.com/token',SESSION]);
    const row=await read();
    assert.equal(row.state,'uploading');
    assert.equal(Number(row.upload_offset),0);
    assert.equal(row.run_token,thief,'foreign lease survives the stale release');
  });
});

test('token refresh failure after the session started is unknown, not failed',async()=>{
  await withUpload(async({db,id,read})=>{
    globalThis.fetch=async input=>{
      if(String(input)==='https://oauth2.googleapis.com/token')return Response.json({error:'temporarily_unavailable'},{status:503});
      throw Error(`unexpected fetch ${input}`);
    };
    assert.deepEqual(await youtubeUploadStep(db,id,{sourceUrl:()=>SOURCE}),{done:false,state:'unknown'});
    const row=await read();
    assert.equal(row.state,'unknown');
    assert.equal(row.error_code,'YOUTUBE_TOKEN_REFRESH_FAILED');
  });
});
