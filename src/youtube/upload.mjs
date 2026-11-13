import { decryptYouTubeSecret, encryptYouTubeSecret, refreshYouTubeAccessToken, youtubeOAuthConfig } from './oauth.mjs';
import { loadYouTubeUploadInternal, patchYouTubeUpload, claimYouTubeUpload, releaseYouTubeUploadLease } from '../db/youtube-uploads.mjs';
import { montageUrl } from '../media/montage-storage.mjs';

const CHUNK_BYTES=8*1024*1024;
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
  const containsSyntheticMedia=video.status?.containsSyntheticMedia===true;
  if(['rejected','failed'].includes(status))return {state:'failed',done:true,status,privacy,errorCode:'YOUTUBE_PROCESSING_FAILED'};
  if(status==='processed'&&privacy!==expectedPrivacy)return {state:'failed',done:true,status,privacy,errorCode:'YOUTUBE_PRIVACY_MISMATCH'};
  if(status==='processed'&&containsSyntheticMedia!==expectedSynthetic)return {state:'failed',done:true,status,privacy,containsSyntheticMedia,errorCode:'YOUTUBE_AI_DISCLOSURE_MISMATCH'};
  if(status==='processed')return {state:'published',done:true,status,privacy,containsSyntheticMedia,errorCode:null};
  return {state:'processing',done:false,status,privacy,containsSyntheticMedia,errorCode:null};
}

async function accessToken(row){
  const config=youtubeOAuthConfig();
  return refreshYouTubeAccessToken(decryptYouTubeSecret(row.refresh_token_encrypted),config);
}

async function startSession(db,row,token){
  youtubeOAuthConfig();
  const url=new URL('https://www.googleapis.com/upload/youtube/v3/videos');
  url.searchParams.set('uploadType','resumable');url.searchParams.set('part','snippet,status');
  const response=await fetch(url,{method:'POST',headers:{
    Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Upload-Content-Type':'video/mp4',
    'X-Upload-Content-Length':String(row.total_bytes),
  },body:JSON.stringify({snippet:{title:row.title,description:row.description},
    status:{privacyStatus:row.privacy_status,selfDeclaredMadeForKids:false,containsSyntheticMedia:true}}),cache:'no-store'});
  if(!response.ok) throw Error('YOUTUBE_SESSION_CREATE_FAILED');
  const location=response.headers.get('location');
  if(!location) throw Error('YOUTUBE_SESSION_INVALID');
  const encrypted=encryptYouTubeSecret(googleSessionUrl(location));
  await patchYouTubeUpload(db,row.id,{state:'uploading',uploadUriEncrypted:encrypted,offset:0,errorCode:null});
  row.upload_uri_encrypted=encrypted;row.state='uploading';row.upload_offset=0;
}

async function inspectSession(row,token){
  const uri=googleSessionUrl(decryptYouTubeSecret(row.upload_uri_encrypted));
  let response;
  try{
    response=await fetch(uri,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Length':'0',
      'Content-Range':`bytes */${row.total_bytes}`,'Content-Type':'video/mp4'},body:new Uint8Array(0),cache:'no-store'});
  }catch{throw Error('YOUTUBE_SESSION_STATUS_UNKNOWN');}
  if(response.status===200||response.status===201){
    const video=await response.json().catch(()=>null);
    if(typeof video?.id!=='string') throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
    await patchYouTubeUpload(row.db,row.id,{state:'processing',youtubeId:video.id,errorCode:null,offset:row.total_bytes});
    return {...row,state:'processing',youtube_id:video.id,upload_offset:row.total_bytes};
  }
  if(response.status===308){
    const offset=youtubeOffsetFromRange(response.headers.get('range'),row.total_bytes);
    await patchYouTubeUpload(row.db,row.id,{state:'uploading',offset,errorCode:null});
    return {...row,state:'uploading',upload_offset:offset};
  }
  if(response.status===404||response.status===410) throw Error('YOUTUBE_SESSION_EXPIRED_UNKNOWN');
  if(response.status>=500) throw Error('YOUTUBE_SESSION_STATUS_UNKNOWN');
  throw Error('YOUTUBE_SESSION_REJECTED');
}

async function uploadChunk(db,row,token){
  const start=Number(row.upload_offset);
  const end=Math.min(Number(row.total_bytes),start+CHUNK_BYTES)-1;
  if(start>=Number(row.total_bytes)) throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
  const source=await fetch(await montageUrl({pathname:row.pathname,expires_at:row.expires_at},'get'),{
    headers:{Range:`bytes=${start}-${end}`},cache:'no-store'});
  if(source.status!==206) throw Error('YOUTUBE_SOURCE_RANGE_UNAVAILABLE');
  const bytes=new Uint8Array(await source.arrayBuffer());
  if(bytes.byteLength!==end-start+1) throw Error('YOUTUBE_SOURCE_RANGE_INVALID');
  const uri=googleSessionUrl(decryptYouTubeSecret(row.upload_uri_encrypted));
  let response;
  try{
    response=await fetch(uri,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'video/mp4',
      'Content-Length':String(bytes.byteLength),'Content-Range':`bytes ${start}-${end}/${row.total_bytes}`},body:bytes,cache:'no-store'});
  }catch{throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');}
  if(response.status===308){
    const offset=youtubeOffsetFromRange(response.headers.get('range'),row.total_bytes);
    if(offset<start) throw Error('YOUTUBE_SESSION_INVALID');
    await patchYouTubeUpload(db,row.id,{state:'uploading',offset,errorCode:null});
    return {done:false,state:'uploading',offset};
  }
  if(response.status===200||response.status===201){
    const video=await response.json().catch(()=>null);
    if(typeof video?.id!=='string') throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
    await patchYouTubeUpload(db,row.id,{state:'processing',offset:Number(row.total_bytes),youtubeId:video.id,errorCode:null});
    return {done:false,state:'processing',offset:Number(row.total_bytes),youtubeId:video.id};
  }
  if(response.status>=500||response.status===408||response.status===429) throw Error('YOUTUBE_UPLOAD_OUTCOME_UNKNOWN');
  throw Error('YOUTUBE_UPLOAD_REJECTED');
}

async function reconcileVideo(db,row,token){
  const url=new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part','status');url.searchParams.set('id',row.youtube_id);
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  if(!response.ok) throw Error('YOUTUBE_STATUS_UNAVAILABLE');
  const body=await response.json();
  const video=body.items?.[0];
  if(!video) throw Error('YOUTUBE_STATUS_UNAVAILABLE');
  const result=youtubeProcessingOutcome(video,row.privacy_status,row.contains_synthetic_media);
  await patchYouTubeUpload(db,row.id,{state:result.state,processingStatus:result.status,actualPrivacyStatus:result.privacy,
    actualContainsSyntheticMedia:result.containsSyntheticMedia,errorCode:result.errorCode});
  return {done:result.done,state:result.state};
}

export async function youtubeUploadStep(db,id){
  const claim=await claimYouTubeUpload(db,id);
  if(claim.done)return {done:true,state:claim.state};
  if(claim.busy)return {done:false,busy:true};
  try{
    let row=await loadYouTubeUploadInternal(db,id);
    if(!row.refresh_token_encrypted) throw Error('YOUTUBE_DISCONNECTED');
    if(!row.upload_uri_encrypted){
      await startSession(db,row,await accessToken(row));
      row=await loadYouTubeUploadInternal(db,id);
    }
    if(row.youtube_id) return await reconcileVideo(db,row,await accessToken(row));
    const token=await accessToken(row);
    row=await inspectSession(row,token);
    if(row.youtube_id)return await reconcileVideo(db,row,token);
    return await uploadChunk(db,row,token);
  }catch(error){
    const code=(error instanceof Error?error.message:'')||'YOUTUBE_UPLOAD_FAILED';
    const unknown=code.includes('UNKNOWN')||code.includes('STATUS_UNAVAILABLE')||code==='YOUTUBE_SESSION_EXPIRED_UNKNOWN';
    await patchYouTubeUpload(db,id,{state:unknown?'unknown':'failed',errorCode:/^YOUTUBE_[A-Z_]+$/.test(code)?code:'YOUTUBE_UPLOAD_FAILED'});
    return {done:!unknown,state:unknown?'unknown':'failed'};
  }finally{await releaseYouTubeUploadLease(db,id);}
}

