import { publicationError, publicationIdentity, publicationInput, publicationReply } from '../../../../access/publication-http';
import { confirmAbuseReport, sendAbuseReport } from '../../../../db/abuse-reports.mjs';
import { database } from '../../../../db/runtime.mjs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// {"action":"confirm",…exact values} or {"action":"send","confirmationHash":"…"}. Sending only ever
// happens on this explicit request from an editor.
export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  try {
    const identity = await publicationIdentity(request);
    const input = await publicationInput(request);
    const db = await database(), id = (await params).reportId;
    if (input.action === 'confirm') return publicationReply(await confirmAbuseReport(db, identity, id, input));
    if (input.action === 'send') return publicationReply(await sendAbuseReport(db, identity, id, input));
    throw Error('INVALID_INPUT');
  } catch (error) { return publicationError(error); }
}
