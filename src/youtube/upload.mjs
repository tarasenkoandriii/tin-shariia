import {parseYouTubeUrl} from '../editorial/youtube-url.mjs';
import { decryptYouTubeSecret, encryptYouTubeSecret, refreshYouTubeAccessToken, youtubeOAuthConfig } from './oauth.mjs';
import { loadYouTubeUploadInternal, patchYouTubeUpload, claimYouTubeUpload, releaseYouTubeUploadLease } from '../db/youtube-uploads.mjs';
import { montageUrl } from '../media/montage-storage.mjs';

const CHUNK_BYTES=8*1024*1024;
// Worst step: token refresh 10 s + session POST 15 s + session PUT 15 s + source GET 20 s + chunk PUT 30 s = 90 s < 120 s lease.
const TIMEOUTS={request:15000,source:20000,chunk:30000};
const LEASE_LOST='YOUTUBE_UPLOAD_LEASE_LOST';
export const googleSessionUrl=value=>{
  let url;
  try{url=new URL(value);}catch{throw Error('YOUTUBE_SESSION_INVALID');}
  if(url.protocol!=='https:'||!(url.hostname==='googleapis.com'||url.hostname.endsWith('.googleapis.com')))
    throw Error('YOUTUBE_SESSION_INVALID');
  return url.toString();
};

export function youtubeOffsetFromRange(range,totalBytes){
  if(!Number.isSafeInteger(Number(totalBytes))||Number(totalBytes)<1) throw Error('YOUTUBE_SESSION_INVALID');
  if(range===null||range==='')return 0;
  const match=/^bytes=0-(\d+)$/.exec(range);
  if(!match)throw Error('YOUTUBE_SESSION_INVALID');
  const offset=Number(match[1])+1;
  if(!Number.isSafeInteger(offset)||offset>Number(totalBytes))throw Error('YOUTUBE_SESSION_INVALID');
  return offset;
}

export function youtubeProcessingOutcome(video,expectedPrivacy,expectedSynthetic=true){
  if(typeof video?.id!=='string'||typeof expectedPrivacy!=='string')return {state:'unknown',done:false};
  const status=video.status?.uploadStatus??'unknown';
  const privacy=video.status?.privacyStatus??null;
  // YouTube can omit this field even when Studio shows the disclosure.
  const disclosed=video.status?.containsSyntheticMedia;
  const containsSyntheticMedia=typeof disclosed==='boolean'?disclosed:null;
  if(['rejected','failed'].includes(status))return {state:'failed',done:true,status,privacy,errorCode:'YOUTUBE_PROCESSING_FAILED'};
  if(status==='processed'&&privacy!==expectedPrivacy)return {state:'failed',done:true,status,privacy,errorCode:'YOUTUBE_PRIVACY_MISMATCH'};
  if(status==='processed'&&containsSyntheticMedia!==null&&containsSyntheticMedia!==expectedSynthetic)return {state:'failed',done:true,status,privacy,containsSyntheticMedia,errorCode:'YOUTUBE_AI_DISCLOSURE_MISMATCH'};
  if(status==='processed')return {state:'published',done:true,status,privacy,containsSyntheticMedia,errorCode:null};
  return {state:'processing',done:false,status,privacy,containsSyntheticMedia,errorCode:null};
}

async function accessToken(row){
  const config=youtubeOAuthConfig();
  return refreshYouTubeAccessToken(decryptYouTubeSecret(row.refresh_token_encrypted),config);
}

export async function verifyManualYouTubeShort(connection,input){
  const parsed=parseYouTubeUrl(input.url);
  if(!parsed) throw Error('INVALID_INPUT');
  if(!connection) throw Error('YOUTUBE_CHANNEL_NOT_CONNECTED');
  const token=await accessToken(connection);
  const url=new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search=new URLSearchParams({part:'snippet,status',id:parsed.youtubeId});
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw Error('YOUTUBE_STATUS_UNAVAILABLE');
  const video=(await response.json()).items?.find(item=>item.id===parsed.youtubeId);
  if(video?.snippet?.channelId!==connection.channel_id) throw Error('YOUTUBE_MANUAL_CHANNEL_MISMATCH');
  const outcome=youtubeProcessingOutcome(video,input.privacyStatus);
  if(outcome.state!=='published') throw Error(outcome.errorCode??'YOUTUBE_STATUS_UNAVAILABLE');
  return {id:video.id,connectionId:connection.id,title:video.snippet.title,description:video.snippet.description??''};
}

/** Writes progress only while this worker owns the lease; otherwise stops the step before any further network call. */
async function patchOwned(ctx,values){
  const saved=await patchYouTubeUpload(ctx.db,ctx.id,values,ctx.token);
  if(!saved) throw Error(LEASE_LOST);
  return saved;
}

async function startSession(ctx,row,token){
  youtubeOAuthConfig();
  const url=new URL('https://www.googleapis.com/upload/youtube/v3/videos');
  url.searchParams.set('uploadType','resumable');url.searchParams.set('part','snippet,status');
  let response;
  try{
    response=await fetch(url,{method:'POST',headers:{
      Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Upload-Content-Type':'video/mp4',
      'X-Upload-Content-Length':String(row.total_bytes),
    },body:JSON.stringify({snippet:{title:row.title,description:row.description},
      status:{privacyStatus:row.privacy_status,selfDeclaredMadeForKids:false,containsSyntheticMedia:true}}),cache:'no-store',
    signal:AbortSignal.timeout(ctx.timeouts.request)});
  }catch{throw Error('YOUTUBE_SESSION_CREATE_FAILED');}
  if(!response.ok) throw Error('YOUTUBE_SESSION_CREATE_FAILED');
  const location=response.headers.get('location');
  if(!location) throw Error('YOUTUBE_SESSION_INVALID');
  const encrypted=encryptYouTubeSecret(googleSessionUrl(location));
  await patchOwned(ctx,{state:'uploading',uploadUriEncrypted:encrypted,offset:0,errorCode:null});
  row.upload_uri_encrypted=encrypted;row.state='uploading';row.upload_offset=0;
}

async function inspectSession(ctx,row,token){
  const uri=googleSessionUrl(decryptYouTubeSecret(row.upload_uri_encrypted));
  let response;
  try{
    response=await fetch(uri,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Length':'0',
      'Content-Range':`bytes */${row.total_bytes}`,'Content-Type':'video/mp4'},body:new Uint8Array(0),cache:'no-store',
    signal:AbortSignal.timeout(ctx.timeouts.request)});
  }catch{throw Error('YOUTUBE_SESSION_STATUS_UNKNOWN');}
  if(response.status===200||response.status===201){
    const video=await response.json().catch(()=>null);
    if(typeof video?.id!=='string') throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
    await patchOwned(ctx,{state:'processing',youtubeId:video.id,errorCode:null,offset:row.total_bytes});
    return {...row,state:'processing',youtube_id:video.id,upload_offset:row.total_bytes};
  }
  if(response.status===308){
    const offset=youtubeOffsetFromRange(response.headers.get('range'),row.total_bytes);
    await patchOwned(ctx,{state:'uploading',offset,errorCode:null});
    return {...row,state:'uploading',upload_offset:offset};
  }
  if(response.status===404||response.status===410) throw Error('YOUTUBE_SESSION_EXPIRED_UNKNOWN');
  if(response.status>=500) throw Error('YOUTUBE_SESSION_STATUS_UNKNOWN');
  throw Error('YOUTUBE_SESSION_REJECTED');
}

async function uploadChunk(ctx,row,token){
  const start=Number(row.upload_offset);
  const end=Math.min(Number(row.total_bytes),start+CHUNK_BYTES)-1;
  if(start>=Number(row.total_bytes)) throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
  let bytes;
  try{
    const source=await fetch(await ctx.sourceUrl(row),{headers:{Range:`bytes=${start}-${end}`},cache:'no-store',
      signal:AbortSignal.timeout(ctx.timeouts.source)});
    if(source.status!==206) throw Error('YOUTUBE_SOURCE_RANGE_UNAVAILABLE');
    bytes=new Uint8Array(await source.arrayBuffer());
  }catch(error){
    throw Error(error instanceof Error&&/^YOUTUBE_/.test(error.message)?error.message:'YOUTUBE_SOURCE_RANGE_UNAVAILABLE');
  }
  if(bytes.byteLength!==end-start+1) throw Error('YOUTUBE_SOURCE_RANGE_INVALID');
  const uri=googleSessionUrl(decryptYouTubeSecret(row.upload_uri_encrypted));
  let response;
  try{
    response=await fetch(uri,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'video/mp4',
      'Content-Length':String(bytes.byteLength),'Content-Range':`bytes ${start}-${end}/${row.total_bytes}`},body:bytes,cache:'no-store',
    signal:AbortSignal.timeout(ctx.timeouts.chunk)});
  }catch{throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');}
  if(response.status===308){
    const offset=youtubeOffsetFromRange(response.headers.get('range'),row.total_bytes);
    if(offset<start) throw Error('YOUTUBE_SESSION_INVALID');
    await patchOwned(ctx,{state:'uploading',offset,errorCode:null});
    return {done:false,state:'uploading',offset};
  }
  if(response.status===200||response.status===201){
    const video=await response.json().catch(()=>null);
    if(typeof video?.id!=='string') throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
    await patchOwned(ctx,{state:'processing',offset:Number(row.total_bytes),youtubeId:video.id,errorCode:null});
    return {done:false,state:'processing',offset:Number(row.total_bytes),youtubeId:video.id};
  }
  if(response.status>=500||response.status===408||response.status===429) throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
  throw Error('YOUTUBE_UPLOAD_REJECTED');
}

async function reconcileVideo(ctx,row,token){
  const url=new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part','status');url.searchParams.set('id',row.youtube_id);
  let body;
  try{
    const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',
      signal:AbortSignal.timeout(ctx.timeouts.request)});
    if(!response.ok) throw Error('YOUTUBE_STATUS_UNAVAILABLE');
    body=await response.json();
  }catch{throw Error('YOUTUBE_STATUS_UNAVAILABLE');}
  const video=body?.items?.[0];
  if(!video) throw Error('YOUTUBE_STATUS_UNAVAILABLE');
  const result=youtubeProcessingOutcome(video,row.privacy_status,row.contains_synthetic_media);
  await patchOwned(ctx,{state:result.state,processingStatus:result.status,actualPrivacyStatus:result.privacy,
    actualContainsSyntheticMedia:result.containsSyntheticMedia,errorCode:result.errorCode});
  return {done:result.done,state:result.state};
}

/**
 * One leased step of the resumable upload. `deps` exists for tests only (source URL signer and timeouts).
 * @param {{sourceUrl?:(row:any)=>Promise<string>|string,timeouts?:Partial<typeof TIMEOUTS>}} [deps]
 */
export async function youtubeUploadStep(db,id,deps={}){
  const claim=await claimYouTubeUpload(db,id);
  if(claim.done)return {done:true,state:claim.state};
  if(claim.busy)return {done:false,busy:true};
  const ctx={db,id,token:claim.token,timeouts:{...TIMEOUTS,...deps.timeouts},
    sourceUrl:deps.sourceUrl??(row=>montageUrl({pathname:row.pathname,expires_at:row.expires_at},'get'))};
  /** @type {any} */
  let row=null;
  try{
    row=await loadYouTubeUploadInternal(db,id);
    if(!row.refresh_token_encrypted) throw Error('YOUTUBE_DISCONNECTED');
    const token=await accessToken(row);
    if(!row.upload_uri_encrypted){
      await startSession(ctx,row,token);
      row=await loadYouTubeUploadInternal(db,id);
    }
    if(row.youtube_id) return await reconcileVideo(ctx,row,token);
    row=await inspectSession(ctx,row,token);
    if(row.youtube_id)return await reconcileVideo(ctx,row,token);
    return await uploadChunk(ctx,row,token);
  }catch(error){
    const code=(error instanceof Error?error.message:'')||'YOUTUBE_UPLOAD_FAILED';
    if(code===LEASE_LOST)return {done:false,busy:true,lostLease:true};
    // Once bytes may have reached Google, a transient token failure must not declare the upload failed.
    const started=Boolean(row?.upload_uri_encrypted||row?.youtube_id);
    const unknown=code.includes('UNKNOWN')||code.includes('STATUS_UNAVAILABLE')||code==='YOUTUBE_SESSION_EXPIRED_UNKNOWN'
      ||started&&code==='YOUTUBE_TOKEN_REFRESH_FAILED';
    const saved=await patchYouTubeUpload(db,id,{state:unknown?'unknown':'failed',
      errorCode:/^YOUTUBE_[A-Z_]+$/.test(code)?code:'YOUTUBE_UPLOAD_FAILED'},claim.token);
    if(!saved)return {done:false,busy:true,lostLease:true};
    return {done:!unknown,state:unknown?'unknown':'failed'};
  }finally{await releaseYouTubeUploadLease(db,id,claim.token);}
}
