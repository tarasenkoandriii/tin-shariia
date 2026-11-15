// Updates the private YouTube reader on the VPS from the repository without guessing.
//   node scripts/deploy-youtube-reader.mjs          → check only: uploads a release copy and runs it in a
//                                                      throwaway container; the running reader is not touched.
//   node scripts/deploy-youtube-reader.mjs --apply  → the same check, then swaps the files, recreates the
//                                                      container and rolls back automatically if it is not healthy.
// Nothing here reads or prints the reader profile, cookies or tokens. /profile is never copied or changed.
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, copyFile, readFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const run = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const bundle = JSON.parse(await readFile(join(root, 'services/youtube-reader/bundle.json'), 'utf8'));
const apply = process.argv.includes('--apply');
const host = process.env.READER_SSH_HOST || 'worker-vps';
const SAFE = /^[\w./-]+$/;
const names = Object.keys(bundle.files);
if (!names.every(name => SAFE.test(name) && !name.includes('..'))) throw Error('READER_BUNDLE_INVALID');

function ssh(args, {input, inherit = false} = {}) {
  return new Promise((done, fail) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, ...args],
      {stdio: [input ? 'pipe' : 'ignore', inherit ? 'inherit' : 'pipe', 'inherit']});
    let out = '';
    child.stdout?.on('data', chunk => { out += chunk; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? done(out.trim()) : fail(Error('READER_REMOTE_STEP_FAILED')));
    if (input) { input.pipe(child.stdin); }
  });
}

// 1. Local files exist and parse.
for (const source of Object.values(bundle.files)) {
  await access(join(root, source));
  if (/\.(m?js|cjs)$/.test(source)) await run(process.execPath, ['--check', join(root, source)]);
}

// 2. Where the running reader lives, taken from Docker itself.
const label = key => `{{index .Config.Labels "com.docker.compose.${key}"}}`;
const [dir, project, configFiles, image] = (await ssh(['docker', 'inspect', '-f',
  `'${label('project.working_dir')}|${label('project')}|${label('project.config_files')}|{{.Config.Image}}'`, bundle.container]))
  .split('|');
const remoteDir = process.env.READER_DIR || dir;
if (!SAFE.test(remoteDir ?? '') || !remoteDir.startsWith('/') || !SAFE.test(project ?? '') || !/^[\w./:@-]+$/.test(image ?? '')) throw Error('READER_LOCATION_UNKNOWN');
if (configFiles !== `${remoteDir}/compose.yml`) {
  console.error(`The running reader uses ${configFiles}, not ${remoteDir}/compose.yml. Stopping without changes.`);
  throw Error('READER_COMPOSE_FILE_MISMATCH');
}
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const release = `${remoteDir}/.release-${stamp}`;
console.log(`Reader: ${remoteDir} (project ${project}, image ${image})`);

// 3. Upload a release copy next to the running files.
const staging = await mkdtemp(join(tmpdir(), 'reader-release-'));
try {
  for (const [name, source] of Object.entries(bundle.files)) await copyFile(join(root, source), join(staging, name));
  const tar = spawn('tar', [...(process.platform === 'darwin' ? ['--no-xattrs'] : []), '-czf', '-', '-C', staging, ...names], {stdio: ['ignore', 'pipe', 'inherit'], env: {...process.env, COPYFILE_DISABLE: '1'}});
  await ssh(['mkdir', '-p', release, '&&', 'tar', '-xzf', '-', '-C', release], {input: tar.stdout});
} finally { await rm(staging, {recursive: true, force: true}); }

// 4. Preflight in a throwaway container without network: every module resolves with the release files.
const mounts = names.filter(name => name !== 'compose.yml').flatMap(name => ['-v', `${release}/${name}:/reader/${name}:ro`]);
const probe = [
  "const {execFileSync}=await import('node:child_process');",
  "for (const f of ['/reader/reader.mjs','/reader/poll.mjs','/reader/capture-quote.cjs']) execFileSync(process.execPath,['--check',f]);",
  "await import('/reader/captions-bookmarklet.mjs'); await import('/reader/comment-visibility.mjs');",
  "(await import('node:module')).createRequire('/app/package.json').resolve('playwright-core');",
  "console.log('READER_PREFLIGHT_OK');",
].join(' ');
try {
  const result = await ssh(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--entrypoint', 'node',
    ...mounts, image, '--input-type=module', '-e', `"${probe}"`]);
  if (!result.includes('READER_PREFLIGHT_OK')) throw Error('READER_PREFLIGHT_FAILED');
  await ssh(['docker', 'compose', '-p', project, '-f', `${release}/compose.yml`, '--project-directory', remoteDir, 'config', '-q']);
} catch (error) {
  await ssh(['rm', '-rf', release]).catch(() => {});
  throw error;
}
console.log('Preflight passed: release files load in the reader image.');
if (!apply) {
  await ssh(['rm', '-rf', release]);
  console.log('Check only. The running reader was not changed. Re-run with --apply to update it.');
  process.exit(0);
}

// 5. Swap, recreate, verify; restore the previous files if the new container is not healthy.
const swap = `set -eu
dir=${remoteDir}; rel=${release}; bak=$dir/.backup-${stamp}; c=${bundle.container}
files="${names.join(' ')}"
mkdir -p "$bak"
for f in $files; do if [ -e "$dir/$f" ]; then mv "$dir/$f" "$bak/$f"; fi; mv "$rel/$f" "$dir/$f"; done
rmdir "$rel"
restore() {
  echo "Reader not healthy, restoring previous files from $bak" >&2
  for f in $files; do rm -rf "$dir/$f"; if [ -e "$bak/$f" ]; then mv "$bak/$f" "$dir/$f"; fi; done
  cd "$dir" && docker compose -p ${project} up -d --force-recreate
  exit 1
}
# Files are bind-mounted by inode, so the container must be recreated to see the new ones.
cd "$dir" && docker compose -p ${project} up -d --force-recreate || restore
i=0; while [ $i -lt 60 ]; do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$s" = healthy ] && break; [ "$s" = unhealthy ] && restore; i=$((i+1)); sleep 3
done
[ "$s" = healthy ] || restore
for p in ${bundle.mustExistInContainer.join(' ')}; do docker exec "$c" node -e "require('fs').accessSync('$p')" || restore; done
echo "READER_UPDATED backup=$bak"
`;
const {Readable} = await import('node:stream');
await ssh(['sh', '-s'], {input: Readable.from([swap]), inherit: true});
