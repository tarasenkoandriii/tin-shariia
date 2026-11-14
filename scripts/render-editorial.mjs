import {readFile, writeFile, mkdtemp, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {selectCollageAssets, renderEditorialCollage, renderEditorialCarousel} from '../src/media/editorial-collage.mjs';

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw Error('Usage: node scripts/render-editorial.mjs manifest.json new-output.mp4');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const base = dirname(resolve(manifestPath));
const local = path => resolve(base, path);
const output = resolve(outputPath);
try { await access(output); throw Error('OUTPUT_ALREADY_EXISTS'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const narration = manifest.narration;
if (narration?.provider !== 'soniox' || narration.model !== 'tts-rt-v2' || narration.voice !== 'Maya'
  || narration.language !== 'uk' || narration.speed !== 1.15) throw Error('EDITORIAL_VOICE_LOCKED');
const hash = createHash('sha256').update(await readFile(local(narration.path))).digest('hex');
if (hash !== narration.sha256) throw Error('NARRATION_CHECKSUM_MISMATCH');
const probe = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], {encoding: 'utf8'}));
const audio = probe(local(narration.path));
const duration = Number(audio.format.duration);
const quote = probe(local(manifest.quote.path));
if (!quote.streams.some(stream => stream.codec_type === 'audio') || !Number.isFinite(duration)
  || duration <= 0 || !manifest.scenes?.length || manifest.scenes.at(-1).verdict !== true) throw Error('EDITORIAL_MEDIA_INVALID');
const weight = manifest.scenes.reduce((total, scene) => total + scene.weight, 0);
if (!manifest.scenes.every(scene => Number.isFinite(scene.weight) && scene.weight > 0)) throw Error('INVALID_SCENE_WEIGHT');
const scratch = await mkdtemp(join(tmpdir(), 'editorial-render-'));
const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], {stdio: 'pipe', timeout: 180000});
try {
  const candidates = manifest.assets.map(asset => ({...asset, path: local(asset.path)}));
  const usage = new Map(), selected = [];
  let renderedFrames = 0;
  const totalFrames = Math.ceil(duration * 30);
  for (const [index, scene] of manifest.scenes.entries()) {
    const assets = await selectCollageAssets(scene.verdict ? candidates.filter(asset => asset.kind === 'photo') : candidates,
      scene.tags, usage, scene.verdict ? 1 : scene.assetCount ?? 2);
    selected.push(assets.map(asset => ({path: asset.path, sourceUrl: asset.sourceUrl, credit: asset.credit})));
    const png = join(scratch, `${index}.png`);
    const sceneSpec = {...scene, sourceLabel: manifest.sourceLabel};
    const frames = index === manifest.scenes.length - 1 ? totalFrames - renderedFrames
      : Math.round(duration * scene.weight / weight * 30);
    renderedFrames += frames;
    if (frames < 1) throw Error('SCENE_TOO_SHORT');
    const segment = join(scratch, `${index}.mp4`);
    if (manifest.visualEffect === 'carousel' && !scene.verdict) {
      const carousel = await renderEditorialCarousel(sceneSpec, assets);
      const strip = join(scratch, `${index}-strip.png`);
      await writeFile(png, carousel.base);
      await writeFile(strip, carousel.strip);
      const view = carousel.viewport;
      // One eased card advance per two seconds. Text remains on the fixed base.
      const progress = "floor(t/2)+pow(min(1,max(0,(mod(t,2)-1.3)/0.7)),2)*(3-2*min(1,max(0,(mod(t,2)-1.3)/0.7)))";
      ffmpeg(['-loop', '1', '-framerate', '30', '-i', png, '-loop', '1', '-framerate', '30', '-i', strip,
        '-filter_complex', `[1:v]crop=${view.width}:${view.height}:x='${256}+${carousel.step}*(${progress})':y=0[moving];[0:v][moving]overlay=${view.left}:${view.top},setsar=1[v]`,
        '-map', '[v]', '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', segment]);
    } else {
      await writeFile(png, await renderEditorialCollage(sceneSpec, assets));
      ffmpeg(['-loop', '1', '-i', png, '-frames:v', String(frames), '-vf',
        "zoompan=z='min(zoom+0.00015,1.025)':d=1:s=720x1280:fps=30", '-c:v', 'libx264',
        '-preset', 'fast', '-pix_fmt', 'yuv420p', segment]);
    }
  }
  const list = join(scratch, 'concat.txt');
  await writeFile(list, manifest.scenes.map((_, index) => `file '${index}.mp4'`).join('\n'));
  const body = join(scratch, 'body.mp4');
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-i', local(narration.path), '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', body]);
  const result = join(scratch, 'final.mp4');
  ffmpeg(['-i', local(manifest.quote.path), '-i', body, '-filter_complex',
    '[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];[1:v]setsar=1,fps=30[v1];[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', result]);
  // Exclusive copy also protects the earlier export if another renderer finishes concurrently.
  const {copyFile, constants} = await import('node:fs/promises');
  await copyFile(result, output, constants.COPYFILE_EXCL);
  await writeFile(output + '.json', JSON.stringify({narrationSha256: hash, selected, technical: probe(output)}, null, 2));
  console.log(output);
} finally { await rm(scratch, {recursive: true, force: true}); }
