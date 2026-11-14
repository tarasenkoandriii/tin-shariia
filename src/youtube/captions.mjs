// Best-effort read of a public video's YouTube captions, so the analysis can run on text instead of video
// (a 12-minute video is ~85k Gemini video tokens; its transcript is ~5k text tokens).
// Unofficial endpoints: YouTube may refuse datacenter IPs or change the format at any time. Every failure
// returns {ok:false, reason} and the caller falls back to whole-video Gemini analysis. Never throws.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const COOKIE = 'CONSENT=YES+1; SOCS=CAI';
const preferred = ['ru', 'uk'];
const maxSegmentMs = 20_000;
const maxSegmentChars = 400;

const decodeEntities = text => text
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function get(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, { ...init, redirect:'follow', cache:'no-store', signal:AbortSignal.timeout(8000),
    headers:{ 'User-Agent':UA, 'Accept-Language':'ru,uk;q=0.9,en;q=0.8', Cookie:COOKIE, ...init.headers } });
  return response;
}

// Pulls the JSON array that follows `"captionTracks":` out of a watch page.
export function captionTracksFromHtml(html) {
  const start = html.indexOf('"captionTracks":');
  if (start < 0) return null;
  const open = html.indexOf('[', start);
  let depth = 0, inString = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) {
      try { return JSON.parse(html.slice(open, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// Manual captions before auto-generated ones, Russian/Ukrainian before anything else.
export function pickCaptionTrack(tracks) {
  const usable = (tracks ?? []).filter(track => typeof track?.baseUrl === 'string' && typeof track?.languageCode === 'string');
  const rank = track => {
    const language = preferred.indexOf(track.languageCode.split('-')[0]);
    return (track.kind === 'asr' ? 10 : 0) + (language < 0 ? 5 : language);
  };
  return usable.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// json3: {events:[{tStartMs,dDurationMs,segs:[{utf8}]}]}; srv1 XML: <text start="1.2" dur="3.4">…</text>
export function parseCaptionPayload(body) {
  const cues = [];
  const text = body.trim();
  if (text.startsWith('{')) {
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    for (const event of data.events ?? []) {
      const words = (event.segs ?? []).map(seg => seg.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
      if (!words || !Number.isFinite(event.tStartMs)) continue;
      cues.push({ startMs:Math.round(event.tStartMs), endMs:Math.round(event.tStartMs + (event.dDurationMs ?? 0)), text:words });
    }
  } else {
    for (const match of text.matchAll(/<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g)) {
      const words = decodeEntities(decodeEntities(match[3]).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (!words) continue;
      const startMs = Math.round(Number(match[1]) * 1000);
      cues.push({ startMs, endMs:startMs + Math.round(Number(match[2] ?? 0) * 1000), text:words });
    }
  }
  return cues;
}

// Joins short caption lines into sentence-sized segments with monotonic, non-empty intervals.
export function mergeCaptionCues(cues) {
  const segments = [];
  let current = null;
  for (const cue of [...cues].sort((a, b) => a.startMs - b.startMs)) {
    const endMs = Math.max(cue.endMs, cue.startMs + 500);
    if (current && cue.startMs - current.startMs < maxSegmentMs && current.text.length + cue.text.length < maxSegmentChars
        && !/[.!?…]$/.test(current.text)) {
      current.text += ' ' + cue.text;
      current.endMs = Math.max(current.endMs, endMs);
      continue;
    }
    if (current) segments.push(current);
    current = { startMs:Math.max(cue.startMs, segments.at(-1)?.startMs ?? 0), endMs, text:cue.text };
  }
  if (current) segments.push(current);
  return segments.filter(segment => segment.endMs > segment.startMs && segment.text);
}

const srtTime = ms => {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};
export function captionsToSrt(segments) {
  return segments.map((segment, i) => `${i + 1}\n${srtTime(segment.startMs)} --> ${srtTime(segment.endMs)}\n${segment.text}`).join('\n\n') + '\n';
}

async function tracksFromPlayer(fetchImpl, youtubeId) {
  const response = await get(fetchImpl, 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ videoId:youtubeId, context:{ client:{ clientName:'WEB', clientVersion:'2.20261101.00.00', hl:'ru' } } }),
  });
  if (!response.ok) return { reason:'PLAYER_HTTP_' + response.status };
  const data = await response.json().catch(() => null);
  const status = data?.playabilityStatus?.status;
  if (status && status !== 'OK') return { reason:'PLAYER_' + status };
  return { tracks:data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null };
}

async function tracksFromWatchPage(fetchImpl, youtubeId) {
  const response = await get(fetchImpl, `https://www.youtube.com/watch?v=${youtubeId}&hl=ru`);
  if (!response.ok) return { reason:'WATCH_HTTP_' + response.status };
  const html = await response.text();
  if (/consent\.youtube\.com|action="https:\/\/consent\./.test(html)) return { reason:'WATCH_CONSENT' };
  return { tracks:captionTracksFromHtml(html), reason:/"LOGIN_REQUIRED"/.test(html) ? 'WATCH_LOGIN_REQUIRED' : null };
}

async function downloadTrack(fetchImpl, track) {
  for (const format of ['json3', null]) {
    const url = new URL(track.baseUrl);
    if (url.hostname !== 'www.youtube.com' && !url.hostname.endsWith('.youtube.com')) return [];
    if (format) url.searchParams.set('fmt', format); else url.searchParams.delete('fmt');
    const response = await get(fetchImpl, url.toString());
    if (!response.ok) continue;
    const cues = parseCaptionPayload(await response.text());
    if (cues.length) return cues;
  }
  return [];
}

/** @returns {Promise<{ok:true,language:string,automatic:boolean,segments:object[],srt:string}|{ok:false,reason:string}>} */
export async function fetchYouTubeCaptions(youtubeId, { fetchImpl = fetch } = {}) {
  if (!/^[\w-]{11}$/.test(youtubeId ?? '')) return { ok:false, reason:'INVALID_ID' };
  const reasons = [];
  for (const source of [tracksFromPlayer, tracksFromWatchPage]) {
    try {
      const found = await source(fetchImpl, youtubeId);
      const track = pickCaptionTrack(found.tracks);
      if (!track) { reasons.push(found.reason ?? (found.tracks ? 'NO_USABLE_TRACK' : 'NO_TRACKS')); continue; }
      const segments = mergeCaptionCues(await downloadTrack(fetchImpl, track));
      if (segments.length < 3) { reasons.push('EMPTY_TRACK'); continue; }
      return { ok:true, language:track.languageCode, automatic:track.kind === 'asr', segments, srt:captionsToSrt(segments) };
    } catch (error) {
      reasons.push(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED');
    }
  }
  return { ok:false, reason:reasons.join(',') || 'UNAVAILABLE' };
}
