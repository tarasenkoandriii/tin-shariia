import { privateHeaders, publicationError, publicationIdentity, publicationInput } from '../../../../../access/publication-http';
import { reserveSoniox } from '../../../../../analysis/soniox-quota';
import { uuid } from '../../../../../editorial/workflow-input.mjs';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const identity = await publicationIdentity(request);
    const key = process.env.SONIOX_API_KEY;
    if (process.env.SONIOX_ENABLED !== 'true' || !key) throw Error('SONIOX_DISABLED');
    const requestId = uuid(request.headers.get('Idempotency-Key'));
    const input = await publicationInput(request);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > 650) throw Error('INVALID_INPUT');
    await reserveSoniox(identity, requestId);
    try {
      const result = await fetch('https://tts-rt.soniox.com/tts', {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(45000),
        headers:{'Content-Type':'application/json', Authorization:'Bearer '+key},
        body:JSON.stringify({model:'tts-rt-v2', language:'uk', voice:'Maya', audio_format:'mp3', speed:1.15, text}),
      });
      if (!result.ok) throw Error('SONIOX_PROVIDER_ERROR');
      const audio = await result.arrayBuffer();
      if (!audio.byteLength) throw Error('SONIOX_PROVIDER_ERROR');
      return new Response(audio,{headers:{...privateHeaders,'Content-Type':'audio/mpeg',
        'Content-Disposition':'attachment; filename="narration-uk.mp3"'}});
    } catch(error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw Error('SONIOX_PROVIDER_TIMEOUT');
      }
      throw Error('SONIOX_PROVIDER_ERROR');
    }
  } catch(error) { return publicationError(error); }
}
