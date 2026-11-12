import { GoogleGenAI } from '@google/genai';
import { montageUrl } from '../media/montage-storage.mjs';
import { validateVideoAudit, videoOutputLimit, videoPrompt, videoResponseFormat } from './video-input.mjs';

const inlineLimit=10_000_000;
const providerDeadline=15*60*1000;
const requestOptions={maxRetries:0,timeout:25000};
const statesWaiting=new Set(['in_progress','queued','pending','running']);

function usageFor(interaction){
  const usage=interaction.usage;
  const input=usage?.total_input_tokens;
  const output=(usage?.total_output_tokens??0)+(usage?.total_thought_tokens??0);
  return Number.isSafeInteger(input)&&Number.isSafeInteger(output)&&input>=0&&output>=0 ? {input,output} : null;
}

const unknown=code=>({type:'unknown',code});
const failed=(code,usage)=>({type:'failed',code,usage});
const wait=(state,delay=8)=>({type:'waiting',state,delay});

function makeClient(env){
  return new GoogleGenAI({apiKey:env.GEMINI_API_KEY,httpOptions:{timeout:95000,retryOptions:{attempts:1}}});
}

function interactionResult(interaction,input){
  const usage=usageFor(interaction);
  if(!usage) return unknown('PROVIDER_USAGE_UNKNOWN');
  if(interaction.status!=='completed') return failed('VIDEO_PROVIDER_FAILED',usage);
  const raw=interaction.output_text??interaction.steps?.filter(step=>step.type==='model_output')
    .at(-1)?.content?.filter(item=>item.type==='text').map(item=>item.text).join('');
  try{
    const report=validateVideoAudit(JSON.parse(raw),input,interaction.usage.input_tokens_by_modality??[]);
    return {type:'success',usage,drafts:report};
  }catch(error){
    return failed(error.message?.startsWith('VIDEO_')?error.message:'PROVIDER_RESPONSE_INVALID',usage);
  }
}

export function videoGeminiProvider(db,{env=process.env,client,sign=montageUrl}={}){
  return async(model,input,state)=>{
    if(!env.GEMINI_API_KEY) return state?.interactionId
      ?unknown("PROVIDER_OUTCOME_UNKNOWN"):failed("VIDEO_AUDIT_DISABLED");
    const ai=client??makeClient(env);
    const progress=state??{startedAt:Date.now()};
    if(Date.now()-progress.startedAt>providerDeadline){
      return progress.interactionId?unknown('VIDEO_PROVIDER_TIMEOUT'):failed('VIDEO_PROVIDER_TIMEOUT');
    }
    if(progress.interactionId){
      try{
        const current=await ai.interactions.get(progress.interactionId,{},requestOptions);
        if(statesWaiting.has(current.status)) return wait(progress);
        return interactionResult(current,input);
      }catch(error){
        return error?.status===404 ? unknown('PROVIDER_OUTCOME_UNKNOWN') : wait(progress,15);
      }
    }
    if(env.VIDEO_AUDIT_ENABLED!=='true'||env.ANALYSIS_ENABLED!=='true'
      ||!(Date.now()<Date.parse(env.ANALYSIS_PRICING_EXPIRES_AT??''))) return failed('VIDEO_AUDIT_DISABLED');
    const {rows:[row]}=await db.query(`SELECT pathname,state,sha256,expires_at FROM episode_media_revisions WHERE id=$1`,[input.mediaId]);
    if(!row||row.state!=='passed'||row.sha256!==input.sha256||new Date(row.expires_at).getTime()<=Date.now()){
      return failed('MEDIA_NOT_READY');
    }
    let video;
    try{
      if(progress.fileName){
        const file=await ai.files.get({name:progress.fileName});
        if(file.state==='FAILED') return failed('VIDEO_FILE_REJECTED');
        if(file.state!=='ACTIVE') return wait(progress);
        if(!file.uri) return failed('VIDEO_FILE_REJECTED');
        video={uri:file.uri};
      }else{
        const source=await fetch(await sign(row,'get',15),{redirect:'error',signal:AbortSignal.timeout(40000)});
        if(!source.ok||Number(source.headers.get('content-length'))!==input.expectedBytes) return failed('VIDEO_FILE_REJECTED');
        if(input.expectedBytes>inlineLimit){
          const file=await ai.files.upload({file:await source.blob(),config:{mimeType:'video/mp4'}});
          if(!file.name) return failed('VIDEO_FILE_REJECTED');
          return wait({...progress,fileName:file.name});
        }
        video={data:Buffer.from(await source.arrayBuffer()).toString('base64')};
      }
    }catch{return failed('VIDEO_FILE_REJECTED');}
    try{
      const interaction=await ai.interactions.create({
        model,background:true,store:true,
        input:[{type:'video',...video,mime_type:'video/mp4',processing:{type:'static',fps:1}},
          {type:'text',text:videoPrompt(input)}],
        generation_config:{max_output_tokens:videoOutputLimit,thinking_level:'low'},
        response_format:videoResponseFormat,
      },requestOptions);
      if(!interaction.id) return unknown('PROVIDER_OUTCOME_UNKNOWN');
      return wait({...progress,interactionId:interaction.id});
    }catch(error){
      if(error?.status===429) return failed("PROVIDER_UNAVAILABLE");
      if(error?.status>=400&&error.status<500&&error.status!==408){
        const detail=String(error.message??'').toLowerCase();
        const reason=/schema|response_format/.test(detail)?'schema':/processing|fps/.test(detail)?'processing':
          /background|store/.test(detail)?'background':/api.key|permission/.test(detail)?'access':'other';
        console.warn('VIDEO_PROVIDER_REJECTED',error.status,reason);
        return failed('PROVIDER_REJECTED');
      }
      return unknown('PROVIDER_OUTCOME_UNKNOWN');
    }
  };
}

export async function cleanVideoProviderFiles(db,env=process.env){
  if(!env.GEMINI_API_KEY) return;
  const ai=makeClient(env);
  const {rows}=await db.query(`SELECT c.job_id,c.attempt,c.position,c.provider_state
    FROM ai_chunks c JOIN ai_attempts a USING (job_id,attempt)
    WHERE c.provider_state IS NOT NULL AND c.provider_cleaned_at IS NULL
      AND (a.status IN ('succeeded','failed') OR (a.status='unknown' AND a.created_at<now()-interval '1 hour'))
    ORDER BY a.created_at LIMIT 2`);
  for(const row of rows){
    try{
      const {interactionId,fileName}=row.provider_state;
      if(interactionId) await ai.interactions.delete(interactionId,{},requestOptions).catch(error=>{if(error?.status!==404)throw error;});
      if(fileName) await ai.files.delete({name:fileName}).catch(error=>{if(error?.status!==404)throw error;});
      await db.query('UPDATE ai_chunks SET provider_cleaned_at=now() WHERE job_id=$1 AND attempt=$2 AND position=$3',
        [row.job_id,row.attempt,row.position]);
    }catch{/* Cron retries provider cleanup independently of the result. */}
  }
}
