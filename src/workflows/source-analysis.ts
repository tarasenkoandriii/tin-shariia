import { sleep } from 'workflow';
import { database } from '../db/runtime.mjs';
import { geminiProvider } from '../analysis/gemini.mjs';
import { processAnalysisStep } from '../analysis/queue.mjs';

async function processChunk(id: string, attempt: number): Promise<{done?: boolean; delay?: number}> {
  'use step';
  return processAnalysisStep(await database(),id,attempt,geminiProvider());
}

export async function sourceAnalysis(id: string, attempt: number) {
  'use workflow';
  // A job contains at most 12 chunks with up to two automatic transient retries each.
  for(let step=0;step<80;step++){
    const result=await processChunk(id,attempt);
    if(result.done) return;
    if(result.delay) await sleep(`${result.delay}s`);
  }
}
