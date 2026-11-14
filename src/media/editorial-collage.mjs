import sharp from 'sharp';

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Fractions of frame height, measured outside the rotated stamp's bounding box.
export const verdictClearance = 0.10;

export function stampGeometry(width, height, tiltDeg = -6) {
  const stampWidth = width * 0.80;
  const stampHeight = height * 0.085;
  const angle = Math.abs(tiltDeg) * Math.PI / 180;
  const rotatedHeight = stampWidth * Math.sin(angle) + stampHeight * Math.cos(angle);
  const centerY = height * 0.57;
  const clearance = height * verdictClearance;
  return {
    width: stampWidth, height: stampHeight, centerY,
    top: centerY - rotatedHeight / 2, bottom: centerY + rotatedHeight / 2,
    visualBottom: centerY - rotatedHeight / 2 - clearance,
    textTop: centerY + rotatedHeight / 2 + clearance,
    clearance,
  };
}

export async function selectCollageAssets(candidates, tags, usage = new Map(), count = 2) {
  if (![1, 2, 3, 4].includes(count)) throw Error('COLLAGE_INVALID_ASSET_COUNT');
  const ranked = [];
  for (const candidate of candidates) {
    // Source quotation frames belong exclusively to the opening quote.
    if (!['photo', 'map', 'document'].includes(candidate.kind) || !candidate.credit
      || !candidate.sourceUrl || !candidate.path) continue;
    const metadata = await sharp(candidate.path).metadata();
    if (!metadata.width || !metadata.height
      || (metadata.format !== 'svg' && (metadata.width < 580 || metadata.height < 300))) continue;
    const matches = tags.filter(tag => candidate.tags?.includes(tag)).length;
    if (!matches) continue;
    const resolution = Math.min(metadata.width * metadata.height / 1_000_000, 3);
    ranked.push({candidate, score: matches * 10 + resolution - (usage.get(candidate.path) ?? 0) * 4});
  }
  ranked.sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path));
  const selected = [...new Map(ranked.map(item => [item.candidate.path, item.candidate])).values()].slice(0, count);
  if (selected.length < count) throw Error(count === 2 ? 'COLLAGE_NEEDS_TWO_VERIFIED_ASSETS' : 'COLLAGE_NOT_ENOUGH_VERIFIED_ASSETS');
  for (const asset of selected) usage.set(asset.path, (usage.get(asset.path) ?? 0) + 1);
  return selected;
}

export async function renderEditorialCollage(scene, assets) {
  const width = 720, height = 1280;
  if (![1, 2, 3, 4].includes(assets.length) || !scene.lines?.length || scene.lines.length > 3
    || scene.lines.some(line => line.length > 42) || scene.title.length > 27) {
    throw Error('COLLAGE_TEXT_OR_ASSETS_INVALID');
  }
  const stamp = stampGeometry(width, height);
  const verdict = scene.verdict === true;
  const photoTop = verdict ? 210 : 330;
  const photoHeight = verdict ? Math.floor(stamp.visualBottom - photoTop - 24) : assets.length > 2 ? 430 : 300;
  const panelWidth = assets.length === 1 ? 616 : 294;
  const creditHeight = 22;
  const boxes = assets.map((_, index) => {
    const split = assets.length === 4 || (assets.length === 3 && index > 0);
    const row = assets.length === 4 ? Math.floor(index / 2) : index === 2 ? 1 : 0;
    const column = assets.length === 3 ? index > 0 ? 1 : 0 : index % 2;
    const boxHeight = split ? Math.floor((photoHeight - 12) / 2) : photoHeight;
    return {left: column ? 374 : 52, top: photoTop + row * (boxHeight + 12),
      width: panelWidth, height: boxHeight - creditHeight};
  });
  const layers = await Promise.all(assets.map(async (asset, index) => ({
    input: await sharp(asset.path).resize(boxes[index].width, boxes[index].height, {
      fit: asset.kind === 'map' ? 'contain' : 'cover', background: '#dce8eb',
    }).png().toBuffer(), left: boxes[index].left, top: boxes[index].top,
  })));
  const title = verdict
    ? `<g transform="rotate(-6 360 ${stamp.centerY})"><rect x="${(width - stamp.width) / 2}" y="${stamp.centerY - stamp.height / 2}" width="${stamp.width}" height="${stamp.height}" rx="7" fill="#352f29" stroke="#fed074" stroke-width="6"/><text x="360" y="${stamp.centerY + 14}" fill="#fed074" font-size="38" font-weight="bold">${xml(scene.title)}</text></g>`
    : `<text x="360" y="275" fill="#fed074" font-size="44" font-weight="bold">${xml(scene.title)}</text>`;
  const textTop = verdict ? Math.ceil(stamp.textTop) + 28 : 815;
  const credits = assets.map((asset, index) => `<text x="${boxes[index].left + panelWidth / 2}" y="${boxes[index].top + boxes[index].height + 17}" font-size="12" fill="#a4bfc7">${xml(asset.credit)}</text>`).join('');
  const svg = Buffer.from(`<svg width="720" height="1280"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#102431"/><stop offset="1" stop-color="#1e3944"/></linearGradient></defs><rect width="720" height="1280" fill="url(#g)"/><rect x="30" y="76" width="660" height="1128" rx="18" fill="none" stroke="#80dace" opacity=".6"/><g font-family="Arial" text-anchor="middle"><text x="360" y="170" fill="#8fe6d7" font-size="23">${xml(scene.label)}</text>${title}${credits}${scene.lines.map((line, index) => `<text x="360" y="${textTop + index * 44}" fill="white" font-size="28">${xml(line)}</text>`).join('')}<text x="360" y="1095" fill="#8fe6d7" font-size="18">ТІНЬ ШАРІЯ · ПЕРЕВІРКА ТВЕРДЖЕННЯ</text><text x="360" y="1140" fill="#d7e6e9" font-size="18">${xml(scene.sourceLabel)}</text></g></svg>`);
  return sharp(svg).composite(layers).png().toBuffer();
}

export async function renderEditorialCarousel(scene, assets) {
  if (scene.verdict) throw Error('CAROUSEL_VERDICT_MUST_STAY_STATIC');
  const background = await renderEditorialCollage(scene, assets);
  const base = await sharp(background).composite([{input: Buffer.from(
    '<svg width="616" height="430"><rect width="616" height="430" fill="#17313d"/></svg>'),
  left: 52, top: 330}]).png().toBuffer();
  const step = 384, cardWidth = 360, height = 430;
  // Repeated cards keep both sides populated for the complete pan.
  const cards = [...assets, ...assets, ...assets];
  const layers = [];
  for (const [index, asset] of cards.entries()) {
    const image = await sharp(asset.path).resize(cardWidth, 386, {
      fit: asset.kind === 'map' ? 'contain' : 'cover', background: '#dce8eb',
    }).png().toBuffer();
    const caption = Buffer.from(`<svg width="360" height="44"><rect width="360" height="44" fill="#102431"/><text x="180" y="27" text-anchor="middle" font-family="Arial" font-size="13" fill="#a4bfc7">${xml(asset.credit)}</text></svg>`);
    layers.push({input: image, left: index * step, top: 0},
      {input: caption, left: index * step, top: 386});
  }
  const strip = await sharp({create: {width: cards.length * step, height, channels: 3,
    background: '#17313d'}}).composite(layers).png().toBuffer();
  return {base, strip, step, viewport: {left: 52, top: 330, width: 616, height}};
}
