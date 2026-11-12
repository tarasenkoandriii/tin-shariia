import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

export async function auditMedia(path) {
  const probe = fileURLToPath(new URL('./probe-media.sh', import.meta.url));
  const { stdout, stderr } = await exec(probe, [resolve(path)], {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const media = JSON.parse(stdout);
  const summary = stderr.split('Summary:').at(-1);
  const loudness = /\bI:\s*(-?\d+(?:\.\d+)?)\s+LUFS/.exec(summary);
  const peak = /\bPeak:\s*(-?\d+(?:\.\d+)?|-inf)\s+dBFS/.exec(summary);
  if (!loudness || !peak) throw new Error('AUDIO_METRICS_UNAVAILABLE');

  const silence = [...stderr.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)]
    .map(([, end, duration]) => ({
      startMs: Math.max(0, Math.round((Number(end) - Number(duration)) * 1000)),
      endMs: Math.round(Number(end) * 1000),
    }));
  return {
    durationMs: Math.round(Number(media.format.duration) * 1000),
    integratedLufs: Number(loudness[1]),
    truePeakDbfs: peak[1] === '-inf' ? null : Number(peak[1]),
    silenceThresholdDb: -45,
    minimumSilenceMs: 500,
    silence,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/audit-media.mjs FILE');
    console.log(JSON.stringify(await auditMedia(process.argv[2]), null, 2));
  } catch (error) {
    console.error(error.message.split('\n')[0]);
    process.exitCode = 1;
  }
}
