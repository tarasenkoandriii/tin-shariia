import { activeMember } from '../access/membership.mjs';
import { claimInput, episodeInput, string, uuid } from '../editorial/workflow-input.mjs';

const kinds = {
  claim: { table: 'claims', versions: 'claim_versions', key: 'claim_id', parent: 'video_id', reviewer: 'factchecker' },
  episode: { table: 'episodes', versions: 'episode_versions', key: 'episode_id', parent: 'claim_id', reviewer: 'editor' },
};

async function actor(db, identity) {
  if (!identity) throw new Error('AUTH_REQUIRED');
  const member = await activeMember(db, identity);
  if (!member) throw new Error('FORBIDDEN');
  return member;
}

async function lockClaim(db, id) {
  const { rows: [claim] } = await db.query('SELECT * FROM claims WHERE id = $1 FOR UPDATE', [id]);
  if (!claim) throw new Error('NOT_FOUND');
  if (claim.status !== 'approved') throw new Error('CLAIM_NOT_APPROVED');
  return claim;
}

async function saveClaim(db, item, actorId, input) {
  const { transcriptId, content, evidence } = claimInput(input);
  if (transcriptId) {
    const { rows: [transcript] } = await db.query(
      'SELECT id FROM transcripts WHERE id = $1 AND video_id = $2', [transcriptId, item.video_id],
    );
    if (!transcript) throw new Error('TRANSCRIPT_MISMATCH');
  }
  await db.query(
    'INSERT INTO claim_versions (claim_id,version,author_id,transcript_id,content) VALUES ($1,$2,$3,$4,$5::text::jsonb)',
    [item.id, item.version, actorId, transcriptId, JSON.stringify(content)],
  );
  for (const [position, source] of evidence.entries()) {
    const { rows: [{ id }] } = await db.query(
      `INSERT INTO sources (url,title,organization,publication_date,accessed_on,primary_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (url) DO UPDATE SET title=EXCLUDED.title, organization=EXCLUDED.organization,
       publication_date=EXCLUDED.publication_date, accessed_on=EXCLUDED.accessed_on, primary_url=EXCLUDED.primary_url
       RETURNING id`,
      [source.url, source.title, source.organization, source.publicationDate, source.accessedOn, source.primaryUrl],
    );
    await db.query(
      'INSERT INTO claim_evidence (claim_id,claim_version,position,source_id,snapshot) VALUES ($1,$2,$3,$4,$5::text::jsonb)',
      [item.id, item.version, position, id, JSON.stringify(source)],
    );
  }
}

async function saveEpisode(db, item, actorId, input) {
  const claim = await lockClaim(db, item.claim_id);
  if (input.claimVersion !== claim.version) throw new Error('CLAIM_STALE');
  await db.query(
    'INSERT INTO episode_versions (episode_id,version,author_id,claim_id,claim_version,content) VALUES ($1,$2,$3,$4,$5,$6::text::jsonb)',
    [item.id, item.version, actorId, claim.id, claim.version, JSON.stringify(episodeInput(input))],
  );
}

async function audit(db, config, item, actorId, action, comment) {
  await db.query(
    `INSERT INTO editorial_events (${config.key},version,revision,actor_id,action,comment)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [item.id, item.version, item.revision, actorId, action, comment],
  );
}

const nextStatus = { submit: 'review', approve: 'approved', return: 'draft', withdraw: 'withdrawn' };

export function changeEditorial(db, identity, kind, input) {
  const config = kinds[kind];
  if (!config || !input || typeof input !== 'object') throw new Error('INVALID_INPUT');
  return db.transaction(async tx => {
    const member = await actor(tx, identity);
    const { action } = input;
    const reviewing = action === 'approve' || action === 'return';
    if (!member.roles.includes(reviewing ? config.reviewer : 'author')) throw new Error('FORBIDDEN');
    const comment = string(input.comment, 4000, action === 'return' || action === 'withdraw');
    const save = kind === 'claim' ? saveClaim : saveEpisode;
    let item;
    if (action === 'create') {
      const parentId = uuid(input.parentId);
      if (kind === 'claim') {
        const { rows } = await tx.query('SELECT id FROM videos WHERE id = $1', [parentId]);
        if (!rows.length) throw new Error('NOT_FOUND');
      } else {
        await lockClaim(tx, parentId);
      }
      ({ rows: [item] } = await tx.query(
        `INSERT INTO ${config.table} (${config.parent},created_by) VALUES ($1,$2) RETURNING *`,
        [parentId, member.id],
      ));
      await save(tx, item, member.id, input);
    } else {
      ({ rows: [item] } = await tx.query(
        `SELECT * FROM ${config.table} WHERE id = $1 FOR UPDATE`, [uuid(input.id)],
      ));
      if (!item) throw new Error('NOT_FOUND');
      if (input.expectedRevision !== item.revision || input.version !== item.version) throw new Error('REVISION_CONFLICT');
      if (item.status === 'withdrawn') throw new Error('INVALID_TRANSITION');
      if (action === 'edit') {
        item.version++;
        item.revision++;
        item.status = 'draft';
        await save(tx, item, member.id, input);
      } else {
        const { rows: [version] } = await tx.query(
          `SELECT * FROM ${config.versions} WHERE ${config.key} = $1 AND version = $2`, [item.id, item.version],
        );
        if (reviewing && item.status !== 'review') throw new Error('INVALID_TRANSITION');
        if (reviewing && action === 'approve'
            && (version.author_id === member.id || item.created_by === member.id)) {
          throw new Error('SELF_APPROVAL');
        }
        if (action === 'submit') {
          if (item.status !== 'draft') throw new Error('INVALID_TRANSITION');
          if (kind === 'claim') {
            const { rows } = await tx.query(
              'SELECT 1 FROM claim_evidence WHERE claim_id = $1 AND claim_version = $2 LIMIT 1',
              [item.id, item.version],
            );
            if (!version.content.verdict || !version.content.explanation || !rows.length) throw new Error('REVIEW_INCOMPLETE');
          }
        }
        if (kind === 'episode' && (action === 'submit' || action === 'approve')) {
          const claim = await lockClaim(tx, item.claim_id);
          if (version.claim_version !== claim.version) throw new Error('CLAIM_STALE');
        }
        if (!Object.hasOwn(nextStatus, action) || (action === 'withdraw' && kind !== 'claim')) {
          throw new Error('INVALID_TRANSITION');
        }
        item.status = nextStatus[action];
        item.revision++;
      }
      await tx.query(
        `UPDATE ${config.table} SET status=$2, revision=$3, version=$4 WHERE id=$1`,
        [item.id, item.status, item.revision, item.version],
      );
    }
    await audit(tx, config, item, member.id, action, comment);
    return { id: item.id, status: item.status, version: item.version, revision: item.revision };
  });
}

export async function loadWorkflow(db, identity, videoId) {
  const member = await actor(db, identity);
  if (!videoId) {
    const { rows } = await db.query('SELECT id,youtube_id,created_at FROM videos ORDER BY created_at DESC,id LIMIT 100');
    return { roles: member.roles, videos: rows };
  }
  const { rows: [video] } = await db.query('SELECT id,youtube_id FROM videos WHERE id=$1', [uuid(videoId)]);
  if (!video) throw new Error('NOT_FOUND');
  const { rows: transcripts } = await db.query(
    'SELECT id,version,format FROM transcripts WHERE video_id=$1 ORDER BY version DESC', [video.id],
  );
  const { rows: claims } = await db.query(
    `SELECT c.*, cv.transcript_id, cv.content, previous.content AS previous_content,
       COALESCE((SELECT jsonb_agg(e.snapshot ORDER BY e.position) FROM claim_evidence e
         WHERE e.claim_id=c.id AND e.claim_version=c.version),'[]'::jsonb) AS evidence,
       COALESCE((SELECT jsonb_agg(e.snapshot ORDER BY e.position) FROM claim_evidence e
         WHERE e.claim_id=c.id AND e.claim_version=c.version-1),'[]'::jsonb) AS previous_evidence
     FROM claims c JOIN claim_versions cv ON cv.claim_id=c.id AND cv.version=c.version
     LEFT JOIN claim_versions previous ON previous.claim_id=c.id AND previous.version=c.version-1
     WHERE c.video_id=$1 ORDER BY c.id`, [video.id],
  );
  const { rows: episodes } = await db.query(
    `SELECT e.*, ev.claim_version, ev.content,
       c.status <> 'approved' OR c.version <> ev.claim_version AS stale
     FROM episodes e JOIN episode_versions ev ON ev.episode_id=e.id AND ev.version=e.version
     JOIN claims c ON c.id=e.claim_id WHERE c.video_id=$1 ORDER BY e.id`, [video.id],
  );
  const { rows: events } = await db.query(
    `SELECT event.claim_id,event.episode_id,event.version,event.revision,event.action,event.comment,event.created_at,member.email AS actor
     FROM editorial_events event JOIN members member ON member.id=event.actor_id
     LEFT JOIN episodes e ON e.id=event.episode_id
     JOIN claims c ON c.id=COALESCE(event.claim_id,e.claim_id)
     WHERE c.video_id=$1 ORDER BY event.id DESC LIMIT 100`, [video.id],
  );
  return { roles: member.roles, video, transcripts, claims, episodes, events };
}

export async function loadTranscript(db, identity, videoId, transcriptId) {
  await actor(db, identity);
  const { rows } = await db.query(
    `SELECT s.position,s.start_ms,s.end_ms,s.body FROM transcripts t
     JOIN transcript_segments s ON s.transcript_id=t.id
     WHERE t.video_id=$1 AND t.id=$2 ORDER BY s.position LIMIT 300`, [uuid(videoId), uuid(transcriptId)],
  );
  return rows;
}
