import { youtubeErrorDetails } from '../../../../analysis/youtube-error-details';
import { activeMember } from '../../../../access/membership.mjs';
import { publicationError, publicationIdentity, publicationInput, publicationReply } from '../../../../access/publication-http';
import { analysisConfig } from '../../../../analysis/config.mjs';
import { monthlyAnalysisBudget } from '../../../../analysis/monthly-budget.mjs';
import { suggestYouTubeShort, youtubeOutputLimit, youtubeProposalInput } from '../../../../analysis/shorts-proposal.mjs';
import { database } from '../../../../db/runtime.mjs';
import { settleShortsProposal } from '../../../../db/shorts.mjs';
import { uuid } from '../../../../editorial/workflow-input.mjs';

export const maxDuration = 90;

export async function POST(request: Request) {
  try {
    const identity = await publicationIdentity(request);
    const input = await publicationInput(request);
    const source = youtubeProposalInput(input);
    const requestId = uuid(input.requestId);
    const db = await database();
    const config = analysisConfig();
    const reservation = await db.transaction(async (tx: { query: typeof db.query }) => {
      await tx.query('SELECT pg_advisory_xact_lock(72036593)');
      const member = await activeMember(tx, identity);
      if (!member || !member.roles.some((role: string) => role === 'author' || role === 'publisher')) throw Error('FORBIDDEN');
      const { rows: [existing] } = await tx.query(
        'SELECT id,requested_by,youtube_video_id,youtube_start_seconds,state,plan FROM shorts_plan_calls WHERE request_key=$1', [requestId],
      );
      if (existing) {
        if (existing.requested_by !== member.id || existing.youtube_video_id !== source.videoId
          || existing.youtube_start_seconds !== source.start) throw Error('INVALID_INPUT');
        if (existing.state === 'succeeded') return { id: existing.id, cached: true, result: existing.plan };
        throw Error(existing.state === 'running' ? 'SHORTS_PROPOSAL_PENDING' : 'SHORTS_PROPOSAL_UNKNOWN');
      }
      // Reserve for a bounded 90-second video window and model output, including reasoning.
      const reserve = 65_536 * config.inputRate + 2 * youtubeOutputLimit * config.outputRate;
      const budget = await monthlyAnalysisBudget(tx);
      if (Number(budget.used) + reserve > config.monthlyMicros) throw Error('BUDGET_EXHAUSTED');
      const { rows: [call] } = await tx.query(
        `INSERT INTO shorts_plan_calls
         (youtube_video_id,youtube_start_seconds,requested_by,request_key,month,model,reserved_micros,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,'running') RETURNING id`,
        [source.videoId,source.start,member.id,requestId,budget.month,config.model,reserve],
      );
      return { id: call.id, cached: false };
    });
    if (reservation.cached) return publicationReply(reservation.result);
    try {
      const result = await suggestYouTubeShort(source, config);
      await settleShortsProposal(db,reservation.id,{state:'succeeded',spent:result.spentMicros,plan:result});
      return publicationReply(result);
    } catch (error) {
      const spent = (error as {spentMicros?:number})?.spentMicros;
      await settleShortsProposal(db,reservation.id,spent === undefined
        ? {state:'unknown'} : {state:'failed',spent});
      if (spent === undefined) {
        const status = (error as { status?: unknown })?.status;
        const name = error instanceof Error ? error.name : '';
        const code = status === 400 ? 'YOUTUBE_ANALYSIS_REQUEST_REJECTED'
          : status === 401 || status === 403 ? 'YOUTUBE_ANALYSIS_ACCESS_DENIED'
          : status === 404 ? 'YOUTUBE_ANALYSIS_RESOURCE_UNAVAILABLE'
          : status === 429 ? 'YOUTUBE_ANALYSIS_QUOTA'
          : name === 'TimeoutError' || name === 'AbortError' ? 'YOUTUBE_ANALYSIS_TIMEOUT'
          : 'SHORTS_PROPOSAL_UNKNOWN';
        console.warn('YOUTUBE_SHORT_PROPOSAL_FAILED', { code, providerStatus: typeof status === 'number' ? status : null,
          ...youtubeErrorDetails(error) });
        throw Error(code);
      }
      throw error;
    }
  } catch (error) { return publicationError(error); }
}
