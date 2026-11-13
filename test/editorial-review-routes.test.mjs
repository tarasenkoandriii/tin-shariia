import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

// Next.js resolves /api/episodes/<id>/reviews to the static `episodes` catch-all route before the
// generic /api/[collection]/[id]/reviews route. That route must forward review transitions,
// otherwise approving or returning an episode answers 404 NOT_FOUND in production.
test('episode operation route forwards review transitions to the shared editorial handler',async()=>{
  const source=await readFile(new URL('../src/app/api/episodes/[episodeId]/[...operation]/route.ts',import.meta.url),'utf8');
  assert.match(source,/operation\[0\]==='reviews'\)\s*return mutate\(request,'episodes',episodeId,true\)/);
  const post=source.indexOf('export async function POST');
  assert.ok(source.indexOf("operation[0]==='reviews'",post)>post,'reviews must be handled inside POST');
});
