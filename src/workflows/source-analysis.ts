import { sleep } from 'workflow';
import { database } from '../db/runtime.mjs';
import { geminiProvider } from '../analysis/gemini.mjs';
import { videoGeminiProvider } from '../analysis/video-gemini.mjs';
import { youtubeGeminiProvider } from '../analysis/youtube-full.mjs';
import { processAnalysisStep } from '../analysis/queue.mjs';

async function processChunk(id: string, attempt: number): Promise<{done?: boolean; delay?: number}> {
  'use step';
  const db=await database();
  const transcript=geminiProvider();
  const video=videoGeminiProvider(db);
  const youtube=youtubeGeminiProvider();
  return processAnalysisStep(db,id,attempt,(model:string,input:unknown,context:{mode:string;state:unknown})=>
    context.mode==='video'?video(model,input,context.state)
      :context.mode==='youtube'?youtube(model,input as Parameters<typeof youtube>[1]):transcript(model,input));
}

export async function sourceAnalysis(id: string, attempt: number) {
  'use workflow';
  // A job contains at most 24 chunks (YouTube windows) with up to two automatic transient retries each.
  for(let step=0;step<140;step++){
    const result=await processChunk(id,attempt);
    if(result.done) return;
    if(result.delay) await sleep(`${result.delay}s`);
  }
}
