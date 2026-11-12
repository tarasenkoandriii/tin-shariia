import { GoogleGenAI } from '@google/genai';
import { makePrompt, outputLimit, responseSchema, validateDrafts } from './input.mjs';

function usageFrom(response) {
  const usage=response.usageMetadata;
  if(!usage) return null;
  const input=usage.promptTokenCount;
  const output=(usage.candidatesTokenCount??0)+(usage.thoughtsTokenCount??0);
  return Number.isSafeInteger(input)&&Number.isSafeInteger(output)&&input>=0&&output>=0 ? {input,output}:null;
}

function retryDelay(error) {
  const value=error?.headers?.get?.('retry-after');
  if(value==null) {
    try {
      const info=JSON.parse(error.message).error?.details?.find(item=>item['@type']==='type.googleapis.com/google.rpc.RetryInfo');
      const match=/^(\d+(?:\.\d+)?)s$/.exec(info?.retryDelay??'');
      return match?Math.ceil(Number(match[1])):0;
    } catch { return 0; }
  }
  return /^\d+$/.test(value) ? Number(value) : Math.max(0,Math.ceil((Date.parse(value)-Date.now())/1000)||0);
}

export function geminiProvider({env=process.env, client}={}){
  return async (model,chunk)=>{
    if(env.ANALYSIS_ENABLED!=='true'||!env.GEMINI_API_KEY) return {type:'failed',code:'ANALYSIS_DISABLED'};
    if(!client&&!(Date.now()<Date.parse(env.ANALYSIS_PRICING_EXPIRES_AT??''))) return {type:'failed',code:'ANALYSIS_DISABLED'};
    const ai=client??new GoogleGenAI({apiKey:env.GEMINI_API_KEY,
      httpOptions:{timeout:45000,retryOptions:{attempts:1}}});
    let response;
    try{
      response=await ai.models.generateContent({
        model,contents:makePrompt(chunk),
        config:{maxOutputTokens:outputLimit,responseMimeType:'application/json',responseJsonSchema:responseSchema,
          thinkingConfig:{thinkingLevel:'LOW'}},
      });
    }catch(error){
      const status=error?.status;
      if(status===429||(Number.isInteger(status)&&status>=500&&status<=599)) {
        return {type:'transient',code:status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_UNAVAILABLE',delay:retryDelay(error)};
      }
      if(Number.isInteger(status)&&status>=400&&status<500&&status!==408) return {type:'failed',code:'PROVIDER_REJECTED'};
      return {type:'unknown',code:'PROVIDER_OUTCOME_UNKNOWN'};
    }
    const usage=usageFrom(response);
    if(!usage) return {type:'unknown',code:'PROVIDER_USAGE_UNKNOWN'};
    try{
      return {type:'success',usage,drafts:validateDrafts(JSON.parse(response.text),chunk)};
    }catch{
      return {type:'failed',usage,code:'PROVIDER_RESPONSE_INVALID'};
    }
  };
}
