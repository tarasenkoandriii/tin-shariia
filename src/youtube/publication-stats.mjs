import { decryptYouTubeSecret, refreshYouTubeAccessToken, youtubeOAuthConfig } from './oauth.mjs';

const privateFetch=async(url,token)=>fetch(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});

/** Refreshes a bounded page of the project's own registered uploads. */
export async function syncYouTubePublicationStats(db,fetchImpl=privateFetch){
  const {rows:[connection]}=await db.query(`SELECT c.id,c.channel_id,c.refresh_token_encrypted FROM youtube_connections c
    WHERE c.disconnected_at IS NULL ORDER BY c.connected_at DESC LIMIT 1`);
  if(!connection?.refresh_token_encrypted)return {skipped:'YOUTUBE_NOT_CONNECTED',checked:0};
  const {rows:due}=await db.query(`SELECT * FROM (
    SELECT 'publication' AS kind,p.id AS target_id,p.youtube_id,p.published_at AS created_at,
      (SELECT fetched_at FROM publication_youtube_stats s WHERE s.publication_id=p.id ORDER BY fetched_at DESC LIMIT 1) AS fetched_at
    FROM publications p
    UNION ALL
    SELECT 'short' AS kind,u.id AS target_id,u.youtube_id,u.created_at,
      (SELECT fetched_at FROM publication_youtube_stats s WHERE s.upload_id=u.id ORDER BY fetched_at DESC LIMIT 1) AS fetched_at
    FROM youtube_short_uploads u WHERE u.state='published' AND u.youtube_id IS NOT NULL
  ) own WHERE own.fetched_at IS NULL OR own.fetched_at<now()-interval '6 hours'
  ORDER BY own.fetched_at NULLS FIRST,own.created_at DESC LIMIT 50`);
  if(!due.length)return {checked:0};
  const accessToken=await refreshYouTubeAccessToken(decryptYouTubeSecret(connection.refresh_token_encrypted),youtubeOAuthConfig());
  let saved=0,failed=0;
  for(let offset=0;offset<due.length;offset+=50){
    const page=due.slice(offset,offset+50),url=new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part','snippet,statistics');url.searchParams.set('id',page.map(row=>row.youtube_id).join(','));
    let response,body;
    try{response=await fetchImpl(url,accessToken);body=await response.json();if(!response.ok)throw Error('YOUTUBE_STATS_UNAVAILABLE');}
    catch{
      for(const row of page){await db.query(`INSERT INTO publication_youtube_stats(publication_id,upload_id,channel_id,error_code)
        VALUES($1,$2,$3,'YOUTUBE_STATS_UNAVAILABLE')`,[row.kind==='publication'?row.target_id:null,row.kind==='short'?row.target_id:null,connection.channel_id]);failed++;}
      continue;
    }
    const byId=new Map((body.items??[]).map(item=>[item.id,item]));
    for(const row of page){
      const item=byId.get(row.youtube_id);
      if(!item||item.snippet?.channelId!==connection.channel_id){
        await db.query(`INSERT INTO publication_youtube_stats(publication_id,upload_id,channel_id,error_code)
          VALUES($1,$2,$3,$4)`,[row.kind==='publication'?row.target_id:null,row.kind==='short'?row.target_id:null,connection.channel_id,
          item?'YOUTUBE_CHANNEL_MISMATCH':'YOUTUBE_VIDEO_UNAVAILABLE']);failed++;continue;
      }
      const count=value=>/^\d+$/.test(String(value??''))?String(value):null;
      await db.query(`INSERT INTO publication_youtube_stats(publication_id,upload_id,channel_id,title,description,views,likes,comments)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.kind==='publication'?row.target_id:null,row.kind==='short'?row.target_id:null,connection.channel_id,item.snippet.title??'',item.snippet.description??'',
        count(item.statistics?.viewCount),count(item.statistics?.likeCount),count(item.statistics?.commentCount)]);saved++;
    }
  }
  return {checked:due.length,saved,failed};
}
