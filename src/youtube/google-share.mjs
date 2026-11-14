// Only follow Google's public redirect hosts, never an arbitrary supplied URL.
// Stop before visiting the counter so validation does not count as a click.
export async function verifyGoogleShareLink(value, trackingLink, request=fetch) {
  const fail=()=>{throw Error('YOUTUBE_COMMENT_GOOGLE_SHARE_UNVERIFIED');};
  let current;
  try { current=new URL(value); } catch { return fail(); }
  if(current.origin!=='https://share.google'||current.username||current.password||current.hash||current.pathname==='/')return fail();
  const original=current.href;
  for(let hop=0;hop<4;hop++) {
    if(!['https://share.google','https://www.google.com','https://google.com'].includes(current.origin)||current.username||current.password)return fail();
    const response=await request(current,{redirect:'manual',signal:AbortSignal.timeout(8000)});
    const location=response.headers.get('location');
    if(![301,302,303,307,308].includes(response.status)||!location)return fail();
    const next=new URL(location,current);
    if(next.href===trackingLink)return original;
    current=next;
  }
  return fail();
}
