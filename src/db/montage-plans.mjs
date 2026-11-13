import {activeMember} from '../access/membership.mjs';
import {analysisConfig} from '../analysis/config.mjs';
import {monthlyAnalysisBudget} from '../analysis/monthly-budget.mjs';
import {uuid} from '../editorial/workflow-input.mjs';
import {editMontagePlanWithGemini} from '../analysis/montage-plan-ai.mjs';

const json=value=>JSON.stringify(value);
const planSchema=(value)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_INPUT');
  const allowed=new Set(['schema','format','language','targetDurationSec','openingQuote','openingQuoteSubtitles','narration',
    'narrationVoice','factDetail','visuals','layout','endingStamp','guardrails']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw Error('INVALID_INPUT');
  const limits={language:12,openingQuoteSubtitles:500,narration:1000,factDetail:1600,visuals:1200,
    layout:900,guardrails:1600};
  if(value.schema!==1||!['9:16','16:9'].includes(value.format)||value.language!=='uk'
    ||!Number.isInteger(value.targetDurationSec)||value.targetDurationSec<30||value.targetDurationSec>3600
    ||typeof value.openingQuote!=='boolean'||!value.endingStamp||typeof value.endingStamp!=='object'
    ||value.endingStamp.shape!=='rectangle'||!Number.isFinite(value.endingStamp.tiltDeg)
    ||Math.abs(value.endingStamp.tiltDeg)>15||typeof value.endingStamp.enabled!=='boolean'
    ||typeof value.endingStamp.largeText!=='boolean'||!Number.isInteger(value.endingStamp.safeMarginPercent)
    ||value.endingStamp.safeMarginPercent<8||value.endingStamp.safeMarginPercent>25
    ||typeof value.endingStamp.text!=='string'||value.endingStamp.text.length>160
    ||value.narrationVoice!=='Soniox Maya uk, 1.15x; голос і швидкість незмінні')throw Error('INVALID_INPUT');
  for(const [key,max] of Object.entries(limits))if(typeof value[key]!=='string'||value[key].length>max)throw Error('INVALID_INPUT');
  return value;
};
const nameValue=value=>{
  if(typeof value!=='string'||!value.trim()||value.trim().length>120)throw Error('INVALID_INPUT');
  return value.trim();
};
async function adminFor(db,identity){
  if(!identity)throw Error('AUTH_REQUIRED');
  const member=await activeMember(db,identity);
  if(!member?.roles.includes('admin'))throw Error('FORBIDDEN');
  return member;
}

export async function listMontagePlans(db,identity){
  await adminFor(db,identity);
  const {rows}=await db.query(`SELECT id,name,version,is_default,parent_plan_id,active,spec,created_at,updated_at
    FROM editorial_montage_plans ORDER BY is_default DESC,active DESC,updated_at DESC`);
  const {rows:versions}=await db.query(`SELECT plan_id,version,change_source,instruction,created_at
    FROM editorial_montage_plan_versions WHERE plan_id=ANY($1::uuid[]) ORDER BY plan_id,version DESC`,[rows.map(row=>row.id)]);
  return rows.map(row=>({...row,versions:versions.filter(version=>version.plan_id===row.id)}));
}

export async function activeMontagePlan(db,identity,id=null){
  if(!identity)throw Error('AUTH_REQUIRED');
  await activeMember(db,identity).then(member=>{if(!member)throw Error('FORBIDDEN');});
  const {rows:[row]}=id
    ?await db.query('SELECT id,name,version,spec FROM editorial_montage_plans WHERE id=$1 AND active=true',[uuid(id)])
    :await db.query('SELECT id,name,version,spec FROM editorial_montage_plans WHERE is_default=true AND active=true');
  if(!row)throw Error('NOT_FOUND');
  return row;
}

export async function listUsableMontagePlans(db,identity){
  if(!identity)throw Error('AUTH_REQUIRED');
  const member=await activeMember(db,identity);
  if(!member)throw Error('FORBIDDEN');
  const {rows}=await db.query(`SELECT id,name,version,spec FROM editorial_montage_plans
    WHERE active=true ORDER BY is_default DESC,updated_at DESC`);
  return rows;
}

export async function createMontagePlan(db,identity,input){
  const spec=planSchema(input.spec),name=nameValue(input.name),parentId=input.parentPlanId?uuid(input.parentPlanId):null;
  return db.transaction(async tx=>{
    const member=await adminFor(tx,identity);
    if(parentId){const {rows:[parent]}=await tx.query('SELECT id FROM editorial_montage_plans WHERE id=$1',[parentId]);if(!parent)throw Error('NOT_FOUND');}
    const {rows:[row]}=await tx.query(`INSERT INTO editorial_montage_plans(name,parent_plan_id,spec,created_by,updated_by)
      VALUES($1,$2,$3::text::jsonb,$4,$4) RETURNING id,name,version,is_default,parent_plan_id,active,spec,created_at,updated_at`,
    [name,parentId,json(spec),member.id]);
    await tx.query(`INSERT INTO editorial_montage_plan_versions(plan_id,version,spec,changed_by,change_source)
      VALUES($1,1,$2::text::jsonb,$3,'created')`,[row.id,json(spec),member.id]);
    return row;
  });
}

export async function updateMontagePlan(db,identity,input,source='manual'){
  const id=uuid(input.id),spec=planSchema(input.spec),name=nameValue(input.name);
  return db.transaction(async tx=>{
    const member=await adminFor(tx,identity);
    const {rows:[before]}=await tx.query('SELECT * FROM editorial_montage_plans WHERE id=$1 FOR UPDATE',[id]);
    if(!before)throw Error('NOT_FOUND');
    if(before.is_default&&name!==before.name)throw Error('DEFAULT_PLAN_NAME_LOCKED');
    if(input.version!==before.version)throw Error('REVISION_CONFLICT');
    const next=before.version+1;
    const {rows:[row]}=await tx.query(`UPDATE editorial_montage_plans SET name=$2,spec=$3::text::jsonb,version=$4,updated_by=$5,updated_at=now()
      WHERE id=$1 RETURNING id,name,version,is_default,parent_plan_id,active,spec,created_at,updated_at`,
    [id,name,json(spec),next,member.id]);
    await tx.query(`INSERT INTO editorial_montage_plan_versions(plan_id,version,spec,changed_by,change_source,instruction)
      VALUES($1,$2,$3::text::jsonb,$4,$5,$6)`,[id,next,json(spec),member.id,source,source==='gemini'?String(input.instruction).slice(0,2000):null]);
    return row;
  });
}

export async function aiEditMontagePlan(db,identity,input){
  const id=uuid(input.id),version=input.version;
  if(!Number.isSafeInteger(version)||version<1||typeof input.instruction!=='string'||!input.instruction.trim()||input.instruction.length>2000)
    throw Error('INVALID_INPUT');
  const config=analysisConfig(),instruction=input.instruction.trim();
  const {rows:[plan]}=await db.query('SELECT id,name,version,spec FROM editorial_montage_plans WHERE id=$1 AND active=true',[id]);
  if(!plan)throw Error('NOT_FOUND');
  if(plan.version!==version)throw Error('REVISION_CONFLICT');
  const reserve=Math.ceil((Buffer.byteLength(json(plan.spec))+Buffer.byteLength(instruction)+1800)/3.2)*config.inputRate
    +3000*config.outputRate;
  const call=await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(72036593)');
    const member=await adminFor(tx,identity);
    const current=await monthlyAnalysisBudget(tx);
    if(Number(current.used)+reserve>config.monthlyMicros)throw Error('BUDGET_EXHAUSTED');
    const {rows:[created]}=await tx.query(`INSERT INTO montage_plan_ai_calls(plan_id,requested_by,month,model,reserved_micros,state,instruction)
      VALUES($1,$2,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$3,$4,'running',$5) RETURNING id`,
    [id,member.id,config.model,reserve,instruction]);
    return {id:created.id,spec:plan.spec};
  });
  try{
    const result=await editMontagePlanWithGemini(plan.spec,instruction,config);
    await db.query(`UPDATE montage_plan_ai_calls SET state='succeeded',spent_micros=$2 WHERE id=$1`,[call.id,result.spentMicros]);
    return {id:plan.id,name:plan.name,version,suggestedSpec:result.spec,spentMicros:result.spentMicros};
  }catch(error){
    const usage=error?.usage;
    await db.query(`UPDATE montage_plan_ai_calls SET state=$2,spent_micros=$3 WHERE id=$1`,
      [call.id,usage?'failed':'unknown',usage?usage.input*config.inputRate+usage.output*config.outputRate:0]);
    throw error;
  }
}
