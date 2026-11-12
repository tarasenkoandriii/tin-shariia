const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

export function parseYouTubeUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return null;
  }

  let id;
  if (url.hostname === 'youtu.be') {
    id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  } else if (youtubeHosts.has(url.hostname)) {
    if (url.pathname === '/watch') {
      const ids = url.searchParams.getAll('v');
      if (ids.length === 1) id = ids[0];
    } else {
      id = /^\/(?:shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    }
  }

  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return { youtubeId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
}
