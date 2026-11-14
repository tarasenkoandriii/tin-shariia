import {verifyCommentAfterReload} from './comment-visibility.mjs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chmod, readFile } from 'node:fs/promises';
import { captionsBookmarklet } from './captions-bookmarklet.mjs';

const require = createRequire('/app/package.json');
const { chromium } = require('playwright-core');
const context = await chromium.launchPersistentContext('/profile', {
  headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 800 },
});
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  const allowed = ['youtube.com', 'googlevideo.com', 'ytimg.com', 'google.com', 'gstatic.com']
    .some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  if (url.protocol === 'https:' && (!url.port || url.port === '443') && allowed) await route.continue();
  else await route.abort();
});
const page = context.pages()[0] ?? await context.newPage();
try {
  const saved = JSON.parse(await readFile('/profile/session.json', 'utf8'));
  await context.addCookies(saved.cookies);
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('SESSION_LOAD_FAILED');
}
let busy = false;
const html = `<!doctype html><meta charset="utf-8"><title>YouTube reader pilot</title>
<h1>YouTube reader · private pilot</h1><p>Connection through the SSH tunnel. No Gemini calls.</p>
<form id="session"><label>YouTube session JSON <textarea id="cookies" autocomplete="off"></textarea></label><button>Import session</button></form>
<form id="read"><label>YouTube video ID <input id="video" maxlength="11" required></label><button>Check captions</button></form>
<p><a id="download" hidden>Download SRT</a></p>
<pre id="result" role="status"></pre><script>
const output=document.querySelector('#result');
const download=document.querySelector('#download');
async function send(path,data){
  if(download.href) URL.revokeObjectURL(download.href);
  download.removeAttribute('href');
  download.hidden=true;
  output.textContent='Working…';
  try{
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const {srt,...result}=await response.json();
    output.textContent=JSON.stringify(result,null,2);
    if(response.ok&&result.ok&&typeof srt==='string'&&srt.length){
      download.href=URL.createObjectURL(new Blob([srt],{type:'text/plain;charset=utf-8'}));
      download.download=data.videoId+'.srt';
      download.hidden=false;
    }
  }catch{output.textContent='Reader connection failed.';}
}
document.querySelector('#session').onsubmit=async e=>{e.preventDefault();try{const c=JSON.parse(document.querySelector('#cookies').value);document.querySelector('#cookies').value='';await send('/session',{cookies:c})}catch{document.querySelector('#result').textContent='Invalid session JSON'}};
document.querySelector('#read').onsubmit=async e=>{e.preventDefault();await send('/read',{videoId:document.querySelector('#video').value})};
</script>`;

http.createServer(async (req, res) => {
  const reply = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" });
    return res.end(html);
  }
  // Loopback-only SSH tunnel plus same-origin requests. Never expose this pilot port publicly.
  if (req.method !== 'POST' || !['/session', '/read','/verify-comment'].includes(req.url)
      || req.headers.origin !== 'http://127.0.0.1:19333') return reply(403, { error: 'FORBIDDEN' });
  if (busy) return reply(409, { error: 'BUSY' });
  busy = true;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 65536) return reply(413, { error: 'TOO_LARGE' });
    }
    const input = JSON.parse(body);
    if(req.url==='/verify-comment') return reply(200,{visible:await verifyCommentAfterReload(page,input)});
    if (req.url === '/session') {
      if (!Array.isArray(input.cookies) || input.cookies.length > 100) return reply(400, { error: 'INVALID_SESSION' });
      const cookies = input.cookies.filter(c => ['youtube.com', '.youtube.com', 'www.youtube.com', 'studio.youtube.com'].includes(c.domain))
        .map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) =>
          ({ name, value, domain, path: path || '/', expires, httpOnly, secure,
            sameSite: ['Strict', 'Lax', 'None'].includes(sameSite) ? sameSite : 'Lax' }));
      if (!cookies.length) return reply(400, { error: 'NO_YOUTUBE_COOKIES' });
      await context.clearCookies();
      await context.addCookies(cookies);
      await context.storageState({ path: '/profile/session.json' });
      await chmod('/profile/session.json', 0o600);
      return reply(200, { imported: cookies.length });
    }
    if (!/^[\w-]{11}$/.test(input.videoId ?? '')) return reply(400, { error: 'INVALID_VIDEO_ID' });
    await page.goto('https://www.youtube.com/watch?v=' + input.videoId, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#movie_player', { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => {
      const player = document.querySelector('#movie_player');
      player?.mute?.();
      player?.playVideo?.();
    });
    await page.waitForTimeout(3000);
    for (let attempt = 0; attempt < 20; attempt++) {
      const advertising = await page.locator('#movie_player.ad-showing').count();
      if (!advertising) break;
      const skip = page.locator('.ytp-ad-skip-button, .ytp-ad-skip-button-modern');
      if (await skip.first().isVisible().catch(() => false)) {
        if (await skip.first().isEnabled()) await skip.first().click({ timeout: 2000 }).catch(() => {});
      }
      await page.waitForTimeout(2000);
    }
    await page.evaluate(() => document.querySelector('ytd-watch-metadata #expand')?.click());
    const transcript = page.getByRole('button', { name: /Show transcript|Показать текст|Показать расшифровку|Показати текст|Показати транскрипцію|Текст відео/i });
    await transcript.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await transcript.count()) await transcript.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForSelector('ytd-transcript-segment-renderer, transcript-segment-view-model', { timeout: 10000 }).catch(() => {});
    const result = await page.evaluate('(' + captionsBookmarklet.toString() + ')(window,document,{download:false})');
    const direct = result.ok ? null : await page.evaluate(async () => {
      const player = document.querySelector('#movie_player');
      const tracks = player?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const outcomes = [];
      for (const track of tracks) {
        const url = new URL(track.baseUrl);
        if (url.hostname !== 'www.youtube.com') continue;
        url.searchParams.set('fmt', 'json3');
        try {
          const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(8000) });
          const body = await response.text();
          const data = JSON.parse(body || '{}');
          const events = (data.events ?? []).filter(e => e.segs?.some(s => s.utf8));
          outcomes.push({ language: track.languageCode, status: response.status, bytes: body.length, fragments: events.length });
        } catch { outcomes.push({ language: track.languageCode, error: 'TRACK_FETCH_FAILED' }); }
      }
      return outcomes;
    });
    const diagnostics = await page.evaluate(() => {
      const player = document.querySelector('#movie_player');
      const response = player?.getPlayerResponse?.();
      return { loggedIn: window.ytcfg?.get?.('LOGGED_IN') === true,
        playability: response?.playabilityStatus?.status ?? null,
        reason: response?.playabilityStatus?.reason ?? null,
        playerState: player?.getPlayerState?.(),
        playerError: player?.getVideoData?.()?.errorCode ?? null,
        tracks: response?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length ?? 0,
        transcriptRows: document.querySelectorAll('ytd-transcript-segment-renderer').length,
        transcriptElements: [...new Set(Array.from(document.querySelectorAll('*')).map(e => e.tagName.toLowerCase()).filter(n => n.includes('transcript')))].slice(0, 15),
        transcriptButtons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim())
          .filter(text => /transcript|расшифров|транскрип|текст відео/i.test(text)).slice(0, 5),
        timedtextRequests: performance.getEntriesByType('resource').filter(e => e.name.includes('/api/timedtext')).length };
    });
    await context.storageState({ path: '/profile/session.json' }).then(() => chmod('/profile/session.json', 0o600)).catch(() => {});
    return reply(200, { ...result, diagnostics, direct });
  } catch {
    reply(502, { error: 'READER_FAILED' });
  } finally {
    busy = false;
  }
}).listen(19333, '0.0.0.0', () => console.log('YOUTUBE_READER_READY'));

process.on('SIGTERM', async () => { await context.close(); process.exit(); });
