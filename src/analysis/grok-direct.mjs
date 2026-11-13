import {grokBatchConfigured} from './grok-batch.mjs';

const API='https://api.x.ai/v1';
export const GROK_REVIEW_MODEL='grok-4.3';
const TIMEOUT_MS=50_000;

// One synchronous chat-completions call. Never throws: returns {text} or {error, outcomeUnknown}.
// outcomeUnknown=true means the request may have reached xAI (timeout / network), so cost may be incurred.
export async function requestGrokDirect({system,input},{fetchImpl=fetch,timeoutMs=TIMEOUT_MS}={}){
  if(!grokBatchConfigured())return {error:'GROK_NOT_CONFIGURED'};
  let response;
  try{
    response=await fetchImpl(`${API}/chat/completions`,{method:'POST',cache:'no-store',
      headers:{Authorization:`Bearer ${process.env.GROK_API_KEY}`,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(timeoutMs),
      body:JSON.stringify({model:GROK_REVIEW_MODEL,max_tokens:700,response_format:{type:'json_object'},
        messages:[{role:'system',content:system},{role:'user',content:input}]})});
  }catch(error){
    const timeout=error?.name==='TimeoutError'||error?.name==='AbortError';
    console.error('GROK_DIRECT_REQUEST_FAILED',{timeout});
    return {error:timeout?'GROK_DIRECT_TIMEOUT':'GROK_DIRECT_OUTCOME_UNKNOWN',outcomeUnknown:true};
  }
  const body=await response.json().catch(()=>null);
  if(!response.ok){
    // Provider error text is not secret; it is what makes 400/401/429 diagnosable in Vercel logs.
    const providerError=typeof body?.error==='string'?body.error:typeof body?.error?.message==='string'?body.error.message:null;
    console.error('GROK_DIRECT_FAILED',{status:response.status,providerError:providerError?.slice(0,300)??null});
    return {error:response.status===429?'GROK_DIRECT_RATE_LIMIT':'GROK_DIRECT_FAILED',status:response.status};
  }
  const text=body?.choices?.[0]?.message?.content;
  if(typeof text!=='string'||!text.trim()){
    console.error('GROK_DIRECT_EMPTY_RESPONSE');
    return {error:'GROK_RESULT_INVALID'};
  }
  return {text};
}
