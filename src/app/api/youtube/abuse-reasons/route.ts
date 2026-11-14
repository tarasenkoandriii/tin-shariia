import { publicationError, publicationIdentity, publicationReply } from '../../../../access/publication-http';
import { loadAbuseReportReasons } from '../../../../db/abuse-reports.mjs';
import { database } from '../../../../db/runtime.mjs';

export const dynamic = 'force-dynamic';

// Current categories from videoAbuseReportReasons.list, read with the connected YouTube account.
export async function GET() {
  try {
    return publicationReply(await loadAbuseReportReasons(await database(), await publicationIdentity()));
  } catch (error) { return publicationError(error); }
}
