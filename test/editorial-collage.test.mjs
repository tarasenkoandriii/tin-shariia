import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selectCollageAssets, stampGeometry, renderEditorialCollage, renderEditorialCarousel} from '../src/media/editorial-collage.mjs';

test('verdict clearance uses the rotated stamp bounds', () => {
  for (const angle of [-15, -6, 0, 15]) {
    const stamp = stampGeometry(720, 1280, angle);
    assert.ok(stamp.top - stamp.visualBottom >= 127.99);
    assert.ok(stamp.textTop - stamp.bottom >= 127.99);
    assert.ok(stamp.visualBottom > 235);
  }
});

test('collages exclude quote frames, uncredited assets and duplicate paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collage-test-'));
  try {
    const files = ['a', 'b', 'c', 'd'].map(name => join(dir, name + '.png'));
    for (const path of files) await sharp({create: {width: 900, height: 600, channels: 3, background: '#334455'}}).png().toFile(path);
    const asset = path => ({path, kind: 'photo', tags: ['court'], credit: 'Photographer', sourceUrl: 'https://example.org/photo'});
    const pool = [asset(files[0]), asset(files[0]), asset(files[1]), {...asset('/missing-quote.jpg'), kind: 'quote-frame'}, {...asset('/uncredited.jpg'), credit: ''}];
    const selected = await selectCollageAssets(pool, ['court']);
    assert.equal(selected.length, 2);
    assert.equal(new Set(selected.map(item => item.path)).size, 2);
    await assert.rejects(selectCollageAssets(pool, ['unrelated']), /TWO_VERIFIED/);
    const png = await renderEditorialCollage({label: 'ВЕРДИКТ', title: 'НЕ ПІДТВЕРДЖЕНО', lines: ['Перевірений факт'], verdict: true, sourceLabel: 'youtube.com'}, selected);
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.width, 720);
    assert.equal(metadata.height, 1280);
    const singlePhoto = await renderEditorialCollage({label: 'ВЕРДИКТ', title: 'НЕ ПІДТВЕРДЖЕНО',
      lines: ['Перевірений факт'], verdict: true, sourceLabel: 'youtube.com'}, [selected[0]]);
    assert.equal((await sharp(singlePhoto).metadata()).width, 720);
    const largerPool = [...pool, asset(files[2]), asset(files[3])];
    for (const count of [3, 4]) {
      const expanded = await selectCollageAssets(largerPool, ['court'], new Map(), count);
      assert.equal(new Set(expanded.map(item => item.path)).size, count);
      const collage = await renderEditorialCollage({label: 'ВЕРДИКТ', title: 'НЕ ПІДТВЕРДЖЕНО',
        lines: ['Перевірений факт'], verdict: true, sourceLabel: 'youtube.com'}, expanded);
      assert.equal((await sharp(collage).metadata()).height, 1280);
      const scene = {label: 'КОЛАЖ', title: 'Початок розгляду', lines: ['Перевірений факт'], sourceLabel: 'youtube.com'};
      const carousel = await renderEditorialCarousel(scene, expanded);
      assert.equal((await sharp(carousel.base).metadata()).width, 720);
      assert.ok((await sharp(carousel.strip).metadata()).width > carousel.viewport.width * 3);
      assert.ok(carousel.viewport.top + carousel.viewport.height < 815);
      await assert.rejects(renderEditorialCarousel({...scene, verdict: true}, expanded), /VERDICT_MUST_STAY_STATIC/);
    }
    await assert.rejects(selectCollageAssets(pool, ['court'], new Map(), 4), /NOT_ENOUGH/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
