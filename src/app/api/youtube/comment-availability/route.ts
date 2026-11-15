import {publicationError,publicationIdentity,publicationReply} from '../../../../access/publication-http';
import {database} from '../../../../db/runtime.mjs';
import {checkCommentAvailability} from '../../../../youtube/comment-availability.mjs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{return publicationReply(await checkCommentAvailability(await database(),await publicationIdentity(),new URL(request.url).searchParams.get('videoId')));}catch(error){return publicationError(error);}
}
