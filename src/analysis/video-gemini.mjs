import { GoogleGenAI } from '@google/genai';
import { montageUrl } from '../media/montage-storage.mjs';
import { validateVideoAudit, videoOutputLimit, videoPrompt, videoResponseFormat } from './video-input.mjs';

const providerDeadline=15*60*1000;
const requestOptions={maxRetries:0,timeout:25000};
const statesWaiting=new Set(['in_progress','queued','pending','running']);

function usageFor(interaction){
  const input=interaction?.promptTokenCount??interaction?.total_input_tokens;
  const output=(interaction?.candidatesTokenCount??interaction?.total_output_tokens??0)
    +(interaction?.thoughtsTokenCount??interaction?.total_thought_tokens??0);
  return Number.isSafeInteger(input)&&Number.isSafeInteger(output)&&input>=0&&output>=0 ? {input,output} : null;
}

const unknown=code=>({type:'unknown',code});
const failed=(code,usage)=>({type:'failed',code,usage});
const wait=(state,delay=8)=>({type:'waiting',state,delay});

function makeClient(env){
  return new GoogleGenAI({apiKey:env.GEMINI_API_KEY,httpOptions:{timeout:95000,retryOptions:{attempts:1}}});
}

function reportResult(raw,input,usage,modalities){
  if(!usage) return unknown('PROVIDER_USAGE_UNKNOWN');
  try{
    const report=validateVideoAudit(JSON.parse(raw?.trim().replace(/^```(?:json)?\s*|\s*```$/gi,'')),input,modalities);
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
        const usage=usageFor(current.usage);
        if(current.status!=='completed') return usage?failed('VIDEO_PROVIDER_FAILED',usage):unknown('PROVIDER_USAGE_UNKNOWN');
        return reportResult(current.output_text,input,usage,current.usage?.input_tokens_by_modality??[]);
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
        if(input.expectedBytes>10_000_000){
          const file=await ai.files.upload({file:await source.blob(),config:{mimeType:'video/mp4'}});
          if(!file.name||!file.uri) return failed('VIDEO_FILE_REJECTED');
          return wait({...progress,fileName:file.name,fileUri:file.uri});
        }
        const bytes=Buffer.from(await source.arrayBuffer());
        video={data:bytes.toString('base64')};
      }
    }catch{return failed('VIDEO_FILE_REJECTED');}
    try{
      const outputSchema={type:'OBJECT',properties:{audioAvailable:{type:'BOOLEAN'},visualAvailable:{type:'BOOLEAN'},summary:{type:'STRING'},coverage:{type:'ARRAY',items:{type:'OBJECT',properties:{interval:{type:'INTEGER'},audio:{type:'STRING'},visual:{type:'STRING'}},required:['interval','audio','visual']}},findings:{type:'ARRAY',items:{type:'OBJECT',properties:{category:{type:'STRING',enum:['speech','pronunciation','pauses','overlap','music','subtitles','quote','attribution','context','conclusion','unsupported','metadata']},severity:{type:'STRING',enum:['critical','major','minor']},startMs:{type:'INTEGER',nullable:true},endMs:{type:'INTEGER',nullable:true},field:{type:'STRING',nullable:true},sourceIndex:{type:'INTEGER',nullable:true},observation:{type:'STRING'},fix:{type:'STRING'}},required:['category','severity','startMs','endMs','field','sourceIndex','observation','fix']}}},required:['audioAvailable','visualAvailable','summary','coverage','findings']};
      const result=await ai.models.generateContent({
        model,
        contents:[{role:'user',parts:[
          {...(video.uri?{fileData:{fileUri:video.uri,mimeType:'video/mp4'}}:
              {inlineData:{data:video.data,mimeType:'video/mp4'}})},
          {text:videoPrompt(input)+'\nПоверни один JSON-об’єкт без Markdown за схемою: '+JSON.stringify(videoResponseFormat.schema)},
        ]}],
        config:{maxOutputTokens:videoOutputLimit,thinkingConfig:{thinkingLevel:'LOW'},
          responseMimeType:'application/json',responseSchema:outputSchema},
      });
      const usage=result.usageMetadata;
      const modalities=(usage?.promptTokensDetails??[]).map(item=>({modality:item.modality,tokens:item.tokenCount}));
      return reportResult(result.text,input,usageFor(usage),modalities);
    }catch(error){
      if(error?.status===429) return failed("PROVIDER_UNAVAILABLE");
      if(error?.status>=400&&error.status<500&&error.status!==408){
        const detail=String(error.message??'').toLowerCase();
        const message=String(error.message??'').slice(0,1200).replace(/(key|token|uri|url)=[^\s&]+/gi,'$1=[redacted]');
        console.warn('VIDEO_PROVIDER_REJECTED',error.status,message);
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
