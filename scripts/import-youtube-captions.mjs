import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { database } from '../src/db/runtime.mjs';
import { importTranscript, registerVideo } from '../src/db/editorial-import.mjs';
import { parseTranscript } from '../src/editorial/transcript.mjs';

const run = promisify(execFile);

async function main() {
  const ids = [...new Set(process.argv.slice(2))];
  if (!ids.length || ids.some(id => !/^[\w-]{11}$/.test(id))) {
    throw new Error('Provide one or more YouTube video IDs.');
  }

  const db = await database();
  for (const id of ids) {
    const request = JSON.stringify({ videoId: id });
    const command = [
      'curl -fsS --max-time 120',
      "-H 'Origin: http://127.0.0.1:19333'",
      "-H 'Content-Type: application/json'",
      "--data-binary '" + request + "'",
      'http://127.0.0.1:19333/read',
    ].join(' ');
    const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'worker-vps', command], {
      timeout: 135_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    if (!result.ok || typeof result.srt !== 'string' || !result.name?.startsWith(id + '-')) {
      throw new Error('No subtitles returned for ' + id);
    }
    const bytes = Buffer.from(result.srt, 'utf8');
    const { segments } = parseTranscript(bytes, 'srt');
    const video = await registerVideo(db, 'https://www.youtube.com/watch?v=' + id);
    const transcript = await importTranscript(db, { videoId: video.id, bytes, format: 'srt' });
    console.log({ youtubeId: id, videoId: video.id, transcriptId: transcript.id, version: transcript.version, segments: segments.length });
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error.code ? 'Caption import failed (' + error.code + ')' : error.message);
  process.exit(1);
}
