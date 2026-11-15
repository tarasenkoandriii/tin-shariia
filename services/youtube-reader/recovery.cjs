/* eslint-disable @typescript-eslint/no-require-imports -- Shared by the CommonJS capture entry point. */
const fs = require('node:fs/promises');

const SESSION = '/profile/session.json';
const BACKUP = '/profile/session.previous.json';

function quoteError(status, reason = '') {
  if (status === 'LOGIN_REQUIRED') return 'QUOTE_SESSION_REQUIRED';
  if (status === 'UNPLAYABLE' || status === 'ERROR') {
    return /country|region|країн|стране/i.test(reason) ? 'QUOTE_GEO_BLOCKED' : 'QUOTE_VIDEO_UNAVAILABLE';
  }
  return null;
}

async function saveSession(context) {
  const temporary = SESSION + '.' + require('node:crypto').randomUUID() + '.new';
  await context.storageState({path: temporary});
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, SESSION);
}

async function restoreSession(context, file = SESSION) {
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(state.cookies) || !state.cookies.length) throw Error('QUOTE_SESSION_REQUIRED');
  await context.addCookies(state.cookies);
}

async function openVideo(page, videoId) {
  await page.goto('https://www.youtube.com/watch?v=' + videoId, {
    waitUntil: 'domcontentloaded', timeout: 40000,
  });
  const reject = page.getByRole('button', {
    name: /^(Alle ablehnen|Reject all|Відхилити всі|Отклонить все)$/,
  });
  if (await reject.count()) await reject.first().click({timeout: 5000}).catch(() => {});
  await page.waitForFunction(() => {
    const player = document.querySelector('#movie_player');
    return player?.getPlayerResponse?.()?.playabilityStatus || window.ytInitialPlayerResponse?.playabilityStatus;
  }, {}, {timeout: 20000});
  const state = await page.evaluate(() => {
    const player = document.querySelector('#movie_player');
    const response = player?.getPlayerResponse?.() ?? window.ytInitialPlayerResponse;
    return response?.playabilityStatus ?? {};
  });
  const error = quoteError(state.status, state.reason);
  if (error) throw Error(error);
  // A logged-in player can remain unbuffered until playback is explicitly requested.
  await page.evaluate(() => {
    document.querySelector('#movie_player')?.playVideo?.();
    const video = document.querySelector('video');
    if (video) {
      video.muted = true;
      video.play().catch(() => {});
    }
  });
  try {
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && video.readyState >= 2 && video.duration > 0
        && !document.querySelector('#movie_player.ad-showing');
    }, {}, {timeout: 30000});
  } catch {
    throw Error('QUOTE_PLAYBACK_TIMEOUT');
  }
}

async function prepareVideo(context, page, videoId) {
  const candidates = [SESSION, BACKUP];
  for (const file of candidates) {
    try {
      await context.clearCookies();
      await restoreSession(context, file);
      await openVideo(page, videoId);
      await saveSession(context);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.message !== 'QUOTE_SESSION_REQUIRED') throw error;
    }
  }
  throw Error('QUOTE_SESSION_REQUIRED');
}

module.exports = {quoteError, saveSession, restoreSession, openVideo, prepareVideo};
