import { randomUUID } from 'node:crypto';
import { uuid } from '../editorial/workflow-input.mjs';

export async function claimCommentVisibility(db){
  const {rows:[job]}=await db.query(`WITH candidate AS (
    SELECT s.comment_id FROM youtube_comment_steps s JOIN youtube_short_comments c ON c.id=s.comment_id
    WHERE c.state='published' AND (s.phase IN ('waiting_plain','waiting_link')
      OR (s.phase='link_sending' AND s.lease_until<now()))
      AND (s.lease_until IS NULL OR s.lease_until<now())
    ORDER BY s.updated_at FOR UPDATE OF s SKIP LOCKED LIMIT 1
  )
  UPDATE youtube_comment_steps s SET lease=$1,lease_until=now()+interval '4 minutes',
    phase=CASE WHEN phase='link_sending' THEN 'waiting_link' ELSE phase END
  FROM candidate j,youtube_short_comments c WHERE s.comment_id=j.comment_id AND c.id=s.comment_id
  RETURNING s.comment_id AS id,s.lease,s.phase,c.parent_video_id AS "videoId",
    c.youtube_comment_id AS "commentId",c.approved_channel_id AS "channelId",
    CASE WHEN s.phase='waiting_plain' THEN s.plain_text ELSE s.linked_text END AS "expectedText"`,
  [randomUUID()]);
  return job??null;
}

export async function finishCommentVisibility(db,input){
  const {rows:[row]}=await db.query(`UPDATE youtube_comment_steps SET
    phase=CASE WHEN $3 THEN CASE WHEN phase='waiting_plain' THEN 'link_ready' ELSE 'verified' END ELSE 'blocked' END,
    plain_verified_at=CASE WHEN $3 AND phase='waiting_plain' THEN now() ELSE plain_verified_at END,
    linked_verified_at=CASE WHEN $3 AND phase='waiting_link' THEN now() ELSE linked_verified_at END,
    checked_at=now(),updated_at=now(),lease=NULL,lease_until=NULL,
    error_code=CASE WHEN $3 THEN NULL ELSE 'YOUTUBE_COMMENT_RELOAD_NOT_CONFIRMED' END
    WHERE comment_id=$1 AND lease=$2 AND lease_until>now() AND phase IN ('waiting_plain','waiting_link')
    RETURNING comment_id`,[uuid(input.id),uuid(input.lease),input.visible===true]);
  return Boolean(row);
}

export async function claimCommentLinkUpdate(db){
  const {rows:[row]}=await db.query(`WITH candidate AS (
    SELECT comment_id FROM youtube_comment_steps WHERE phase='link_ready'
    ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE youtube_comment_steps s SET phase='link_sending',lease=$1,
    lease_until=now()+interval '2 minutes',updated_at=now()
  FROM candidate j,youtube_short_comments c,youtube_connections y
  WHERE s.comment_id=j.comment_id AND c.id=s.comment_id AND c.state='published'
    AND y.disconnected_at IS NULL
  RETURNING s.comment_id AS id,s.lease,s.linked_text,c.youtube_comment_id,
    c.parent_video_id,c.short_video_id,c.target_kind,c.approved_channel_id,
    (SELECT v.youtube_id FROM episodes e JOIN claims cl ON cl.id=e.claim_id
      JOIN videos v ON v.id=cl.video_id WHERE e.id=c.episode_id) AS source_video_id,
    y.channel_id,y.scopes,y.refresh_token_encrypted`,[randomUUID()]);
  return row??null;
}

export async function finishCommentLinkUpdate(db,row,errorCode=null){
  await db.query(`UPDATE youtube_comment_steps SET phase='waiting_link',lease=NULL,lease_until=NULL,
    error_code=$3,updated_at=now() WHERE comment_id=$1 AND lease=$2 AND phase='link_sending'`,
  [row.id,row.lease,errorCode]);
}
