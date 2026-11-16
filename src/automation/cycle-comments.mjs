import {createYouTubeCommentDraft,approveYouTubeComment} from '../db/youtube-comments.mjs';

export function cycleCommentHandlers(db,identity){
 return {
  async comment({artifacts,policy}){
   if(typeof policy.promotionText!=='string'||!policy.promotionText.trim())throw Error('CYCLE_COMMENT_APPROVAL_REQUIRED');
   const {rows:[upload]}=await db.query("SELECT id FROM youtube_short_uploads WHERE youtube_id=$1 AND state='published'",[artifacts.upload.youtubeId]);
   if(!upload)throw Error('CYCLE_UPLOAD_NOT_VERIFIED');
   let {rows:[row]}=await db.query("SELECT * FROM youtube_short_comments WHERE upload_id=$1 AND target_kind='source' ORDER BY created_at DESC LIMIT 1",[upload.id]);
   if(!row){
    const draft=await createYouTubeCommentDraft(db,identity,{uploadId:upload.id,targetKind:'source',text:policy.promotionText,generate:false});
    ({rows:[row]}=await db.query('SELECT * FROM youtube_short_comments WHERE id=$1',[draft.id]));
   }
   if(['unknown','failed','rejected'].includes(row.state))throw Error(row.error_code??'CYCLE_COMMENT_FAILED');
   const link='youtube.com/shorts/'+artifacts.upload.youtubeId;
   if(row.parent_video_id!==artifacts.discover.videoId||row.short_video_id!==artifacts.upload.youtubeId)throw Error('CYCLE_COMMENT_INVALID');
   if(row.state==='succeeded'){
    await approveYouTubeComment(db,identity,row.id,{text:policy.promotionText,targetVideoId:row.parent_video_id,channelId:policy.ownChannelId,link,publishNow:true});
    return {wait:true,code:'CYCLE_COMMENT_SCHEDULED'};
   }
   if(row.state!=='published')return {wait:true,code:'CYCLE_COMMENT_PENDING'};
   if(row.final_text!==policy.promotionText+'\n\n'+link)throw Error('CYCLE_COMMENT_APPROVAL_CHANGED');
   return {recordId:row.id,commentId:row.youtube_comment_id,sourceVideoId:row.parent_video_id,shortVideoId:row.short_video_id,
    channelId:row.approved_channel_id,shortLink:link,linkMode:'direct'};
  },
  async visibility({artifacts}){
   const {rows:[step]}=await db.query('SELECT phase,error_code,linked_verified_at FROM youtube_comment_steps WHERE comment_id=$1',[artifacts.comment.recordId]);
   if(step?.phase==='blocked')throw Error(step.error_code??'CYCLE_COMMENT_NOT_VISIBLE');
   if(step?.phase!=='verified')return {wait:true,code:'CYCLE_COMMENT_VISIBILITY_PENDING'};
   return {commentId:artifacts.comment.commentId,reloaded:true,visible:true,linkPresent:true,verificationMethod:'incognito-reload',checkedAt:step.linked_verified_at};
  },
 };
}
