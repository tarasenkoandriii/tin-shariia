import { start } from 'workflow/api';
import { database } from '../db/runtime.mjs';
import { dispatchAnalysis } from '../analysis/queue.mjs';
import { sourceAnalysis } from './source-analysis';

export async function dispatchSources() {
  return dispatchAnalysis(await database(),async (id: string, attempt: number)=>{
    const run=await start(sourceAnalysis,[id,attempt]);
    return run.runId;
  });
}
