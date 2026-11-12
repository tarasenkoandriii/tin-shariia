import { BlobNotFoundError, head, issueSignedToken, presignUrl } from '@vercel/blob';

export const MAX_MEDIA_BYTES=128*1024*1024;
export const MAX_STORED_BYTES=512*1024*1024;
export const UPLOAD_MINUTES=15;
export const STORAGE_DAYS=30;

export function montageEnabled(){
  return process.env.MONTAGE_ENABLED==='true' && Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN)
    && Boolean(process.env.MONTAGE_FFMPEG_TOKEN);
}

export async function montageUrl(row,operation){
  const pathname=row.pathname;
  const validUntil=operation==='put'?new Date(row.upload_until).getTime():Date.now()+UPLOAD_MINUTES*60000;
  const constraints=operation==='put'?{
    maximumSizeInBytes:row.expected_bytes,allowedContentTypes:['video/mp4'],
  }:{};
  const token=await issueSignedToken({pathname,operations:[operation],validUntil,...constraints});
  const {presignedUrl}=await presignUrl(token,{
    access:'private',pathname,operation,validUntil,...constraints,
    ...(operation==='put'?{allowOverwrite:false,addRandomSuffix:false,ttlDays:STORAGE_DAYS}:{}),
  });
  return presignedUrl;
}

export async function montageHead(pathname){
  try{return await head(pathname);}
  catch(error){
    if(error instanceof BlobNotFoundError) throw Error('MONTAGE_OBJECT_MISSING');
    throw error;
  }
}
