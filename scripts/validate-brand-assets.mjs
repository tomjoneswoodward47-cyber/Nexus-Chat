import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets', 'brand', 'exports');
const read = (relative) => fs.readFile(path.join(out, relative));
const imageInfo = async (relative) => sharp(await read(relative)).metadata();
const alphaRange = async (relative) => {
  const { data, info } = await sharp(await read(relative)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  let min = 255;
  let max = 0;
  for (let index = 3; index < data.length; index += info.channels) {
    min = Math.min(min, data[index]);
    max = Math.max(max, data[index]);
  }
  return { min, max };
};

const expectedPngs = new Map([
  ['web/nexus-chat-logo.png', [761, 927]],
  ['web/nexus-chat-logo-light.png', [761, 927]],
  ['web/nexus-chat-logo-dark.png', [761, 927]],
  ['icons/nexus-chat-mark-transparent-512.png', [512, 512]],
  ['icons/nexus-chat-app-icon-1024.png', [1024, 1024]],
  ['icons/nexus-chat-app-icon-maskable-512.png', [512, 512]],
  ['icons/nexus-chat-app-icon-light-512.png', [512, 512]],
  ['print/nexus-chat-logo-300dpi.png', [761, 927]],
]);
for (const size of [16, 32, 48, 64, 128, 256]) {
  expectedPngs.set(`icons/favicon-${size}.png`, [size, size]);
}
for (const [relative, [width, height]] of expectedPngs) {
  const info = await imageInfo(relative);
  assert.equal(info.format, 'png', `${relative} format`);
  assert.equal(info.width, width, `${relative} width`);
  assert.equal(info.height, height, `${relative} height`);
}

for (const relative of [
  'web/nexus-chat-logo.png',
  'icons/nexus-chat-mark-transparent-512.png',
  'print/nexus-chat-logo-300dpi.png',
]) {
  assert.equal((await imageInfo(relative)).hasAlpha, true, `${relative} alpha`);
  assert.ok((await alphaRange(relative)).min < 255, `${relative} has transparent pixels`);
}
for (const relative of [
  'web/nexus-chat-logo-light.png',
  'web/nexus-chat-logo-dark.png',
  'icons/nexus-chat-app-icon-1024.png',
  'icons/nexus-chat-app-icon-maskable-512.png',
  'icons/nexus-chat-app-icon-light-512.png',
]) {
  assert.equal((await alphaRange(relative)).min, 255, `${relative} opaque background`);
}
assert.equal((await imageInfo('print/nexus-chat-logo-300dpi.png')).density, 300);
assert.equal((await imageInfo('web/nexus-chat-logo.webp')).format, 'webp');

const svgLogo = (await read('web/nexus-chat-logo.svg')).toString('utf8');
assert.match(svgLogo, /role="img"/);
assert.match(svgLogo, /aria-labelledby="logo-title"/);
assert.match(svgLogo, /<title id="logo-title">Nexus Chat logo<\/title>/);
assert.match(svgLogo, /data:image\/png;base64,/);
const svgMark = (await read('icons/nexus-chat-mark.svg')).toString('utf8');
assert.match(svgMark, /<title id="logo-title">Nexus Chat emblem<\/title>/);

const ico = await read('desktop/nexus-chat.ico');
assert.equal(ico.readUInt16LE(0), 0);
assert.equal(ico.readUInt16LE(2), 1);
const icoCount = ico.readUInt16LE(4);
assert.equal(icoCount, 6);
const icoSizes = [];
for (let i = 0; i < icoCount; i++) {
  const entry = 6 + i * 16;
  const size = ico.readUInt8(entry) || 256;
  const length = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a');
  icoSizes.push(size);
}
assert.deepEqual(icoSizes, [16, 32, 48, 64, 128, 256]);

const icns = await read('desktop/nexus-chat.icns');
assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
assert.equal(icns.readUInt32BE(4), icns.length);
const icnsTypes = [];
for (let offset = 8; offset < icns.length;) {
  const type = icns.subarray(offset, offset + 4).toString('ascii');
  const length = icns.readUInt32BE(offset + 4);
  assert.ok(length >= 8 && offset + length <= icns.length, `valid ICNS chunk ${type}`);
  assert.equal(icns.subarray(offset + 8, offset + 16).toString('hex'), '89504e470d0a1a0a');
  icnsTypes.push(type);
  offset += length;
}
assert.deepEqual(icnsTypes, ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10']);

const ios = JSON.parse((await read('ios/AppIcon.appiconset/Contents.json')).toString('utf8'));
assert.equal(ios.images.length, 12);
for (const item of ios.images) {
  const info = await imageInfo(`ios/AppIcon.appiconset/${item.filename}`);
  assert.equal(info.width, info.height, `${item.filename} is square`);
  assert.equal(
    (await alphaRange(`ios/AppIcon.appiconset/${item.filename}`)).min,
    255,
    `${item.filename} has an opaque app-icon background`,
  );
}

for (const [density, size] of [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]) {
  const relative = `android/res/mipmap-${density}/ic_launcher.png`;
  const info = await imageInfo(relative);
  assert.deepEqual([info.width, info.height], [size, size], `${density} launcher dimensions`);
}
const adaptiveXml = (await read('android/res/mipmap-anydpi-v26/ic_launcher.xml')).toString('utf8');
assert.match(adaptiveXml, /adaptive-icon/);
assert.match(adaptiveXml, /ic_launcher_foreground/);
assert.match(adaptiveXml, /ic_launcher_background/);

const pdf = (await read('print/nexus-chat-logo-letter.pdf')).toString('latin1');
assert.ok(pdf.startsWith('%PDF-1.4'));
assert.ok(pdf.endsWith('%%EOF\n'));
assert.match(pdf, /\/MediaBox \[0 0 612 792\]/);
assert.match(pdf, /\/Filter \/DCTDecode/);
assert.match(pdf, /startxref\n\d+\n%%EOF/);

console.log(`Validated ${expectedPngs.size} PNG assets, SVG/WebP, ICO (${icoCount} sizes), ICNS (${icnsTypes.length} sizes), 12 iOS icons, Android density/adaptive resources, and the print PDF.`);
