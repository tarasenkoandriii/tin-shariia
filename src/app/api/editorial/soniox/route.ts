import { activeMember } from '../../../../access/membership.mjs';
import { publicationError, publicationIdentity, publicationReply } from '../../../../access/publication-http';
import { database } from '../../../../db/runtime.mjs';
import { uuid } from '../../../../editorial/workflow-input.mjs';

export const maxDuration = 90;
const maxBytes = 44 + 60 * 16000 * 2;

async function readAudio(request: Request) {
  if (request.headers.get('content-type') !== 'audio/wav' ||
    Number(request.headers.get('content-length')) > maxBytes || !request.body) throw Error('SONIOX_AUDIO_INVALID');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Error('SONIOX_AUDIO_INVALID');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const wav = Buffer.concat(chunks, size);
  if (size <= 44 || size % 2 !== 0 || wav.toString('ascii',0,4) !== 'RIFF'
    || wav.readUInt32LE(4) !== size - 8 || wav.toString('ascii',8,16) !== 'WAVEfmt '
    || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1
    || wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(28) !== 32000
    || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16
    || wav.toString('ascii',36,40) !== 'data' || wav.readUInt32LE(40) !== size - 44) {
    throw Error('SONIOX_AUDIO_INVALID');
  }
  return wav;
}

async function transcribe(audio: Buffer, key: string, language: string) {
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch('https://api.soniox.com/v1/' + path, {
      ...init, redirect:'error', signal:AbortSignal.timeout(5000),
      headers:{...init.headers, Authorization:'Bearer '+key},
    });
    if (!response.ok) throw Error('SONIOX_PROVIDER_ERROR');
    return response;
  };
  let fileId: string | undefined;
  let jobId: string | undefined;
  try {
    const body = new FormData();
    body.append('file', new Blob([Uint8Array.from(audio)],{type:'audio/wav'}),'dictation.wav');
    fileId = uuid((await (await call('files',{method:'POST',body})).json()).id);
    jobId = uuid((await (await call('transcriptions',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'stt-async-v6',file_id:fileId,language_hints:[language]}),
    })).json()).id);
    const path = 'transcriptions/'+jobId;
    const deadline = Date.now()+45_000;
    while (Date.now() < deadline) {
      const state = (await (await call(path)).json()).status;
      if (state === 'error') throw Error('SONIOX_PROVIDER_ERROR');
      if (state === 'completed') {
        const result = await (await call(path+'/transcript')).json();
        const tokens = Array.isArray(result.tokens) ? result.tokens
          .filter((token: {text?: unknown; is_audio_event?: boolean}) =>
            typeof token?.text === 'string' && !/^<[^>]+>$/.test(token.text) && !token.is_audio_event)
          .map(({text,start_ms,end_ms}: {text:string;start_ms?:number;end_ms?:number}) => ({text,startMs:start_ms,endMs:end_ms})) : [];
        return {text:tokens.length ? tokens.map((token: {text:string})=>token.text).join('').trim()
          : typeof result.text === 'string' ? result.text.trim() : '',tokens};
      }
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    throw Error('SONIOX_PROVIDER_TIMEOUT');
  } finally {
    for (const path of [jobId && 'transcriptions/'+jobId,fileId && 'files/'+fileId]) {
      if (path) await call(path,{method:'DELETE'}).catch(()=>console.warn('SONIOX_CLEANUP_FAILED'));
    }
  }
}

export async function POST(request: Request) {
  try {
    const identity = await publicationIdentity(request);
    const key = process.env.SONIOX_API_KEY;
    if (process.env.SONIOX_ENABLED !== 'true' || !key) throw Error('SONIOX_DISABLED');
    const requestId = uuid(request.headers.get('Idempotency-Key'));
    const language = new URL(request.url).searchParams.get('language') ?? 'uk';
    if (!['uk','ru','en'].includes(language)) throw Error('INVALID_INPUT');
    const db = await database();
    const actor = await activeMember(db,identity);
    if (!actor?.roles.some((role:string)=>['admin','author','editor'].includes(role))) throw Error('FORBIDDEN');
    const audio = await readAudio(request);
    await db.transaction(async (tx:{query:typeof db.query})=>{
      await tx.query('SELECT pg_advisory_xact_lock(72036601)');
      const member = await activeMember(tx,identity);
      if (!member?.roles.some((role:string)=>['admin','author','editor'].includes(role))) throw Error('FORBIDDEN');
      const {rows:[existing]} = await tx.query('SELECT id FROM soniox_requests WHERE id=$1',[requestId]);
      if (existing) throw Error('SONIOX_DUPLICATE');
      const {rows:[count]} = await tx.query(`SELECT count(*) AS total,
        count(*) FILTER (WHERE member_id=$1) AS actor FROM soniox_requests
        WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[member.id]);
      if (Number(count.total)>=10 || Number(count.actor)>=3) throw Error('SONIOX_QUOTA');
      await tx.query('INSERT INTO soniox_requests(id,member_id) VALUES($1,$2)',[requestId,member.id]);
    });
    try { return publicationReply(await transcribe(audio,key,language)); }
    catch(error) {
      if (error instanceof Error && error.message === 'SONIOX_PROVIDER_TIMEOUT') throw error;
      throw Error('SONIOX_PROVIDER_ERROR');
    }
  } catch(error) { return publicationError(error); }
}
