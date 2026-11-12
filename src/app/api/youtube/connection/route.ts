import { database } from '../../../../db/runtime.mjs';
import { disconnectYouTube, getYouTubeConnection, getYouTubeConnectionSecret } from '../../../../db/youtube-uploads.mjs';
import { publicationIdentity, privateHeaders } from '../../../../access/publication-http';
import { decryptYouTubeSecret, revokeYouTubeToken } from '../../../../youtube/oauth.mjs';

export const dynamic='force-dynamic';

export async function GET(){
  try{
    const identity=await publicationIdentity();
    return Response.json({data:{connection:await getYouTubeConnection(await database(),identity)}},{headers:privateHeaders});
  }catch(error){
    const code=(error as Error)?.message;
    return Response.json({error:{code:code==='AUTH_REQUIRED'?'AUTH_REQUIRED':code==='FORBIDDEN'?'FORBIDDEN':'YOUTUBE_CONNECTION_FAILED'}},
      {status:code==='AUTH_REQUIRED'?401:code==='FORBIDDEN'?403:500,headers:privateHeaders});
  }
}

export async function DELETE(request:Request){
  try{
    const identity=await publicationIdentity(request);
    const db=await database();
    const connection=await getYouTubeConnectionSecret(db,identity);
    if(connection?.refresh_token_encrypted){
      await revokeYouTubeToken(decryptYouTubeSecret(connection.refresh_token_encrypted));
    }
    await disconnectYouTube(db,identity);
    return Response.json({data:{disconnected:true}},{headers:privateHeaders});
  }catch(error){
    const code=(error as Error)?.message;
    const status=code==='AUTH_REQUIRED'?401:code==='FORBIDDEN'||code==='ORIGIN_DENIED'?403:
      code==='YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED'?503:502;
    return Response.json({error:{code:status===401?'AUTH_REQUIRED':status===403?'FORBIDDEN':status===503?'YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED':'YOUTUBE_DISCONNECT_FAILED'}},
      {status,headers:privateHeaders});
  }
}
