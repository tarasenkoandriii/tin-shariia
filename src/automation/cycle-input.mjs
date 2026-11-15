import {z} from 'zod';
const text=(n)=>z.string().trim().min(1).max(n);
const scene=z.object({label:text(120),title:text(100),lines:z.array(text(100)).max(4),tags:z.array(text(40)).min(1).max(5),assetCount:z.number().int().min(1).max(4).optional(),weight:z.number().positive().max(30),verdict:z.boolean().optional()}).strict();
export const cycleSeedSchema=z.object({
 caseKey:text(100),editorVerified:z.literal(true),videoId:z.string().regex(/^[\w-]{11}$/),srt:text(50000),
 factcheck:z.object({quote:text(1800),context:text(4000),question:text(2000),verdict:z.enum(['false','missing_context','partially_confirmed']),
  explanation:text(6000),startMs:z.number().int().nonnegative(),endMs:z.number().int().positive()}).strict(),
 evidence:z.array(z.object({title:text(500),url:z.string().url().max(2048),organization:text(300),publicationDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  locator:text(1000),excerpt:text(1000),coverage:text(2000)}).strict()).min(2).max(6),
 scenario:z.object({title:text(100),script:text(6000),narrationText:text(650),description:text(2000),pinnedComment:z.string().max(500).optional(),subtitles:z.string().max(16000).optional()}).strict(),
 visualQueries:z.array(z.object({query:text(140),tags:z.array(text(40)).min(1).max(5),kind:z.enum(['photo','map','document'])}).strict()).min(1).max(6),
 manifest:z.object({sourceLabel:text(180),visualEffect:z.enum(['carousel']).optional(),scenes:z.array(scene).min(3).max(8),
  documentCards:z.array(z.object({title:text(100),lines:z.array(text(100)).min(1).max(7),sourceUrl:z.string().url().max(2048),credit:text(180),tags:z.array(text(40)).min(1).max(5)}).strict()).max(6).optional()}).strict(),
}).strict().refine(s=>s.factcheck.endMs>s.factcheck.startMs&&s.factcheck.endMs-s.factcheck.startMs<=30000)
 .refine(s=>s.manifest.scenes.at(-1)?.verdict===true);
