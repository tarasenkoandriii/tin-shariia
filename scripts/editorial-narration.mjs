import {writeFile} from 'node:fs/promises';
import {editorialNarration} from '../src/analysis/editorial-narration.mjs';
const [, , path, text] = process.argv;
const key = process.env.SONIOX_API_KEY;
if (!key || !text || text.length > 650) throw Error('SONIOX_INPUT_OR_KEY_MISSING');
const result = await fetch('https://tts-rt.soniox.com/tts', {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(45000),
  headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key},
  body: JSON.stringify({...editorialNarration, text}),
});
if (!result.ok) throw Error('SONIOX_HTTP_' + result.status);
const audio = Buffer.from(await result.arrayBuffer());
if (!audio.length) throw Error('SONIOX_EMPTY_AUDIO');
await writeFile(path, audio);
