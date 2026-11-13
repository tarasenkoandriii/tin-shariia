import {sleep} from 'workflow';
import {database} from '../db/runtime.mjs';
import {youtubeUploadStep} from '../youtube/upload.mjs';

async function advance(id:string){
  'use step';
  return youtubeUploadStep(await database(),id);
}

export async function uploadYouTubeShort(id:string){
  'use workflow';
  for(let attempt=0;attempt<120;attempt++){
    const result=await advance(id);
    if(result.done)return;
    await sleep('10s');
  }
}
