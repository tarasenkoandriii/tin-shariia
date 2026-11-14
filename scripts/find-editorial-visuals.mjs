import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';

// Usage: node scripts/find-editorial-visuals.mjs queries.json asset-directory
// queries.json contains [{query, tags: ['court'], kind: 'photo'}].
const [queriesPath, directory] = process.argv.slice(2);
if (!queriesPath || !directory) throw Error('VISUAL_SEARCH_ARGUMENTS_MISSING');
const queries = JSON.parse(await readFile(queriesPath, 'utf8'));
if (!Array.isArray(queries) || queries.length < 1 || queries.length > 6) throw Error('INVALID_VISUAL_QUERIES');
const target = resolve(directory);
await mkdir(target, {recursive: true});
const assets = new Map();
const plain = html => String(html ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
for (const item of queries) {
  if (!item.query || !Array.isArray(item.tags) || !['photo', 'map', 'document'].includes(item.kind)) throw Error('INVALID_VISUAL_QUERY');
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({action: 'query', format: 'json', generator: 'search',
    gsrsearch: item.query, gsrnamespace: '6', gsrlimit: '12', prop: 'imageinfo',
    iiprop: 'url|size|extmetadata', iiurlwidth: '1280'}).toString();
  const response = await fetch(url, {signal: AbortSignal.timeout(20000), headers: {'User-Agent': 'TinShariiaEditorial/1.0'}});
  if (!response.ok) throw Error('COMMONS_SEARCH_HTTP_' + response.status);
  const result = await response.json();
  if (result.error) throw Error('COMMONS_SEARCH_REJECTED');
  for (const page of Object.values(result.query?.pages ?? {})) {
    const info = page.imageinfo?.[0], metadata = info?.extmetadata;
    const license = plain(metadata?.LicenseShortName?.value);
    if (!info || !/^(CC BY(?:-SA)? [\d.]+(?: [a-z-]+)?|CC0(?: [\d.]+)?|Public domain)$/i.test(license)
      || info.width < 580 || info.height < 300) continue;
    if (assets.has(page.pageid)) {
      const previous = assets.get(page.pageid);
      previous.tags = [...new Set([...previous.tags, ...item.tags])];
      continue;
    }
    const imageUrl = new URL(info.thumburl ?? info.url);
    if (imageUrl.protocol !== 'https:' || !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(imageUrl.hostname)) continue;
    const image = await fetch(imageUrl, {redirect: 'error', signal: AbortSignal.timeout(30000)});
    if (!image.ok || !/^image\/(jpeg|png|webp)$/.test(image.headers.get('content-type')?.split(';')[0] ?? '')) continue;
    const chunks = []; let size = 0;
    for await (const chunk of image.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw Error('VISUAL_IMAGE_TOO_LARGE');
      chunks.push(chunk);
    }
    const filename = `commons-${page.pageid}.image`;
    await writeFile(join(target, filename), Buffer.concat(chunks));
    const author = plain(metadata.Artist?.value);
    assets.set(page.pageid, {path: filename, kind: item.kind, tags: item.tags,
      credit: `${author.slice(0, 40)} · ${license}`, author, license,
      licenseUrl: metadata.LicenseUrl?.value ?? null, sourceUrl: info.descriptionurl,
      title: page.title, width: info.width, height: info.height, query: item.query});
  }
}
if (assets.size < 6) throw Error('VISUAL_POOL_TOO_SMALL');
await writeFile(join(target, 'candidates.json'), JSON.stringify([...assets.values()], null, 2));
console.log(`Saved ${assets.size} candidates to ${join(target, 'candidates.json')}`);
