import {verifyGoogleShareLink} from './google-share.mjs';

export async function verifyCommentShortLink(value, trackingLink, request=fetch) {
  if(typeof value==='string'&&value.startsWith('https://share.google/'))
    return verifyGoogleShareLink(value,trackingLink,request);
  let candidate;
  try { candidate=new URL(value); } catch { throw Error('YOUTUBE_COMMENT_SHORT_LINK_INVALID'); }
  if(!/^https:\/\/(?:is\.gd|v\.gd|tinyurl\.com)\/[a-z0-9_-]+$/i.test(candidate.href))
    throw Error('YOUTUBE_COMMENT_SHORT_LINK_INVALID');
  const response=await request(candidate,{redirect:'manual',signal:AbortSignal.timeout(8000)});
  await response.body?.cancel();
  if(![301,302,303,307,308].includes(response.status)||response.headers.get('location')!==trackingLink)
    throw Error('YOUTUBE_COMMENT_SHORT_LINK_INVALID');
  return candidate.href;
}

export async function createCommentShortLink(trackingLink,{googleLink,request=fetch}={}) {
  // Google is preferred when a real Google-generated link is available.
  // No public Google creation API: use documented free APIs otherwise.
  if(googleLink) {
    try { return {url:await verifyGoogleShareLink(googleLink,trackingLink,request),provider:'google'}; }
    catch { /* A failed preference must not prevent the free fallback. */ }
  }
  for(const provider of ['is.gd','v.gd']) {
    try {
      const endpoint=new URL('https://'+provider+'/create.php');
      endpoint.searchParams.set('format','json');
      endpoint.searchParams.set('url',trackingLink);
      const response=await request(endpoint,{redirect:'error',signal:AbortSignal.timeout(8000)});
      if(!response.ok)continue;
      const result=await response.json();
      if(typeof result.shorturl!=='string'||new URL(result.shorturl).hostname!==provider)continue;
      return {url:await verifyCommentShortLink(result.shorturl,trackingLink,request),provider};
    } catch { /* Try the next fixed provider; never expose provider responses. */ }
  }
  throw Error('YOUTUBE_COMMENT_SHORTENER_UNAVAILABLE');
}
