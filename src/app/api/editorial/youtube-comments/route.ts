import {database} from '../../../../db/runtime.mjs';
import {publicationError,publicationIdentity,publicationInput,publicationReply} from '../../../../access/publication-http';
import {approveYouTubeComment,loadYouTubeCommentDashboard,rejectYouTubeComment,updateYouTubeCommentSettings} from '../../../../db/youtube-comments.mjs';

export const dynamic='force-dynamic';

export async function GET(){
  try{const identity=await publicationIdentity();return publicationReply(await loadYouTubeCommentDashboard(await database(),identity));}
  catch(error){return publicationError(error);}
}

export async function POST(request:Request){
  try{
    const identity=await publicationIdentity(request),input=await publicationInput(request),db=await database();
    if(input.action==='settings')return publicationReply(await updateYouTubeCommentSettings(db,identity,input));
    if(input.action==='approve'&&typeof input.id==='string')return publicationReply(await approveYouTubeComment(db,identity,input.id));
    if(input.action==='reject'&&typeof input.id==='string')return publicationReply(await rejectYouTubeComment(db,identity,input.id));
    throw Error('INVALID_INPUT');
  }catch(error){return publicationError(error);}
}
