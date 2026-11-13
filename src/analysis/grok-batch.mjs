const API='https://api.x.ai/v1';
const headers=()=>({Authorization:`Bearer ${process.env.GROK_API_KEY}`,'Content-Type':'application/json'});

export function grokBatchConfigured(){return typeof process.env.GROK_API_KEY==='string'&&process.env.GROK_API_KEY.length>0;}

export async function submitGrokBatch(name,items){
  if(!grokBatchConfigured())return {error:'GROK_NOT_CONFIGURED'};
  if(!items.length)return {error:'GROK_BATCH_EMPTY'};
  let created;
  try{created=await fetch(`${API}/batches`,{method:'POST',headers:headers(),body:JSON.stringify({name}),cache:'no-store'});}
  catch{return {error:'GROK_BATCH_CREATE_OUTCOME_UNKNOWN',unknown:true};}
  const batch=await created.json().catch(()=>null);
  const id=batch?.id??batch?.batch_id;
  if(!created.ok||typeof id!=='string')return {error:'GROK_BATCH_CREATE_FAILED'};
  let response;
  try{response=await fetch(`${API}/batches/${encodeURIComponent(id)}/requests`,{method:'POST',headers:headers(),
    body:JSON.stringify({batch_requests:items.map(item=>({batch_request_id:item.id,batch_request:{chat_get_completion:{
      model:'grok-4.3',max_tokens:700,response_format:{type:'json_object'},messages:[{role:'system',content:item.system},{role:'user',content:item.input}],
    }}}))}),cache:'no-store'});}
  catch{return {error:'GROK_BATCH_SUBMIT_OUTCOME_UNKNOWN',unknown:true,batchId:id};}
  if(!response.ok)return {error:'GROK_BATCH_SUBMIT_OUTCOME_UNKNOWN',unknown:true,batchId:id};
  return {batchId:id};
}

export async function readGrokBatch(batchId){
  if(!grokBatchConfigured())return null;
  const response=await fetch(`${API}/batches/${encodeURIComponent(batchId)}`,{headers:headers(),cache:'no-store'});
  if(!response.ok)return null;
  const state=(await response.json().catch(()=>null))?.state;
  if(!state||typeof state.num_pending!=='number')return null;
  return {pending:state.num_pending};
}

export async function readGrokBatchResults(batchId){
  const results={},limit=50;let token=null,complete=false;
  for(let page=0;page<limit;page++){
    const url=new URL(`${API}/batches/${encodeURIComponent(batchId)}/results`);url.searchParams.set('limit','100');
    if(token)url.searchParams.set('pagination_token',token);
    const response=await fetch(url,{headers:headers(),cache:'no-store'});if(!response.ok)break;
    const body=await response.json().catch(()=>null);if(!body)break;
    for(const item of body.results??[]){
      const id=item.batch_request_id??item.custom_id??item.id;
      const text=item.batch_result?.response?.chat_get_completion?.choices?.[0]?.message?.content;
      if(typeof id==='string'&&typeof text==='string')results[id]=text;
    }
    token=body.pagination_token??null;if(!token){complete=true;break;}
  }
  return {results,complete};
}
