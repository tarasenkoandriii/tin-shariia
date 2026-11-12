export type Evidence = {
  title: string; url: string; organization: string; publicationDate: string | null;
  accessedOn: string; primaryUrl: string | null; locator: string; coverage: string;
};
export type ClaimContent = {
  quote: string; translation: string; context: string; question: string; verdict: string;
  explanation: string; startMs: number | null; endMs: number | null;
};
export type EpisodeContent = {
  title: string; script: string; description: string; thumbnail: string; captions: string;
  subtitles: string; pinnedComment: string; fragments: string;
};
export type Transcript = { id: string; version: number; format: string };
export type Claim = {
  id: string; version: number; revision: number; status: string; transcript_id: string | null;
  content: ClaimContent; evidence: Evidence[]; previous_content: ClaimContent | null; previous_evidence: Evidence[];
};
export type Episode = {
  id: string; version: number; revision: number; status: string; claim_id: string; claim_version: number;
  content: EpisodeContent; stale: boolean;
};

export const verdictLabels: Record<string, string> = {
  confirmed: 'Підтверджено', partially_confirmed: 'Частково підтверджено', false: 'Хибно',
  missing_context: 'Бракує контексту', insufficient: 'Недостатньо даних',
};
