import { publicationError, publicationIdentity, publicationInput, publicationReply } from '../../../../../access/publication-http';
import { loadAbuseReport, saveAbuseReportDraft } from '../../../../../db/abuse-reports.mjs';
import { database } from '../../../../../db/runtime.mjs';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ claimId: string }> };

// Draft of a YouTube abuse report for an approved fact-check, with what is still missing.
export async function GET(_request: Request, { params }: Params) {
  try {
    const identity = await publicationIdentity();
    return publicationReply(await loadAbuseReport(await database(), identity, (await params).claimId));
  } catch (error) { return publicationError(error); }
}

// Saves the editor's rule, explanation, category and text. Drops any earlier confirmation.
export async function PUT(request: Request, { params }: Params) {
  try {
    const identity = await publicationIdentity(request);
    const input = await publicationInput(request);
    return publicationReply(await saveAbuseReportDraft(await database(), identity, (await params).claimId, input));
  } catch (error) { return publicationError(error); }
}
