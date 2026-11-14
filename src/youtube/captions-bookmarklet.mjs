// Bookmarklet the editor runs on a youtube.com video page from the newsroom's own browser. It takes the
// captions the player has already loaded (their URL carries the player's PO token), or the open
// «Show transcript» panel, and saves an SRT for the existing transcript import form.
// No proxy, no Gemini, no request to our server. Runs entirely in the editor's browser.
//
// The function must stay self-contained: it is serialised with toString() into a javascript: URL,
// so it may only use its parameters and browser globals. The merge rules mirror mergeCaptionCues.

export async function captionsBookmarklet(win, doc, { download = true } = {}) {
  const preferred = ['ru', 'uk'];
  const finish = (ok, message, extra = {}) => {
    if (download) win.alert(message);
    return { ok, message, ...extra };
  };
  if (!/(^|\.)youtube\.com$/.test(win.location.hostname)) {
    return finish(false, 'Відкрийте ролик на youtube.com і натисніть закладку на його сторінці.');
  }
  const here = new URL(win.location.href);
  const id = here.searchParams.get('v') || (here.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/) || [])[1];
  if (!/^[\w-]{11}$/.test(id || '')) return finish(false, 'Не знайдено ID ролика в адресі сторінки.');

  // After in-app navigation ytInitialPlayerResponse can belong to the previous video; the player knows the current one.
  const player = doc.getElementById('movie_player');
  let raw = null;
  try { raw = player && player.getPlayerResponse ? player.getPlayerResponse() : null; } catch { raw = null; }
  const initial = win.ytInitialPlayerResponse;
  const isCurrent = value => value && value.videoDetails && value.videoDetails.videoId === id;
  const response = isCurrent(raw) ? raw : isCurrent(initial) ? initial : null;
  // An unplayable video (e.g. closed in Ukraine) comes back without videoDetails, only with a status.
  const playability = (response || raw || initial || {}).playabilityStatus;
  const list = response && response.captions && response.captions.playerCaptionsTracklistRenderer;
  const tracks = ((list && list.captionTracks) || []).filter(track => track && typeof track.languageCode === 'string');
  const rank = track => {
    const language = preferred.indexOf(track.languageCode.split('-')[0]);
    return (track.kind === 'asr' ? 10 : 0) + (language < 0 ? 5 : language);
  };
  const track = tracks.slice().sort((a, b) => rank(a) - rank(b))[0] || null;

  if (!tracks.length && playability && playability.status && playability.status !== 'OK') {
    const reason = String(playability.reason || playability.status).replace(/\s+/g, ' ').trim().slice(0, 160);
    return finish(false, `YouTube не відтворює цей ролик у цьому браузері: «${reason}». Якщо ролик закритий в Україні, `
      + 'увімкніть VPN з виходом за межами України, оновіть сторінку ролика й натисніть закладку ще раз.', { playability:playability.status });
  }
  const loaded = () => win.performance.getEntriesByType('resource').map(entry => entry.name).filter(name => {
    try {
      const url = new URL(name);
      return url.pathname === '/api/timedtext' && url.searchParams.get('v') === id && url.searchParams.has('pot');
    } catch { return false; }
  });
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  let urls = loaded();
  if (!urls.length && track && player) {
    // Ask the player to load the preferred track; click CC as a fallback. The player adds its own PO token.
    try {
      if (player.loadModule) player.loadModule('captions');
      if (player.setOption) player.setOption('captions', 'track', { languageCode:track.languageCode });
    } catch { /* older player API */ }
    const button = doc.querySelector('.ytp-subtitles-button');
    for (let i = 0; i < 16 && !(urls = loaded()).length; i++) {
      if (i === 4 && button && button.getAttribute('aria-pressed') === 'false') button.click();
      await sleep(500);
    }
  }

  let cues = [], language = null, automatic = false;
  if (urls.length) {
    const sameTrack = urls.filter(name => track && new URL(name).searchParams.get('lang') === track.languageCode);
    const url = new URL((sameTrack.length ? sameTrack : urls)[(sameTrack.length ? sameTrack : urls).length - 1]);
    url.searchParams.delete('tlang'); // original language, not YouTube's auto-translation
    url.searchParams.set('fmt', 'json3');
    language = url.searchParams.get('lang');
    automatic = url.searchParams.get('kind') === 'asr';
    const body = await (await win.fetch(url.toString(), { credentials:'include' })).text();
    let data = null;
    try { data = JSON.parse(body); } catch { data = null; }
    for (const event of (data && data.events) || []) {
      const words = (event.segs || []).map(seg => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!words || !Number.isFinite(event.tStartMs)) continue;
      cues.push({ startMs:Math.round(event.tStartMs), endMs:Math.round(event.tStartMs + (event.dDurationMs || 0)), text:words });
    }
  }
  if (!cues.length) {
    // Fallback: the «Show transcript» panel (start times only; each line ends where the next begins).
    const toMs = text => {
      const parts = String(text || '').trim().split(':').map(Number);
      if (!parts.length || parts.some(part => !Number.isFinite(part))) return null;
      return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
    };
    const rows = [];
    const legacyRows = Array.from(doc.querySelectorAll('ytd-transcript-segment-renderer'));
    const modernRows = Array.from(doc.querySelectorAll('transcript-segment-view-model'));
    for (const row of legacyRows.length ? legacyRows : modernRows) {
      const modern = !legacyRows.length;
      const visible = modern ? String(row.innerText || row.textContent || '').trim().match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/) : null;
      const timestamp = modern ? visible?.[1] : row.querySelector('.segment-timestamp')?.textContent;
      const startMs = toMs(timestamp);
      const words = String(modern ? visible?.[2] || '' : row.querySelector('.segment-text')?.textContent || '').replace(/\s+/g, ' ').trim();
      if (startMs !== null && words) rows.push({ startMs, text:words });
    }
    cues = rows.map((row, i) => ({ ...row, endMs:rows[i + 1] ? rows[i + 1].startMs : row.startMs + 3000 }));
    if (cues.length) { language = track ? track.languageCode : 'transcript'; automatic = track ? track.kind === 'asr' : false; }
  }

  const segments = [];
  let current = null;
  for (const cue of cues.slice().sort((a, b) => a.startMs - b.startMs)) {
    const endMs = Math.max(cue.endMs, cue.startMs + 500);
    if (current && cue.startMs - current.startMs < 20000 && current.text.length + cue.text.length < 400 && !/[.!?…]$/.test(current.text)) {
      current.text += ' ' + cue.text;
      current.endMs = Math.max(current.endMs, endMs);
      continue;
    }
    if (current) segments.push(current);
    current = { startMs:Math.max(cue.startMs, segments.length ? segments[segments.length - 1].startMs : 0), endMs, text:cue.text };
  }
  if (current) segments.push(current);
  const usable = segments.filter(segment => segment.endMs > segment.startMs && segment.text);
  if (usable.length < 3) {
    return finish(false, tracks.length || urls.length
      ? 'Субтитри не знайдено. Увімкніть субтитри (CC) у плеєрі або відкрийте «Показати транскрипцію» під відео й натисніть закладку ще раз.'
      : 'YouTube не показує субтитрів для цього ролика. Відкрийте «Показати транскрипцію» під відео, якщо вона є, і натисніть закладку ще раз.');
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const time = ms => `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  const srt = usable.map((segment, i) => `${i + 1}\n${time(segment.startMs)} --> ${time(segment.endMs)}\n${segment.text}`).join('\n\n') + '\n';
  const name = `${id}-${language}${automatic ? '-auto' : ''}.srt`;
  if (download) {
    const link = doc.createElement('a');
    link.href = URL.createObjectURL(new Blob([srt], { type:'application/x-subrip' }));
    link.download = name;
    doc.body.append(link);
    link.click();
    link.remove();
    win.setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }
  return finish(true, `Збережено ${name}: мова ${language}, ${automatic ? 'автоматичні' : 'ручні'} субтитри, ${usable.length} фрагментів. `
    + 'Імпортуйте файл у картці випуску: «Розшифрування» → SRT.', { name, language, automatic, segments:usable.length, srt });
}

/** javascript: URL for the bookmarks bar. Contains no secrets and talks to nobody but youtube.com. */
export function captionsBookmarkletHref() {
  const code = `void (${captionsBookmarklet.toString()})(window,document).catch(function(e){alert('Помилка закладки: '+(e&&e.message))})`;
  return 'javascript:' + encodeURIComponent(code);
}
