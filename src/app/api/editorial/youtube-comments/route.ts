import {uuid} from '../../../../editorial/workflow-input.mjs';
import {after} from 'next/server';
import {activeMember} from '../../../../access/membership.mjs';
import {checkPublishedYouTubeComment,checkYouTubeCommentOAuth,publishOne} from '../../../../youtube/comments.mjs';
import {database} from '../../../../db/runtime.mjs';
import {publicationError,publicationIdentity,publicationInput,publicationReply} from '../../../../access/publication-http';
import {prepareYouTubeCommentShortLink,approveYouTubeComment,createYouTubeCommentDraft,loadYouTubeCommentDashboard,recoverYouTubeComment,rejectYouTubeComment,updateYouTubeCommentSettings} from '../../../../db/youtube-comments.mjs';

export const dynamic='force-dynamic';

export async function GET(){
  try{const identity=await publicationIdentity();return publicationReply(await loadYouTubeCommentDashboard(await database(),identity));}
  catch(error){return publicationError(error);}
}

export async function POST(request:Request){
  try{
    const identity=await publicationIdentity(request),input=await publicationInput(request),db=await database();
    if(input.action==='check-oauth'||input.action==='check-published'){
      const member=await activeMember(db,identity);
      if(!member?.roles.includes('editor'))throw Error('FORBIDDEN');
      return publicationReply(input.action==='check-oauth' ? await checkYouTubeCommentOAuth(db) : await checkPublishedYouTubeComment(db,uuid(input.id)));
    }
    if(input.action==='shorten')return publicationReply(await prepareYouTubeCommentShortLink(db,identity,input.id,input.googleLink));
    if(input.action==='settings')return publicationReply(await updateYouTubeCommentSettings(db,identity,input));
    if(input.action==='draft'&&typeof input.generate==='boolean')return publicationReply(await createYouTubeCommentDraft(db,identity,input));
    if(input.action==='approve'&&typeof input.id==='string'){
      const row=await approveYouTubeComment(db,identity,input.id,input);
      if(input.publishNow===true)after(()=>publishOne(db));
      return publicationReply(row);
    }
    if(input.action==='recover'&&typeof input.id==='string')return publicationReply(await recoverYouTubeComment(db,identity,input.id));
    if(input.action==='reject'&&typeof input.id==='string')return publicationReply(await rejectYouTubeComment(db,identity,input.id));
    throw Error('INVALID_INPUT');
  }catch(error){return publicationError(error);}
}
