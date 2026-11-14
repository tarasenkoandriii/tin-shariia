import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { registerVideo, importTranscript } from '../src/db/editorial-import.mjs';
import { confirmAbuseReport, loadAbuseReport, loadAbuseReportReasons, saveAbuseReportDraft, sendAbuseReport } from '../src/db/abuse-reports.mjs';
import { loadProjectLog } from '../src/db/project-log.mjs';
import { listAbuseReportReasons, submitAbuseReport, validAbuseReason } from '../src/youtube/abuse-report.mjs';

const FORCE_SSL = 'https://www.googleapis.com/auth/youtube.force-ssl';
const BASE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const TOKEN = 'ya29.secret-access-token';
const reasons = [{ id:'R_MISLEADING', label:'Спам або оманливий вміст', secondary:[{ id:'S_MISINFO', label:'Дезінформація' }] },
  { id:'R_OTHER', label:'Інше', secondary:[] }];
const note = 'Цитата подає вигадану подію як факт і закликає не вірити офіційним даним, що створює ризик шкоди.';

async function migrated() {
  const db = new PGlite();
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const { tag } of journal.entries) await db.exec(await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), 'utf8'));
  const ids = {};
  for (const [identity, roles] of [['editor', ['editor']], ['checker', ['factchecker']], ['publisher', ['publisher']], ['admin', ['admin']]]) {
    const { rows: [{ id }] } = await db.query('INSERT INTO members(clerk_user_id,email) VALUES($1,$2) RETURNING id', [identity, `${identity}@example.test`]);
    await db.query('INSERT INTO member_roles SELECT $1,unnest($2::text[])', [id, roles]);
    ids[identity] = id;
  }
  const { rows: [connection] } = await db.query(`INSERT INTO youtube_connections(owner_id,channel_id,channel_title,refresh_token_encrypted,scopes)
    VALUES($1,'UCour-reporter','Тінь Шарія','v1.encrypted.refresh.token',$2) RETURNING id`, [ids.publisher, [...BASE_SCOPES, FORCE_SSL]]);
  return { db, ids, connectionId: connection.id };
}

let counter = 0;
// An approved fact-check on its own source video, plus an unrelated video of ours to make sure it is never used.
async function factCheck(db, ids, { verdict = 'false', youtubeId, transcriptOf } = {}) {
  counter++;
  const source = await registerVideo(db, `https://youtu.be/${youtubeId ?? `SRC${String(counter).padStart(8, '0')}`}`);
  const decoy = await registerVideo(db, `https://youtu.be/OUR${String(counter).padStart(8, '0')}`);
  const transcript = await importTranscript(db, { videoId: (transcriptOf === 'decoy' ? decoy : source).id, format: 'txt', bytes: Buffer.from('Точна цитата з відео') });
  const { rows: [claim] } = await db.query(`INSERT INTO claims(video_id,created_by,status,version,revision) VALUES($1,$2,'approved',1,3) RETURNING id`, [source.id, ids.checker]);
  await db.query('INSERT INTO claim_versions(claim_id,version,author_id,transcript_id,content) VALUES($1,1,$2,$3,$4)', [claim.id, ids.checker, transcript.id,
    { quote:'Точна цитата з відео', question:'Чи правда?', verdict, explanation:'Джерела спростовують твердження.', startMs:36000, endMs:48000, translation:'', context:'' }]);
  const { rows: [src] } = await db.query(`INSERT INTO sources(url,title,organization,publication_date,accessed_on)
    VALUES($1,'Звіт','Видання','2026-11-01','2026-11-14') RETURNING id`, [`https://example.test/report-${counter}`]);
  await db.query('INSERT INTO claim_evidence(claim_id,claim_version,position,source_id,snapshot) VALUES($1,1,0,$2,$3)', [claim.id, src.id,
    { title:'Звіт', url:`https://example.test/report-${counter}`, organization:'Видання', publicationDate:'2026-11-01', accessedOn:'2026-11-14', locator:'с. 2', coverage:'Спростування' }]);
  return { claimId: claim.id, source, decoy };
}

function deps(over = {}) {
  const calls = { submit: [], reasons: 0 };
  return { calls, deps: {
    accessToken: async () => TOKEN,
    listReasons: async () => { calls.reasons++; return over.reasons ?? reasons; },
    sourceVideo: async () => ({ channelId: 'UCsource-channel', channelTitle: 'Канал джерела', available: true }),
    submit: async (token, report, options) => {
      calls.submit.push({ token, report });
      return over.submit ? over.submit(token, report, options) : { outcome: 'accepted', httpStatus: 204, code: null };
    },
    ...over.deps,
  } };
}

async function ready(db, ids, claimId, d, extra = {}) {
  const draft = await saveAbuseReportDraft(db, 'checker', claimId, { policyBasis:'misattributed', policyNote:note, reasonId:'R_MISLEADING', secondaryReasonId:'S_MISINFO', ...extra }, d);
  return draft.report;
}
const confirmInput = (report, sourceYoutubeId, over = {}) => ({ confirmed: true, revision: report.revision, sourceYoutubeId, claimVersion: report.claimVersion,
  reasonId: report.reasonId, secondaryReasonId: report.secondaryReasonId, comments: report.comments, ...over });

test('abuse reports: source video, confirmation, changes, categories, scope, 204, parallel requests and timeouts', async () => {
  const { db, ids } = await migrated();
  try {
    // Correct source: the analysed video, never our own Short; card shows link, channel, timecode, quote, sources and account.
    {
      const { claimId, source, decoy } = await factCheck(db, ids);
      const { deps: d, calls } = deps();
      const before = await loadAbuseReport(db, 'checker', claimId);
      assert.equal(before.report, null);
      assert.equal(before.source.youtubeId, source.youtubeId);
      assert.equal(before.source.url, `https://www.youtube.com/watch?v=${source.youtubeId}&t=36s`);
      assert.equal(before.source.timecode, '00:36–00:48');
      assert.equal(before.account.channelTitle, 'Тінь Шарія');
      assert.ok(before.missing.some(item => item.code === 'POLICY_BASIS_MISSING'), 'a verdict alone is not a ground for a report');
      assert.match(before.proposedComments, /Цитата: «Точна цитата з відео»/);
      assert.match(before.proposedComments, /https:\/\/example\.test\/report-/);
      const report = await ready(db, ids, claimId, d);
      const loaded = await loadAbuseReport(db, 'editor', claimId);
      assert.deepEqual(loaded.missing, []);
      assert.equal(loaded.report.sourceChannelTitle, 'Канал джерела');
      await confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId), d);
      const { report: confirmed } = await loadAbuseReport(db, 'editor', claimId);
      const sent = await sendAbuseReport(db, 'editor', report.id, { confirmationHash: confirmed.confirmationHash }, d);
      assert.equal(sent.state, 'accepted');
      assert.equal(calls.submit.length, 1);
      assert.equal(calls.submit[0].report.videoId, source.youtubeId);
      assert.notEqual(calls.submit[0].report.videoId, decoy.youtubeId);
      assert.equal(calls.submit[0].report.reasonId, 'R_MISLEADING');
      assert.equal(calls.submit[0].report.secondaryReasonId, 'S_MISINFO');
      // A quote taken from another video's transcript is flagged, not reported.
      const mixed = await factCheck(db, ids, { transcriptOf: 'decoy' });
      assert.ok((await loadAbuseReport(db, 'editor', mixed.claimId)).missing.some(item => item.code === 'SOURCE_MISMATCH'));
      // A confirmed verdict cannot start a report at all.
      const fine = await factCheck(db, ids, { verdict: 'confirmed' });
      await assert.rejects(saveAbuseReportDraft(db, 'checker', fine.claimId, { policyBasis:'other', policyNote:note }, d), /ABUSE_REPORT_NOT_ELIGIBLE/);
    }

    // No confirmation: nothing is sent; roles are enforced.
    {
      const { claimId, source } = await factCheck(db, ids);
      const { deps: d, calls } = deps();
      const report = await ready(db, ids, claimId, d);
      await assert.rejects(sendAbuseReport(db, 'editor', report.id, { confirmationHash: 'a'.repeat(64) }, d), /ABUSE_REPORT_CONFIRMATION_REQUIRED/);
      await assert.rejects(confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId, { confirmed: false }), d), /ABUSE_REPORT_CONFIRMATION_REQUIRED/);
      await assert.rejects(confirmAbuseReport(db, 'checker', report.id, confirmInput(report, source.youtubeId), d), /FORBIDDEN/);
      await assert.rejects(loadAbuseReport(db, 'publisher', claimId), /FORBIDDEN/);
      await assert.rejects(loadAbuseReport(db, null, claimId), /AUTH_REQUIRED/);
      assert.equal(calls.submit.length, 0);
    }

    // Approved data changed: a different text, an edit after confirming, a new fact-check version.
    {
      const { claimId, source } = await factCheck(db, ids);
      const { deps: d, calls } = deps();
      let report = await ready(db, ids, claimId, d);
      await assert.rejects(confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId, { comments: report.comments + ' інше' }), d), /ABUSE_REPORT_CHANGED/);
      await assert.rejects(confirmAbuseReport(db, 'editor', report.id, confirmInput(report, 'XXXXXXXXXXX'), d), /ABUSE_REPORT_CHANGED/);
      const first = await confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId), d);
      report = await ready(db, ids, claimId, d, { comments: 'Новий текст скарги з таймкодом 00:36–00:48 і цитатою.', expectedRevision: first.revision });
      assert.equal(report.state, 'draft', 'editing drops the confirmation');
      await assert.rejects(sendAbuseReport(db, 'editor', report.id, { confirmationHash: first.confirmationHash }, d), /ABUSE_REPORT_CONFIRMATION_REQUIRED/);
      const second = await confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId), d);
      assert.notEqual(second.confirmationHash, first.confirmationHash);
      // The fact-check gets a new version after the confirmation.
      await db.query(`INSERT INTO claim_versions(claim_id,version,author_id,content) SELECT claim_id,2,author_id,content FROM claim_versions WHERE claim_id=$1 AND version=1`, [claimId]);
      await db.query('UPDATE claims SET version=2 WHERE id=$1', [claimId]);
      await assert.rejects(sendAbuseReport(db, 'editor', report.id, { confirmationHash: second.confirmationHash }, d), /ABUSE_REPORT_CONFIRMATION_STALE/);
      assert.equal((await loadAbuseReport(db, 'editor', claimId)).report.state, 'draft');
      assert.ok((await loadAbuseReport(db, 'editor', claimId)).missing.some(item => item.code === 'CLAIM_VERSION_STALE'));
      assert.equal(calls.submit.length, 0);
    }

    // Invalid category: refused at confirmation, when YouTube's list changes before sending, and by YouTube itself.
    {
      const { claimId, source } = await factCheck(db, ids);
      const { deps: d } = deps();
      const bad = await ready(db, ids, claimId, d, { reasonId: 'R_GONE', secondaryReasonId: null });
      await assert.rejects(confirmAbuseReport(db, 'editor', bad.id, confirmInput(bad, source.youtubeId), d), /ABUSE_REASON_INVALID/);
      const wrongPair = await ready(db, ids, claimId, d, { reasonId: 'R_OTHER', secondaryReasonId: 'S_MISINFO', expectedRevision: bad.revision });
      await assert.rejects(confirmAbuseReport(db, 'editor', wrongPair.id, confirmInput(wrongPair, source.youtubeId), d), /ABUSE_REASON_INVALID/);
      const good = await ready(db, ids, claimId, d, { expectedRevision: wrongPair.revision });
      const confirmed = await confirmAbuseReport(db, 'editor', good.id, confirmInput(good, source.youtubeId), d);
      const changedList = deps({ reasons: [{ id: 'R_OTHER', label: 'Інше', secondary: [] }] });
      await assert.rejects(sendAbuseReport(db, 'editor', good.id, { confirmationHash: confirmed.confirmationHash }, changedList.deps), /ABUSE_REASON_INVALID/);
      assert.equal(changedList.calls.submit.length, 0);
      // YouTube rejects the category: explicit refusal, clear reason, a new confirmation is allowed.
      const again = await loadAbuseReport(db, 'editor', claimId);
      const reconfirmed = await confirmAbuseReport(db, 'editor', good.id, confirmInput(again.report, source.youtubeId), d);
      const youtube = deps({ submit: (token, report) => submitAbuseReport(token, report, { fetchImpl: async () =>
        Response.json({ error: { code: 400, errors: [{ reason: 'invalidAbuseReason' }] } }, { status: 400 }) }) });
      const refused = await sendAbuseReport(db, 'editor', good.id, { confirmationHash: reconfirmed.confirmationHash }, youtube.deps);
      assert.deepEqual([refused.state, refused.httpStatus, refused.code], ['rejected', 400, 'YOUTUBE_ABUSE_INVALID_REASON']);
      const after = await loadAbuseReport(db, 'editor', claimId);
      assert.equal(after.report.state, 'rejected');
      await confirmAbuseReport(db, 'editor', good.id, confirmInput(after.report, source.youtubeId), d);
    }

    // Missing OAuth permission: shown before confirming, refused before any request, and mapped from YouTube's 403.
    {
      const { claimId, source } = await factCheck(db, ids);
      const { deps: d, calls } = deps();
      const report = await ready(db, ids, claimId, d);
      const confirmed = await confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId), d);
      await db.query('UPDATE youtube_connections SET scopes=$1 WHERE disconnected_at IS NULL', [BASE_SCOPES]);
      assert.ok((await loadAbuseReport(db, 'editor', claimId)).missing.some(item => item.code === 'SCOPE_MISSING'));
      await assert.rejects(sendAbuseReport(db, 'editor', report.id, { confirmationHash: confirmed.confirmationHash }, d), /YOUTUBE_ABUSE_SCOPE_REQUIRED/);
      assert.equal(calls.submit.length, 0);
      await db.query('UPDATE youtube_connections SET scopes=$1 WHERE disconnected_at IS NULL', [[...BASE_SCOPES, FORCE_SSL]]);
      const forbidden = deps({ submit: (token, r) => submitAbuseReport(token, r, { fetchImpl: async () =>
        Response.json({ error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }, { status: 403 }) }) });
      const result = await sendAbuseReport(db, 'editor', report.id, { confirmationHash: confirmed.confirmationHash }, forbidden.deps);
      assert.deepEqual([result.state, result.code], ['rejected', 'YOUTUBE_ABUSE_SCOPE_REQUIRED']);
    }

    // HTTP 204, then a parallel double click and a second draft for the same video from the same account.
    {
      const { claimId, source } = await factCheck(db, ids);
      let requests = 0;
      const real = deps({ submit: (token, report) => submitAbuseReport(token, report, { fetchImpl: async (url, init) => {
        requests++;
        assert.equal(String(url), 'https://www.googleapis.com/youtube/v3/videos/reportAbuse');
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        const body = JSON.parse(init.body);
        assert.equal(body.videoId, source.youtubeId);
        assert.equal(body.language, 'uk');
        await new Promise(resolve => setTimeout(resolve, 20));
        return new Response(null, { status: 204 });
      } }) });
      const report = await ready(db, ids, claimId, real.deps);
      const confirmed = await confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId), real.deps);
      const results = await Promise.allSettled([1, 2].map(() => sendAbuseReport(db, 'editor', report.id, { confirmationHash: confirmed.confirmationHash }, real.deps)));
      assert.equal(requests, 1);
      assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.state === 'accepted').length, 1);
      assert.match(results.find(r => r.status === 'rejected').reason.message, /ABUSE_REPORT_(IN_PROGRESS|ALREADY_SENT)/);
      const view = await loadAbuseReport(db, 'editor', claimId);
      assert.deepEqual([view.report.state, view.report.httpStatus], ['accepted', 204]);
      await assert.rejects(sendAbuseReport(db, 'editor', report.id, { confirmationHash: confirmed.confirmationHash }, real.deps), /ABUSE_REPORT_ALREADY_SENT/);
      // Another fact-check on the same source video cannot produce a second report from this account.
      const { rows: [other] } = await db.query(`INSERT INTO claims(video_id,created_by,status,version,revision) VALUES($1,$2,'approved',1,3) RETURNING id`, [source.id, ids.checker]);
      await db.query(`INSERT INTO claim_versions(claim_id,version,author_id,transcript_id,content) SELECT $1,1,author_id,transcript_id,content
        FROM claim_versions WHERE claim_id=$2 AND version=1`, [other.id, claimId]);
      await db.query(`INSERT INTO claim_evidence(claim_id,claim_version,position,source_id,snapshot) SELECT $1,1,position,source_id,snapshot
        FROM claim_evidence WHERE claim_id=$2`, [other.id, claimId]);
      const second = await ready(db, ids, other.id, real.deps);
      const secondConfirmed = await confirmAbuseReport(db, 'editor', second.id, confirmInput(second, source.youtubeId), real.deps);
      await assert.rejects(sendAbuseReport(db, 'editor', second.id, { confirmationHash: secondConfirmed.confirmationHash }, real.deps), /ABUSE_REPORT_ALREADY_SENT/);
      assert.equal(requests, 1);
    }

    // Timeout after the request left: unknown outcome, manual check, no automatic retry.
    {
      const { claimId, source } = await factCheck(db, ids);
      const timeout = deps({ submit: (token, report) => submitAbuseReport(token, report, { timeoutMs: 5, fetchImpl: (url, init) =>
        new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) }) });
      const report = await ready(db, ids, claimId, timeout.deps);
      const confirmed = await confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId), timeout.deps);
      const result = await sendAbuseReport(db, 'editor', report.id, { confirmationHash: confirmed.confirmationHash }, timeout.deps);
      assert.deepEqual([result.state, result.httpStatus, result.code], ['unknown', null, 'YOUTUBE_ABUSE_OUTCOME_UNKNOWN']);
      await assert.rejects(sendAbuseReport(db, 'editor', report.id, { confirmationHash: confirmed.confirmationHash }, timeout.deps), /ABUSE_REPORT_MANUAL_CHECK/);
      await assert.rejects(confirmAbuseReport(db, 'editor', report.id, confirmInput(report, source.youtubeId), timeout.deps), /ABUSE_REPORT_LOCKED/);
      assert.equal(timeout.calls.submit.length, 1);
    }

    // Journal: source video ID, fact-check version, category, approver, send time, status, safe code. No tokens.
    {
      const log = await loadProjectLog(db, 'admin', { process: 'reports' });
      const accepted = log.items.find(item => item.state === 'report_accepted' && item.kind === 'snapshot');
      assert.ok(accepted);
      assert.equal(accepted.message, 'Скаргу прийнято YouTube');
      assert.match(accepted.details.sourceYoutubeId, /^SRC/);
      assert.equal(accepted.details.claimVersion, 1);
      assert.equal(accepted.details.reasonId, 'R_MISLEADING');
      assert.equal(accepted.details.approvedBy, 'editor@example.test');
      assert.equal(accepted.details.httpStatus, 204);
      assert.ok(accepted.details.sentAt);
      const unknown = log.items.find(item => item.state === 'report_unknown' && item.kind === 'snapshot');
      assert.deepEqual([unknown.message, unknown.level, unknown.error_code], ['Потрібна ручна перевірка', 'warning', 'YOUTUBE_ABUSE_OUTCOME_UNKNOWN']);
      const everything = JSON.stringify(await loadProjectLog(db, 'admin')) + JSON.stringify((await db.query('SELECT * FROM youtube_abuse_report_events')).rows)
        + JSON.stringify((await db.query('SELECT * FROM youtube_abuse_reports')).rows);
      assert.ok(!everything.includes(TOKEN) && !everything.includes('encrypted.refresh'), 'no OAuth tokens in reports or journal');
      // Existing comment and link journal entries still load alongside reports.
      assert.ok((await loadProjectLog(db, 'admin', { process: 'comments' })).items);
    }
  } finally { await db.close(); }
});

test('YouTube API helpers: categories list, category validation and response classification', async () => {
  const list = await listAbuseReportReasons(TOKEN, { fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/youtube/v3/videoAbuseReportReasons');
    assert.equal(url.searchParams.get('part'), 'snippet');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    return Response.json({ items: [{ id: 'V', snippet: { label: 'Насильство', secondaryReasons: [{ id: 'V1', label: 'Підкатегорія' }, { id: 'bad id!' }] } }, { snippet: {} }] });
  } });
  assert.deepEqual(list, [{ id: 'V', label: 'Насильство', secondary: [{ id: 'V1', label: 'Підкатегорія' }] }]);
  assert.deepEqual(validAbuseReason(list, 'V', 'V1'), { label: 'Насильство — Підкатегорія' });
  assert.equal(validAbuseReason(list, 'V', 'X'), null);
  assert.equal(validAbuseReason(list, 'X', null), null);
  await assert.rejects(listAbuseReportReasons(TOKEN, { fetchImpl: async () => new Response('{}', { status: 401 }) }), /YOUTUBE_ABUSE_AUTH_FAILED/);
  const report = { videoId: 'SRCvideo001', reasonId: 'V', comments: 'Текст', language: 'uk' };
  const outcome = async (status, reason) => submitAbuseReport(TOKEN, report, { fetchImpl: async () => status === 204 ? new Response(null, { status })
    : Response.json({ error: { errors: reason ? [{ reason }] : [] } }, { status }) });
  assert.deepEqual(await outcome(204), { outcome: 'accepted', httpStatus: 204, code: null });
  assert.equal((await outcome(400, 'rateLimitExceeded')).code, 'YOUTUBE_ABUSE_RATE_LIMIT');
  assert.equal((await outcome(404, 'videoNotFound')).code, 'YOUTUBE_ABUSE_VIDEO_NOT_FOUND');
  assert.equal((await outcome(403, 'forbidden')).code, 'YOUTUBE_ABUSE_FORBIDDEN');
  assert.deepEqual(await outcome(503), { outcome: 'unknown', httpStatus: 503, code: 'YOUTUBE_ABUSE_OUTCOME_UNKNOWN' });
  assert.deepEqual(await outcome(200), { outcome: 'unknown', httpStatus: 200, code: 'YOUTUBE_ABUSE_RESPONSE_UNEXPECTED' });
  assert.deepEqual(await submitAbuseReport(TOKEN, report, { fetchImpl: async () => { throw new TypeError('network'); } }),
    { outcome: 'unknown', httpStatus: null, code: 'YOUTUBE_ABUSE_OUTCOME_UNKNOWN' });
});

test('categories are loaded with the connected account and need a connection', async () => {
  const { db } = await migrated();
  try {
    assert.deepEqual(await loadAbuseReportReasons(db, 'editor', deps().deps), reasons);
    await db.query('UPDATE youtube_connections SET disconnected_at=now(),refresh_token_encrypted=NULL');
    await assert.rejects(loadAbuseReportReasons(db, 'editor', deps().deps), /YOUTUBE_CHANNEL_NOT_CONNECTED/);
  } finally { await db.close(); }
});
