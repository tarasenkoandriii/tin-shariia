// YouTube Data API calls for editor-approved abuse reports. Nothing here decides whether a video
// breaks a rule: the editor names the rule and confirms the exact report; YouTube makes the decision.

const API = 'https://www.googleapis.com/youtube/v3';
export const MISINFORMATION_POLICY_URL = 'https://support.google.com/youtube/answer/10834785';
// Either scope lets the connected account call videos.reportAbuse.
export const ABUSE_REPORT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube',
];

// Rules the editor can point to. A verdict like "false" alone is not a policy violation.
export const policyBases = {
  manipulated: {
    label: 'Маніпульований контент',
    hint: 'Технічно змінений або змонтований матеріал, який вводить в оману й створює серйозний ризик шкоди.',
    url: MISINFORMATION_POLICY_URL,
  },
  misattributed: {
    label: 'Неправдиво приписаний контент',
    hint: 'Матеріал видають за такий, що стосується іншої події, часу чи місця, і це створює серйозний ризик шкоди.',
    url: MISINFORMATION_POLICY_URL,
  },
  elections: {
    label: 'Дезінформація про вибори',
    hint: 'Оманливі твердження про процедуру, право голосу чи результати виборів (окреме правило YouTube щодо виборів).',
    url: MISINFORMATION_POLICY_URL,
  },
  medical: {
    label: 'Медична дезінформація',
    hint: 'Твердження, що суперечать позиції органів охорони здоров’я й можуть завдати шкоди (окреме медичне правило YouTube).',
    url: MISINFORMATION_POLICY_URL,
  },
  other: {
    label: 'Інше правило YouTube',
    hint: 'Назвіть конкретне правило YouTube і поясніть, яку його вимогу порушує цитата.',
    url: MISINFORMATION_POLICY_URL,
  },
};

export const hasAbuseReportScope = scopes => Array.isArray(scopes) && ABUSE_REPORT_SCOPES.some(scope => scopes.includes(scope));

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null;
const label = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';

/** Current categories from videoAbuseReportReasons.list, read with the connected account's token. */
export async function listAbuseReportReasons(accessToken, { fetchImpl = fetch, hl = 'uk' } = {}) {
  const url = new URL(`${API}/videoAbuseReportReasons`);
  url.search = new URLSearchParams({ part: 'snippet', hl });
  let response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  } catch { throw Error('YOUTUBE_ABUSE_REASONS_UNAVAILABLE'); }
  const body = await response.json().catch(() => null);
  if (response.status === 401) throw Error('YOUTUBE_ABUSE_AUTH_FAILED');
  if (!response.ok || !Array.isArray(body?.items)) throw Error('YOUTUBE_ABUSE_REASONS_UNAVAILABLE');
  return body.items.map(item => ({
    id: safeId(item?.id), label: label(item?.snippet?.label),
    secondary: (item?.snippet?.secondaryReasons ?? []).map(reason => ({ id: safeId(reason?.id), label: label(reason?.label) }))
      .filter(reason => reason.id),
  })).filter(reason => reason.id);
}

/** The pair must exist in the current list; a secondary reason must belong to its primary one. */
export function validAbuseReason(reasons, reasonId, secondaryReasonId) {
  const primary = reasons.find(reason => reason.id === reasonId);
  if (!primary) return null;
  if (!secondaryReasonId) return { label: primary.label };
  const secondary = primary.secondary.find(reason => reason.id === secondaryReasonId);
  return secondary ? { label: `${primary.label} — ${secondary.label}` } : null;
}

/** Channel of the analysed source video, for the editor to see whose video is reported. */
export async function fetchSourceVideo(youtubeId, { apiKey = process.env.YOUTUBE_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) return null;
  const url = new URL(`${API}/videos`);
  url.search = new URLSearchParams({ part: 'snippet', id: youtubeId });
  try {
    const response = await fetchImpl(url, { headers: { 'x-goog-api-key': apiKey }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const item = (await response.json())?.items?.find?.(video => video.id === youtubeId);
    if (!item) return { channelId: null, channelTitle: '', available: false };
    return { channelId: safeId(item.snippet?.channelId), channelTitle: label(item.snippet?.channelTitle), available: true };
  } catch { return null; }
}

const reasonCode = body => {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.details?.find?.(detail => detail?.reason)?.reason;
  return typeof reason === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(reason) ? reason : null;
};

/**
 * Sends one report. Returns {outcome:'accepted'|'rejected'|'unknown', httpStatus, code}; never throws.
 * Only an HTTP 204 is "accepted". A network failure or timeout after the request left is "unknown".
 */
export async function submitAbuseReport(accessToken, report, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const body = { videoId: report.videoId, reasonId: report.reasonId, comments: report.comments, language: report.language };
  if (report.secondaryReasonId) body.secondaryReasonId = report.secondaryReasonId;
  let response;
  try {
    response = await fetchImpl(`${API}/videos/reportAbuse`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { outcome: 'unknown', httpStatus: null, code: 'YOUTUBE_ABUSE_OUTCOME_UNKNOWN' };
  }
  if (response.status === 204) return { outcome: 'accepted', httpStatus: 204, code: null };
  const reason = reasonCode(await response.json().catch(() => null));
  const status = response.status;
  if (status >= 500 || status === 408) return { outcome: 'unknown', httpStatus: status, code: 'YOUTUBE_ABUSE_OUTCOME_UNKNOWN' };
  if (status >= 200 && status < 300) return { outcome: 'unknown', httpStatus: status, code: 'YOUTUBE_ABUSE_RESPONSE_UNEXPECTED' };
  const code = reason === 'invalidAbuseReason' ? 'YOUTUBE_ABUSE_INVALID_REASON'
    : ['rateLimitExceeded', 'quotaExceeded', 'userRateLimitExceeded'].includes(reason) || status === 429 ? 'YOUTUBE_ABUSE_RATE_LIMIT'
    : reason === 'videoNotFound' || status === 404 ? 'YOUTUBE_ABUSE_VIDEO_NOT_FOUND'
    : ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(reason) ? 'YOUTUBE_ABUSE_SCOPE_REQUIRED'
    : status === 401 ? 'YOUTUBE_ABUSE_AUTH_FAILED'
    : status === 403 ? 'YOUTUBE_ABUSE_FORBIDDEN'
    : 'YOUTUBE_ABUSE_REJECTED';
  return { outcome: 'rejected', httpStatus: status, code };
}
