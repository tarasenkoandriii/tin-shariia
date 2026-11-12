/** Serve a single immutable object through a short-lived job grant. */
export function createPrivateMediaHandler({ grants, readObject, now = Date.now }) {
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };

  return async (request) => {
    const url = new URL(request.url);
    const path = /^\/api\/media\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (!path) return new Response(null, { status: 404, headers });
    if (request.method !== 'GET') {
      return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
    }

    const [objectId] = path.slice(1);
    const jobId = url.searchParams.get('job');
    const token = url.searchParams.get('grant');
    if (!jobId || !grants.verify(token, { objectId, jobId, now: now() })) {
      return new Response(null, { status: 403, headers });
    }

    const body = await readObject(objectId);
    if (!body) return new Response(null, { status: 404, headers });
    return new Response(body, { headers: { ...headers, 'Content-Type': 'video/mp4' } });
  };
}
