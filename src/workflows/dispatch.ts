import { start } from 'workflow/api';
import { database } from '../db/runtime.mjs';
import { dispatchAnalysis } from '../analysis/queue.mjs';
import { cleanVideoProviderFiles } from '../analysis/video-gemini.mjs';
import { sourceAnalysis } from './source-analysis';

export async function dispatchSources() {
  const db=await database();
  const result=await dispatchAnalysis(db,async (id: string, attempt: number)=>{
    const run=await start(sourceAnalysis,[id,attempt]);
    return run.runId;
  });
  await cleanVideoProviderFiles(db);
  return result;
}
