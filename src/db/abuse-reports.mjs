import { createHash } from 'node:crypto';
import { activeMember } from '../access/membership.mjs';
import { string, uuid } from '../editorial/workflow-input.mjs';
import { fetchSourceVideo, hasAbuseReportScope, listAbuseReportReasons, policyBases, submitAbuseReport, validAbuseReason }
  from '../youtube/abuse-report.mjs';
import { decryptYouTubeSecret, refreshYouTubeAccessToken, youtubeOAuthConfig } from '../youtube/oauth.mjs';

// Abuse report prepared from an approved fact-check. The editor names the YouTube rule, edits the
// text, picks a current category, confirms exactly this video/category/text, and only then sends.

export const eligibleVerdicts = ['false', 'missing_context', 'partially_confirmed'];
const verdictLabels = { false:'Хибно', missing_context:'Бракує контексту', partially_confirmed:'Частково підтверджено',
  confirmed:'Підтверджено', insufficient:'Недостатньо даних' };
const STALE_SENDING_MS = 2 * 60_000;
const json = value => JSON.stringify(value);

const defaultDeps = {
  accessToken: connection => refreshYouTubeAccessToken(decryptYouTubeSecret(connection.refresh_token_encrypted), youtubeOAuthConfig()),
  listReasons: (token, options) => listAbuseReportReasons(token, options),
  sourceVideo: youtubeId => fetchSourceVideo(youtubeId),
  submit: (token, report, options) => submitAbuseReport(token, report, options),
  fetchImpl: undefined,
};
const withDefaults = deps => ({ ...defaultDeps, ...deps });

async function memberWith(db, identity, allowed) {
  if (!identity) throw Error('AUTH_REQUIRED');
  const member = await activeMember(db, identity);
  if (!member?.roles.some(role => allowed.includes(role))) throw Error('FORBIDDEN');
  return member;
}

async function activeConnection(db) {
  const { rows: [row] } = await db.query(`SELECT id,channel_id,channel_title,scopes,refresh_token_encrypted FROM youtube_connections
    WHERE disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1`);
  return row ?? null;
}

// The analysed source: the claim's own video, cross-checked with the transcript the quote came from.
async function materials(db, claimId) {
  const { rows: [row] } = await db.query(`SELECT c.id AS claim_id,c.status,c.version,c.video_id,v.youtube_id,cv.transcript_id,
      cv.content,t.video_id AS transcript_video_id,
      COALESCE((SELECT jsonb_agg(e.snapshot ORDER BY e.position) FROM claim_evidence e
        WHERE e.claim_id=c.id AND e.claim_version=c.version),'[]'::jsonb) AS evidence
    FROM claims c JOIN videos v ON v.id=c.video_id
    JOIN claim_versions cv ON cv.claim_id=c.id AND cv.version=c.version
    LEFT JOIN transcripts t ON t.id=cv.transcript_id WHERE c.id=$1`, [claimId]);
  if (!row) throw Error('NOT_FOUND');
  return row;
}

const timecode = ms => {
  const total = Math.floor(ms / 1000), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};
export const videoLink = (youtubeId, startMs) =>
  `https://www.youtube.com/watch?v=${youtubeId}${Number.isSafeInteger(startMs) ? `&t=${Math.floor(startMs / 1000)}s` : ''}`;

/** Report text built only from saved materials: link, timecode, exact quote, rule, verdict, sources. */
export function draftComments(m, { policyBasis, policyNote }) {
  const c = m.content, basis = policyBases[policyBasis];
  const lines = [
    `Відео: ${videoLink(m.youtube_id, c.startMs)}`,
    Number.isSafeInteger(c.startMs) && Number.isSafeInteger(c.endMs) ? `Таймкод: ${timecode(c.startMs)}–${timecode(c.endMs)}` : null,
    `Цитата: «${c.quote}»`,
    basis ? `Можлива підстава: ${basis.label}${policyNote ? ` — ${policyNote}` : ''}` : null,
    `Результат фактчеку (версія ${m.version}): ${verdictLabels[c.verdict] ?? '—'}. ${c.explanation ?? ''}`.trim(),
    m.evidence.length ? 'Джерела:' : null,
    ...m.evidence.map(e => `- ${e.title}${e.organization ? ` (${e.organization}${e.publicationDate ? `, ${e.publicationDate}` : ''})` : ''}: ${e.url}`),
  ].filter(Boolean);
  return lines.join('\n').slice(0, 3000);
}

/** What still stands between the fact-check and a report the editor may confirm. */
export function missingForReport(m, report, connection) {
  const missing = [];
  const add = (code, message) => missing.push({ code, message });
  const c = m.content ?? {};
  if (m.status !== 'approved') add('CLAIM_NOT_APPROVED', 'Фактчек ще не затверджено.');
  if (report && report.claim_version !== m.version) add('CLAIM_VERSION_STALE', 'Фактчек змінився після підготовки чернетки. Збережіть чернетку ще раз.');
  if (!eligibleVerdicts.includes(c.verdict)) add('VERDICT_NOT_ELIGIBLE', `Висновок «${verdictLabels[c.verdict] ?? 'не вказано'}» не вказує на хибний чи оманливий зміст.`);
  if (!/^[A-Za-z0-9_-]{11}$/.test(m.youtube_id ?? '')) add('SOURCE_MISSING', 'Немає YouTube ID вихідного відео.');
  if (m.transcript_id && m.transcript_video_id !== m.video_id) add('SOURCE_MISMATCH', 'Розшифрування твердження належить іншому відео.');
  if (!c.quote) add('QUOTE_MISSING', 'Немає точної цитати.');
  if (!Number.isSafeInteger(c.startMs) || !Number.isSafeInteger(c.endMs)) add('TIMECODE_MISSING', 'Немає таймкоду цитати.');
  if (!m.evidence.length) add('EVIDENCE_MISSING', 'Немає джерел фактчеку.');
  if (!policyBases[report?.policy_basis]) add('POLICY_BASIS_MISSING',
    'Не вибрано правило YouTube, яке може порушувати ролик. Висновок фактчеку сам по собі не є підставою для скарги.');
  if ((report?.policy_note ?? '').trim().length < 40) add('POLICY_NOTE_MISSING',
    'Не пояснено, яку саме вимогу правила порушує цитата (щонайменше 40 символів).');
  if (!report?.reason_id) add('REASON_MISSING', 'Не вибрано категорію скарги YouTube.');
  if (!(report?.comments ?? '').trim()) add('COMMENTS_MISSING', 'Текст скарги порожній.');
  if (!connection) add('CONNECTION_MISSING', 'Не підключено канал YouTube, від якого піде скарга.');
  else if (!hasAbuseReportScope(connection.scopes)) add('SCOPE_MISSING',
    'Підключений канал не має дозволу youtube.force-ssl. Перепідключіть канал із дозволом на коментарі.');
  return missing;
}

export function confirmationHash(report, connectionId) {
  return createHash('sha256').update(json([report.id, report.source_youtube_id, report.claim_id, report.claim_version,
    report.reason_id ?? '', report.secondary_reason_id ?? '', report.comments, report.language, connectionId ?? ''])).digest('hex');
}

const publicState = report => report.state === 'sending' && report.sent_at
  && Date.now() - new Date(report.sent_at).getTime() > STALE_SENDING_MS ? 'unknown' : report.state;

async function event(db, reportId, actorId, action, details = {}) {
  await db.query('INSERT INTO youtube_abuse_report_events(report_id,actor_id,action,details) VALUES($1,$2,$3,$4::text::jsonb)',
    [reportId, actorId, action, json(details)]);
}

async function reportFor(db, claimId) {
  const { rows: [row] } = await db.query(`SELECT * FROM youtube_abuse_reports WHERE claim_id=$1
    ORDER BY (state IN ('draft','confirmed','rejected')) DESC, updated_at DESC LIMIT 1`, [claimId]);
  return row ?? null;
}

function view(m, report, connection, member) {
  const c = m.content;
  return {
    report: report && {
      id: report.id, state: publicState(report), revision: report.revision, claimVersion: report.claim_version,
      policyBasis: report.policy_basis, policyNote: report.policy_note, comments: report.comments,
      reasonId: report.reason_id, secondaryReasonId: report.secondary_reason_id, reasonLabel: report.reason_label,
      confirmationHash: report.state === 'confirmed' ? report.confirmation_hash : null,
      confirmedAt: report.confirmed_at, sentAt: report.sent_at, completedAt: report.completed_at,
      httpStatus: report.http_status, errorCode: report.error_code,
      sourceChannelTitle: report.source_channel_title, sourceChannelId: report.source_channel_id,
    },
    source: { youtubeId: m.youtube_id, url: videoLink(m.youtube_id, c.startMs),
      timecode: Number.isSafeInteger(c.startMs) && Number.isSafeInteger(c.endMs) ? `${timecode(c.startMs)}–${timecode(c.endMs)}` : null,
      quote: c.quote ?? '', verdict: c.verdict ?? '', verdictLabel: verdictLabels[c.verdict] ?? '', claimVersion: m.version },
    evidence: m.evidence.map(e => ({ title: e.title, url: e.url, organization: e.organization ?? '', publicationDate: e.publicationDate ?? null })),
    account: connection ? { channelId: connection.channel_id, channelTitle: connection.channel_title, hasScope: hasAbuseReportScope(connection.scopes) } : null,
    policyBases,
    proposedComments: draftComments(m, { policyBasis: report?.policy_basis, policyNote: report?.policy_note }),
    missing: missingForReport(m, report ?? { claim_version: m.version }, connection),
    canEdit: member.roles.some(role => ['editor', 'factchecker'].includes(role)),
    canSend: member.roles.includes('editor'),
  };
}

export async function loadAbuseReport(db, identity, claimId) {
  claimId = uuid(claimId);
  const member = await memberWith(db, identity, ['editor', 'factchecker']);
  const [m, report, connection] = [await materials(db, claimId), await reportFor(db, claimId), await activeConnection(db)];
  return view(m, report, connection, member);
}

function draftInput(input) {
  const basis = string(input.policyBasis, 32);
  if (basis && !policyBases[basis]) throw Error('INVALID_INPUT');
  const id = value => { const v = string(value, 64); if (v && !/^[A-Za-z0-9_.-]{1,64}$/.test(v)) throw Error('INVALID_INPUT'); return v || null; };
  return { policyBasis: basis, policyNote: string(input.policyNote, 2000),
    comments: input.comments == null ? null : string(input.comments, 3000),
    reasonId: id(input.reasonId), secondaryReasonId: id(input.secondaryReasonId) };
}

/** Creates or updates the draft. Any change drops a previous confirmation. */
export async function saveAbuseReportDraft(db, identity, claimId, input, deps = {}) {
  claimId = uuid(claimId);
  const { sourceVideo } = withDefaults(deps);
  const values = draftInput(input);
  // Channel lookup happens before the transaction so no row stays locked during a network call.
  const before = await materials(db, claimId);
  const source = /^[A-Za-z0-9_-]{11}$/.test(before.youtube_id ?? '') ? await sourceVideo(before.youtube_id).catch(() => null) : null;
  return db.transaction(async tx => {
    const member = await memberWith(tx, identity, ['editor', 'factchecker']);
    await tx.query('SELECT id FROM claims WHERE id=$1 FOR UPDATE', [claimId]);
    const m = await materials(tx, claimId);
    if (m.status !== 'approved') throw Error('CLAIM_NOT_APPROVED');
    if (!eligibleVerdicts.includes(m.content.verdict)) throw Error('ABUSE_REPORT_NOT_ELIGIBLE');
    if (!/^[A-Za-z0-9_-]{11}$/.test(m.youtube_id ?? '')) throw Error('ABUSE_REPORT_SOURCE_MISSING');
    const { rows: [current] } = await tx.query(`SELECT * FROM youtube_abuse_reports WHERE claim_id=$1
      AND state IN ('draft','confirmed','rejected') FOR UPDATE`, [claimId]);
    if (current && Number.isSafeInteger(input.expectedRevision) && current.revision !== input.expectedRevision) throw Error('REVISION_CONFLICT');
    const comments = values.comments ?? draftComments(m, values);
    const channel = { id: source?.channelId ?? current?.source_channel_id ?? null, title: source?.channelTitle ?? current?.source_channel_title ?? '' };
    let row;
    if (current) {
      ({ rows: [row] } = await tx.query(`UPDATE youtube_abuse_reports SET claim_version=$2,source_youtube_id=$3,policy_basis=$4,
        policy_note=$5,comments=$6,reason_id=$7,secondary_reason_id=$8,reason_label='',source_channel_id=$9,source_channel_title=$10,
        state='draft',confirmation_hash=NULL,confirmed_by=NULL,confirmed_at=NULL,connection_id=NULL,revision=revision+1,updated_at=now()
        WHERE id=$1 RETURNING *`, [current.id, m.version, m.youtube_id, values.policyBasis, values.policyNote, comments,
        values.reasonId, values.secondaryReasonId, channel.id, channel.title]));
    } else {
      ({ rows: [row] } = await tx.query(`INSERT INTO youtube_abuse_reports(claim_id,claim_version,video_id,source_youtube_id,
        policy_basis,policy_note,comments,reason_id,secondary_reason_id,source_channel_id,source_channel_title,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [claimId, m.version, m.video_id, m.youtube_id,
        values.policyBasis, values.policyNote, comments, values.reasonId, values.secondaryReasonId, channel.id, channel.title, member.id]));
    }
    await event(tx, row.id, member.id, current ? 'edited' : 'drafted', { sourceYoutubeId: row.source_youtube_id, claimVersion: row.claim_version });
    return view(m, row, await activeConnection(tx), member);
  });
}

async function reasonsFor(connection, deps) {
  const token = await deps.accessToken(connection).catch(error => { throw Error(tokenCode(error)); });
  return { token, reasons: await deps.listReasons(token, { fetchImpl: deps.fetchImpl }) };
}
const tokenCode = error => error?.message === 'YOUTUBE_TOKEN_REFRESH_REVOKED' ? 'YOUTUBE_TOKEN_REFRESH_REVOKED'
  : ['YOUTUBE_OAUTH_NOT_CONFIGURED', 'YOUTUBE_TOKEN_ENCRYPTION_NOT_CONFIGURED'].includes(error?.message) ? error.message
    : 'YOUTUBE_ABUSE_AUTH_FAILED';

/** Current categories for the editor's picker. */
export async function loadAbuseReportReasons(db, identity, deps = {}) {
  await memberWith(db, identity, ['editor', 'factchecker']);
  const connection = await activeConnection(db);
  if (!connection) throw Error('YOUTUBE_CHANNEL_NOT_CONNECTED');
  return (await reasonsFor(connection, withDefaults(deps))).reasons;
}

/**
 * The editor confirms exactly the video, fact-check version, category and text they see.
 * Every value must equal what is saved, the fact-check must still be the approved version,
 * the category must be in YouTube's current list, and nothing may be missing.
 */
export async function confirmAbuseReport(db, identity, reportId, input, deps = {}) {
  reportId = uuid(reportId);
  deps = withDefaults(deps);
  if (input.confirmed !== true) throw Error('ABUSE_REPORT_CONFIRMATION_REQUIRED');
  const member = await memberWith(db, identity, ['editor']);
  const { rows: [report] } = await db.query('SELECT * FROM youtube_abuse_reports WHERE id=$1', [reportId]);
  if (!report) throw Error('NOT_FOUND');
  if (!['draft', 'confirmed', 'rejected'].includes(report.state)) throw Error('ABUSE_REPORT_LOCKED');
  if (report.revision !== input.revision) throw Error('ABUSE_REPORT_CHANGED');
  if (input.sourceYoutubeId !== report.source_youtube_id || input.claimVersion !== report.claim_version
    || (input.reasonId ?? null) !== report.reason_id || (input.secondaryReasonId || null) !== report.secondary_reason_id
    || input.comments !== report.comments) throw Error('ABUSE_REPORT_CHANGED');
  const m = await materials(db, report.claim_id);
  const connection = await activeConnection(db);
  const missing = missingForReport(m, report, connection);
  if (m.youtube_id !== report.source_youtube_id) throw Error('ABUSE_REPORT_SOURCE_MISMATCH');
  if (missing.length) throw Object.assign(Error('ABUSE_REPORT_INCOMPLETE'), { missing });
  const { reasons } = await reasonsFor(connection, deps);
  const reason = validAbuseReason(reasons, report.reason_id, report.secondary_reason_id);
  if (!reason) throw Error('ABUSE_REASON_INVALID');
  const hash = confirmationHash(report, connection.id);
  return db.transaction(async tx => {
    const { rows: [row] } = await tx.query(`UPDATE youtube_abuse_reports SET state='confirmed',confirmation_hash=$3,reason_label=$4,
      confirmed_by=$5,confirmed_at=now(),connection_id=$6,revision=revision+1,updated_at=now(),error_code=NULL,http_status=NULL
      WHERE id=$1 AND revision=$2 AND state IN ('draft','confirmed','rejected') RETURNING *`,
      [reportId, report.revision, hash, reason.label, member.id, connection.id]);
    if (!row) throw Error('ABUSE_REPORT_CHANGED');
    await event(tx, reportId, member.id, 'confirmed', { sourceYoutubeId: row.source_youtube_id, claimVersion: row.claim_version,
      reasonId: row.reason_id, secondaryReasonId: row.secondary_reason_id, reasonLabel: reason.label });
    return { id: row.id, state: 'confirmed', revision: row.revision, confirmationHash: hash, reasonLabel: reason.label };
  });
}

async function resetConfirmation(db, report, code) {
  await db.query(`UPDATE youtube_abuse_reports SET state='draft',confirmation_hash=NULL,confirmed_by=NULL,confirmed_at=NULL,
    connection_id=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND state='confirmed'`, [report.id]);
  throw Error(code);
}

/**
 * Sends a confirmed report once. The attempt is reserved atomically: a double click, a parallel
 * request or a second draft for the same video cannot produce a second report from the same account.
 */
export async function sendAbuseReport(db, identity, reportId, input, deps = {}) {
  reportId = uuid(reportId);
  deps = withDefaults(deps);
  const member = await memberWith(db, identity, ['editor']);
  const { rows: [report] } = await db.query('SELECT * FROM youtube_abuse_reports WHERE id=$1', [reportId]);
  if (!report) throw Error('NOT_FOUND');
  if (report.state === 'sending') throw Error(publicState(report) === 'unknown' ? 'ABUSE_REPORT_MANUAL_CHECK' : 'ABUSE_REPORT_IN_PROGRESS');
  if (report.state === 'unknown') throw Error('ABUSE_REPORT_MANUAL_CHECK');
  if (report.state === 'accepted') throw Error('ABUSE_REPORT_ALREADY_SENT');
  if (report.state !== 'confirmed') throw Error('ABUSE_REPORT_CONFIRMATION_REQUIRED');
  if (typeof input.confirmationHash !== 'string' || input.confirmationHash !== report.confirmation_hash) throw Error('ABUSE_REPORT_CONFIRMATION_STALE');
  const connection = await activeConnection(db);
  const m = await materials(db, report.claim_id);
  if (!connection) throw Error('YOUTUBE_CHANNEL_NOT_CONNECTED');
  if (!hasAbuseReportScope(connection.scopes)) throw Error('YOUTUBE_ABUSE_SCOPE_REQUIRED');
  // Anything that changed since the confirmation needs a new one.
  if (connection.id !== report.connection_id || confirmationHash(report, connection.id) !== report.confirmation_hash
    || m.status !== 'approved' || m.version !== report.claim_version || m.youtube_id !== report.source_youtube_id)
    await resetConfirmation(db, report, 'ABUSE_REPORT_CONFIRMATION_STALE');
  const { token, reasons } = await reasonsFor(connection, deps);
  if (!validAbuseReason(reasons, report.reason_id, report.secondary_reason_id)) await resetConfirmation(db, report, 'ABUSE_REASON_INVALID');

  let reserved;
  try {
    reserved = await db.transaction(async tx => {
      const { rows: [row] } = await tx.query(`UPDATE youtube_abuse_reports SET state='sending',reporter_channel_id=$3,sent_by=$4,
        sent_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 AND state='confirmed' AND confirmation_hash=$2 RETURNING *`,
        [reportId, report.confirmation_hash, connection.channel_id, member.id]);
      if (!row) return null;
      await event(tx, reportId, member.id, 'sending', { sourceYoutubeId: row.source_youtube_id, claimVersion: row.claim_version,
        reasonId: row.reason_id, secondaryReasonId: row.secondary_reason_id, reporterChannelId: connection.channel_id });
      return row;
    });
  } catch (error) {
    if (error?.code === '23505') throw Error('ABUSE_REPORT_ALREADY_SENT');
    throw error;
  }
  if (!reserved) throw Error('ABUSE_REPORT_IN_PROGRESS');

  const result = await deps.submit(token, { videoId: reserved.source_youtube_id, reasonId: reserved.reason_id,
    secondaryReasonId: reserved.secondary_reason_id, comments: reserved.comments, language: reserved.language }, { fetchImpl: deps.fetchImpl });
  const state = result.outcome === 'accepted' ? 'accepted' : result.outcome === 'rejected' ? 'rejected' : 'unknown';
  await db.transaction(async tx => {
    await tx.query(`UPDATE youtube_abuse_reports SET state=$2,http_status=$3,error_code=$4,completed_at=now(),updated_at=now(),
      revision=revision+1 WHERE id=$1 AND state='sending'`, [reportId, state, result.httpStatus, result.code]);
    await event(tx, reportId, member.id, state, { sourceYoutubeId: reserved.source_youtube_id, claimVersion: reserved.claim_version,
      reasonId: reserved.reason_id, secondaryReasonId: reserved.secondary_reason_id, httpStatus: result.httpStatus, code: result.code });
  });
  console.info('YOUTUBE_ABUSE_REPORT', { reportId, sourceYoutubeId: reserved.source_youtube_id, claimVersion: reserved.claim_version,
    reasonId: reserved.reason_id, state, httpStatus: result.httpStatus, code: result.code });
  return { id: reportId, state, httpStatus: result.httpStatus, code: result.code };
}
