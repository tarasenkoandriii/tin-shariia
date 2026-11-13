'use client';

import {useMemo,useState} from 'react';

export type MontagePlan={id:string;name:string;version:number;is_default:boolean;parent_plan_id:string|null;active:boolean;spec:Record<string,unknown>;
  versions:{version:number;change_source:string;instruction:string|null;created_at:string}[]};
const labelSource:Record<string,string>={created:'Створення',manual:'Зміна редактора',gemini:'Пропозиція Gemini'};

async function post(body:Record<string,unknown>){
  const response=await fetch('/api/editorial/montage-plans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const payload=await response.json();if(!response.ok)throw Error(payload.error?.code??'SAVE_FAILED');return payload.data;
}

export function MontagePlansDashboard({initialPlans}:{initialPlans:MontagePlan[]}){
  const [plans,setPlans]=useState(initialPlans),[selectedId,setSelectedId]=useState(initialPlans[0]?.id??''),
    [name,setName]=useState(initialPlans[0]?.name??''),[specText,setSpecText]=useState(JSON.stringify(initialPlans[0]?.spec??{},null,2)),[instruction,setInstruction]=useState(''),
    [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[proposal,setProposal]=useState(false);
  const selected=useMemo(()=>plans.find(plan=>plan.id===selectedId)??plans[0],[plans,selectedId]);
  function load(plan:MontagePlan){setName(plan.name);setSpecText(JSON.stringify(plan.spec,null,2));setProposal(false);}
  async function refresh(nextId=selectedId){
    const response=await fetch('/api/editorial/montage-plans',{cache:'no-store'}),body=await response.json();
    if(!response.ok)throw Error(body.error?.code??'LOAD_FAILED');setPlans(body.data);setSelectedId(nextId||body.data[0]?.id||'');
    const next=body.data.find((plan:MontagePlan)=>plan.id===(nextId||selectedId))??body.data[0];if(next)load(next);
  }
  function updateSpec(path:string,value:unknown){
    try{
      const next=JSON.parse(specText) as Record<string,unknown>;
      if(path.startsWith('endingStamp.')){
        const stamp={...(next.endingStamp as Record<string,unknown>),[path.slice('endingStamp.'.length)]:value};
        next.endingStamp=stamp;
      }else next[path]=value;
      setSpecText(JSON.stringify(next,null,2));
    }catch{setMessage('Виправте JSON перед редагуванням окремих полів.');}
  }
  let spec:Record<string,unknown>={};
  try{spec=JSON.parse(specText);}catch{}
  const stamp=(spec.endingStamp&&typeof spec.endingStamp==='object'?spec.endingStamp:{}) as Record<string,unknown>;
  async function save(){
    if(!selected)return;setBusy(true);setMessage('');
    try{
      const row=await post({action:'save',id:selected.id,name,version:selected.version,spec,
        changeSource:proposal?'gemini':'manual',instruction:proposal?instruction:null});
      await refresh(row.id);setMessage(`Збережено версію ${row.version}.`);
    }catch(error){setMessage((error as Error).message==='REVISION_CONFLICT'?'План змінився в іншій вкладці. Оновіть список перед збереженням.':
      (error as Error).message==='INVALID_INPUT'?'Перевірте JSON, обов’язкові поля, формат та закріплену озвучку.':'Не вдалося зберегти план. Перевірте JSON і повторіть.');}
    finally{setBusy(false);}
  }
  async function clone(){
    if(!selected)return;setBusy(true);setMessage('');
    try{const created=await post({action:'create',name:(name||selected.name)+' — копія',parentPlanId:selected.id,spec});
      await refresh(created.id);setMessage('Створено окремий план-копію.');}
    catch{setMessage('Не вдалося створити копію. Спершу збережіть коректний JSON.');}finally{setBusy(false);}
  }
  async function askGemini(){
    if(!selected||!instruction.trim())return;setBusy(true);setMessage('Gemini готує пропозицію…');
    try{const result=await post({action:'ai-edit',id:selected.id,version:selected.version,instruction});
      setSpecText(JSON.stringify(result.suggestedSpec,null,2));setProposal(true);
      setMessage(`Пропозиція готова (${(result.spentMicros/1_000_000).toFixed(4)} $). Перегляньте її та натисніть «Зберегти версію».`);}
    catch(error){const code=(error as Error).message;setMessage(code==='BUDGET_EXHAUSTED'?'Вичерпано місячний ліміт Gemini для проєкту.':
      code==='ANALYSIS_DISABLED'?'Gemini зараз вимкнений або сплив тарифний період.':
      code==='REVISION_CONFLICT'?'План змінився. Оновіть його і повторіть.':'Gemini не повернув валідний план. Зміни не збережено.');}
    finally{setBusy(false);}
  }
  return <>
    <section className="workflow-card montage-plan-editor">
      <label>План<select value={selected?.id??''} onChange={event=>{setSelectedId(event.target.value);const chosen=plans.find(item=>item.id===event.target.value);if(chosen)load(chosen);}}>
        {plans.map(plan=><option key={plan.id} value={plan.id}>{plan.is_default?'За замовчуванням · ':''}{plan.name} · v{plan.version}</option>)}
      </select></label>
      {selected&&<>
        <p>{selected.is_default?'Це основний типовий план.':'Окрема копія типового плану.'} Редагування створює нову версію, попередні версії зберігаються.</p>
        <label>Назва<input value={name} readOnly={selected.is_default} onChange={event=>setName(event.target.value)} maxLength={120}/></label>
        <div className="montage-plan-fields">
          <label>Формат виходу<select value={String(spec.format??'')} onChange={event=>updateSpec('format',event.target.value)}>
            <option value="9:16">Вертикальний Shorts · 9:16</option><option value="16:9">Горизонтальний випуск · 16:9</option>
          </select></label>
          <label>Цільова тривалість, секунд<input type="number" min={30} max={3600} value={Number(spec.targetDurationSec??45)}
            onChange={event=>updateSpec('targetDurationSec',Number(event.target.value))}/></label>
          <label><input type="checkbox" checked={Boolean(spec.openingQuote)} onChange={event=>updateSpec('openingQuote',event.target.checked)}/> Починати з відеоцитати</label>
          <label>Субтитри під цитатою<textarea value={String(spec.openingQuoteSubtitles??'')} onChange={event=>updateSpec('openingQuoteSubtitles',event.target.value)}/></label>
          <label>Вимоги до озвучення<textarea value={String(spec.narration??'')} onChange={event=>updateSpec('narration',event.target.value)}/></label>
          <label>Перевірені факти: імена, дати, суми<textarea value={String(spec.factDetail??'')} onChange={event=>updateSpec('factDetail',event.target.value)}/></label>
          <label>Ілюстрації й джерела зображень<textarea value={String(spec.visuals??'')} onChange={event=>updateSpec('visuals',event.target.value)}/></label>
          <label>Композиція й безпечні поля<textarea value={String(spec.layout??'')} onChange={event=>updateSpec('layout',event.target.value)}/></label>
          <label><input type="checkbox" checked={Boolean(stamp.enabled)} onChange={event=>updateSpec('endingStamp.enabled',event.target.checked)}/> Додавати фінальний штамп</label>
          <label>Текст штампа<input value={String(stamp.text??'')} onChange={event=>updateSpec('endingStamp.text',event.target.value)}/></label>
          <label>Нахил штампа, градусів<input type="number" min={-15} max={15} step="0.5" value={Number(stamp.tiltDeg??-5)}
            onChange={event=>updateSpec('endingStamp.tiltDeg',Number(event.target.value))}/></label>
          <label>Поле для подальшого обрізання, %<input type="number" min={8} max={25} value={Number(stamp.safeMarginPercent??12)}
            onChange={event=>updateSpec('endingStamp.safeMarginPercent',Number(event.target.value))}/></label>
          <label>Інші запобіжники<textarea value={String(spec.guardrails??'')} onChange={event=>updateSpec('guardrails',event.target.value)}/></label>
        </div>
        <p>Закріплена озвучка Soniox Maya українською, швидкість 1,15×, захищена від зміни.</p>
        <details><summary>Повний план у форматі JSON</summary>
          <label>Усі поля плану<textarea className="montage-plan-json" value={specText} onChange={event=>setSpecText(event.target.value)} spellCheck={false}/></label>
        </details>
        <label>Що Gemini має змінити<textarea value={instruction} onChange={event=>setInstruction(event.target.value)} maxLength={2000}
          placeholder="Наприклад: зроби кожен слайд конкретнішим, додай вимогу показувати дати судових рішень і суми застави лише з джерел."/></label>
        <div className="montage-plan-actions">
          <button type="button" disabled={busy||!instruction.trim()} onClick={()=>void askGemini()}>{busy?'Обробляємо…':'Запропонувати зміни через Gemini'}</button>
          <button type="button" disabled={busy} onClick={()=>void save()}>{proposal?'Переглянув — зберегти нову версію':'Зберегти нову версію'}</button>
          <button type="button" disabled={busy} onClick={()=>void clone()}>Створити копію</button>
        </div>
        {message&&<output role="status">{message}</output>}
      </>}
    </section>
    {selected&&<section className="workflow-card">
      <h2>Історія версій</h2>
      <ol>{selected.versions.map(item=><li key={item.version}>v{item.version} · {labelSource[item.change_source]??item.change_source}
        {item.instruction&&<> · {item.instruction}</>} · {new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Kyiv'}).format(new Date(item.created_at))}</li>)}</ol>
    </section>}
  </>;
}
