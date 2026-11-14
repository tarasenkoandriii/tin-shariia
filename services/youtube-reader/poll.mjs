import { setTimeout } from 'node:timers/promises';

const { YOUTUBE_READER_TOKEN } = process.env;
if (!YOUTUBE_READER_TOKEN) throw Error('YOUTUBE_READER_TOKEN_REQUIRED');

async function request(input) {
  const response = await fetch('https://tin-shariia.viral4creators.app/api/internal/captions-reader', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { authorization: 'Bearer ' + YOUTUBE_READER_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw Error('EDITORIAL_HTTP_' + response.status);
  return response.json();
}

async function read(youtubeId) {
  try {
    const response = await fetch('http://127.0.0.1:19333/read', {
      method: 'POST',
      signal: AbortSignal.timeout(145000),
      headers: { origin: 'http://127.0.0.1:19333', 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: youtubeId }),
    });
    const result = await response.json();
    if (response.ok && result.ok && typeof result.srt === 'string' && result.name?.startsWith(youtubeId + '-')) {
      return { srt: result.srt };
    }
    return { errorCode: response.ok ? 'NO_CAPTIONS' : 'READER_UNAVAILABLE' };
  } catch { return { errorCode: 'READER_UNAVAILABLE' }; }
}

for (;;) {
  try {
    const job = await request({ action: 'claim' });
    if (job) {
      const { videoId, youtubeId, lease } = job;
      const result = await read(youtubeId);
      const { accepted } = await request({ action: 'finish', videoId, lease, ...result });
      console.info('CAPTIONS_IMPORT', { youtubeId, accepted, status: result.errorCode ?? 'READ' });
    }
    const comment=await request({action:'claim-comment'});
    if(comment){
      let visible=false;
      try{
        const response=await fetch('http://127.0.0.1:19333/verify-comment',{
          method:'POST',headers:{origin:'http://127.0.0.1:19333','content-type':'application/json'},
          signal:AbortSignal.timeout(130000),body:JSON.stringify(comment),
        });
        visible=response.ok&&(await response.json()).visible===true;
      }catch{ /* A failed read cannot authorize a link edit. */ }
      await request({action:'finish-comment',id:comment.id,lease:comment.lease,visible});
      console.info('COMMENT_RELOAD_CHECK',{commentId:comment.commentId,visible});
    }
  } catch (error) {
    console.warn('CAPTIONS_IMPORT_POLL_FAILED', /^EDITORIAL_HTTP_\d{3}$/.test(error.message) ? error.message : 'REQUEST_FAILED');
  }
  await setTimeout(15000);
}
