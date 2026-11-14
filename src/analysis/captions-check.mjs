import { activeMember } from '../access/membership.mjs';
import { uuid } from '../editorial/workflow-input.mjs';
import { fetchYouTubeCaptions } from '../youtube/captions.mjs';

// Editors can see whether YouTube serves captions for a saved video. This only reads YouTube:
// it never calls Gemini or Soniox, reserves no budget, queues nothing and writes no transcript.

const editorialRoles = ['author', 'factchecker', 'editor', 'admin'];
const networkReason = /^(FETCH_FAILED|TIMEOUT|[A-Z_]+_HTTP_5\d\d)$/;
const noTrackReason = /^(NO_TRACKS|NO_USABLE_TRACK|EMPTY_TRACK)$/;

const proxyHostOf = via => (typeof via === 'string' && via.startsWith('proxy ') ? via.slice(6) : null);

/** Turns a fetchYouTubeCaptions outcome into one status the editor can act on. No credentials leave here. */
export function classifyCaptionsCheck(found) {
  const steps = (found.steps ?? []).map(({ source, reason, note }) => ({ source, reason, note:note ?? null }));
  const proxyFailures = (found.proxyFailures ?? []).map(({ status, codes }) => ({ status:status ?? null, codes:codes ?? [] }));
  const reasons = steps.map(step => step.reason).filter(Boolean);
  const base = { via:found.via ?? 'direct', proxy:proxyHostOf(found.via), steps, proxyFailures };
  if (found.ok) {
    return { ...base, status:'available', language:found.language, automatic:found.automatic, segments:found.segments.length };
  }
  const reason = found.reason ?? 'UNAVAILABLE';
  if (proxyFailures.some(failure => failure.status === 407)) return { ...base, status:'proxy_auth', reason };
  if (reasons.some(code => code.endsWith('LOGIN_REQUIRED'))) return { ...base, status:'login_required', reason };
  if (reasons.some(code => noTrackReason.test(code))) return { ...base, status:'no_track', reason };
  if ((reasons.length && reasons.every(code => networkReason.test(code))) || proxyFailures.length) return { ...base, status:'network', reason };
  return { ...base, status:'unavailable', reason };
}

export async function checkYouTubeCaptions(db, identity, videoId, { captions = fetchYouTubeCaptions } = {}) {
  videoId = uuid(videoId);
  const member = await activeMember(db, identity);
  if (!member?.roles.some(role => editorialRoles.includes(role))) throw Error('FORBIDDEN');
  const { rows:[video] } = await db.query('SELECT youtube_id FROM videos WHERE id=$1', [videoId]);
  if (!video) throw Error('NOT_FOUND');
  let found;
  try { found = await captions(video.youtube_id); }
  catch { found = { ok:false, reason:'FETCH_FAILED', via:'unknown', steps:[{ source:'CHECK', reason:'FETCH_FAILED' }], proxyFailures:[] }; }
  const result = { youtubeId:video.youtube_id, ...classifyCaptionsCheck(found) };
  const log = { mode:'check', youtubeId:result.youtubeId, status:result.status, via:result.via,
    proxyStatuses:result.proxyFailures.map(failure => failure.status) };
  if (result.status === 'available') {
    console.info('YOUTUBE_CAPTIONS_USED', { ...log, language:result.language, automatic:result.automatic, segments:result.segments });
  } else {
    console.info('YOUTUBE_CAPTIONS_SKIPPED', { ...log, reason:String(result.reason).slice(0, 200) });
  }
  return result;
}
