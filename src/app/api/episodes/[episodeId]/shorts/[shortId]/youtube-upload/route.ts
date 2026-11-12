import {after} from 'next/server';
import {start} from 'workflow/api';
import {publicationError,publicationIdentity,publicationInput,publicationReply} from '../../../../../../../access/publication-http';
import {database} from '../../../../../../../db/runtime.mjs';
import {createYouTubeShortUpload,loadYouTubeUploadForShort} from '../../../../../../../db/youtube-uploads.mjs';
import {uploadYouTubeShort} from '../../../../../../../workflows/youtube-upload';
import {youtubeOAuthConfig} from '../../../../../../../youtube/oauth.mjs';

type Context={params:Promise<{episodeId:string;shortId:string}>};

async function dispatch(id:string){await start(uploadYouTubeShort,[id]);}

export async function GET(_request:Request,{params}:Context){
  try{
    const identity=await publicationIdentity();
    const {episodeId,shortId}=await params;
    const row=await loadYouTubeUploadForShort(await database(),identity,episodeId,shortId);
    if(['queued','uploading','processing','unknown'].includes(row.state)) after(async()=>{try{await dispatch(row.id);}catch{/* Workflow can be restarted on the next status read. */}});
    return publicationReply({id:row.id,state:row.state,title:row.title,privacyStatus:row.privacy_status,
      uploadOffset:Number(row.upload_offset),totalBytes:Number(row.total_bytes),sha256:row.sha256,youtubeId:row.youtube_id,
      processingStatus:row.processing_status,actualPrivacyStatus:row.actual_privacy_status,errorCode:row.error_code,
      url:row.youtube_id?`https://www.youtube.com/shorts/${row.youtube_id}`:null,createdAt:row.created_at});
  }catch(error){return publicationError(error);}
}

export async function POST(request:Request,{params}:Context){
  try{
    const identity=await publicationIdentity(request);
    youtubeOAuthConfig();
    if(!process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY) throw Error('YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED');
    const {episodeId,shortId}=await params;
    const row=await createYouTubeShortUpload(await database(),identity,episodeId,shortId,await publicationInput(request));
    if(['queued','uploading','processing','unknown'].includes(row.state)) after(async()=>{try{await dispatch(row.id);}catch{/* Workflow can be restarted on the next status read. */}});
    return publicationReply({id:row.id,state:row.state,title:row.title,privacyStatus:row.privacy_status},202);
  }catch(error){return publicationError(error);}
}
