import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'assets', 'brand', 'logo-master-provided.png');
const out = path.join(root, 'assets', 'brand', 'exports');
const navy = { r: 11, g: 16, b: 37, alpha: 1 };
const white = { r: 255, g: 255, b: 255, alpha: 1 };

await fs.mkdir(out, { recursive: true });
for (const entry of await fs.readdir(out)) {
  if (entry !== 'README.md') {
    await fs.rm(path.join(out, entry), { recursive: true, force: true });
  }
}

const source = await fs.readFile(sourcePath);
const metadata = await sharp(source).metadata();
if (!metadata.width || !metadata.height) {
  throw new Error('Unable to read brand master dimensions.');
}

// Background removal: the provided master sits on a near-black backdrop. Key out
// dark pixels by luminance with a soft edge so the cyan/magenta glow keeps a
// believable fade instead of a hard cut.
function removeDarkBackground(buffer) {
  return sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      const { width, height } = info;
      const keyLow = 28; // fully transparent below this luminance
      const keyHigh = 80; // fully opaque above this luminance
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let alpha = 255;
        if (luma <= keyLow) alpha = 0;
        else if (luma < keyHigh) alpha = Math.round(((luma - keyLow) / (keyHigh - keyLow)) * 255);
        data[i + 3] = Math.min(data[i + 3], alpha);
      }
      return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
    });
}

function alphaBounds(buffer) {
  return sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      let left = info.width;
      let top = info.height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const a = data[(y * info.width + x) * 4 + 3];
          if (a > 24) {
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }
      return { left, top, width: right - left + 1, height: bottom - top + 1 };
    });
}

// Trimmed full logo with transparent background.
const transparentFull = await removeDarkBackground(source);
const fullBounds = await alphaBounds(transparentFull);
const trimmedFull = await sharp(transparentFull).extract(fullBounds).png().toBuffer();
const trimmedMeta = await sharp(trimmedFull).metadata();

// App-icon mark: the top emblem (chat bubbles, arrows, sparkles). The NEXUS
// wordmark is masked out below the chat-bubble tail tips, then the result is
// auto-trimmed so 16–64 px favicons contain only the emblem.
async function buildEmblemMark() {
  const raw = await sharp(transparentFull)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const cutY = Math.round(info.height * 0.49);
  for (let y = cutY; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      data[(y * info.width + x) * 4 + 3] = 0;
    }
  }
  const masked = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
  const bounds = await alphaBounds(masked);
  return sharp(masked).extract(bounds).png().toBuffer();
}
const mark = await buildEmblemMark();

async function saveFullLogo(file, format, background) {
  let image = sharp(trimmedFull).withMetadata({ density: 300 });
  if (background) image = image.flatten({ background });
  if (format === 'webp') image = image.webp({ quality: 94, effort: 6 });
  else image = image.png({ compressionLevel: 9 });
  await image.toFile(file);
}

async function saveMarkPng(file, size, {
  background = { r: 0, g: 0, b: 0, alpha: 0 },
  scale = 0.84,
} = {}) {
  const inner = Math.round(size * scale);
  const foreground = await sharp(mark)
    .resize({
      width: inner,
      height: inner,
      fit: 'contain',
      withoutEnlargement: false,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background,
    },
  })
    .composite([{ input: foreground, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toFile(file);
}

async function writeSvg(file, pngPath, width, height, accessibleTitle) {
  const png = await fs.readFile(pngPath);
  const titleId = 'logo-title';
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${titleId}">`,
    `  <title id="${titleId}">${accessibleTitle}</title>`,
    `  <image width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${png.toString('base64')}"/>`,
    '</svg>',
    '',
  ].join('\n');
  await fs.writeFile(file, svg, 'utf8');
}

async function pngBuffer(size, scale) {
  const inner = Math.round(size * scale);
  const foreground = await sharp(mark)
    .resize({
      width: inner,
      height: inner,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: navy,
    },
  })
    .composite([{ input: foreground, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function makeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map(({ data }) => data)]);
}

function makeIcns(images) {
  const chunks = images.map(({ type, data }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const size = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(size, 4);
  return Buffer.concat([header, ...chunks]);
}

function makePdf(jpeg, imageWidth, imageHeight) {
  const pageWidth = 612;
  const pageHeight = 792;
  const printWidth = (imageWidth * 72) / 300;
  const printHeight = (imageHeight * 72) / 300;
  const x = (pageWidth - printWidth) / 2;
  const y = (pageHeight - printHeight) / 2;
  const drawing = Buffer.from(
    `q\n${printWidth.toFixed(3)} 0 0 ${printHeight.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm\n/Im0 Do\nQ\n`,
    'ascii',
  );
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
      'ascii',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${drawing.length} >>\nstream\n`, 'ascii'),
      drawing,
      Buffer.from('endstream', 'ascii'),
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        'ascii',
      ),
      jpeg,
      Buffer.from('\nendstream', 'ascii'),
    ]),
  ];

  const pieces = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  let position = pieces[0].length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, 'ascii');
    const suffix = Buffer.from('\nendobj\n', 'ascii');
    pieces.push(prefix, object, suffix);
    position += prefix.length + object.length + suffix.length;
  });
  const xrefOffset = position;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
  ].join('');
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  pieces.push(Buffer.from(xref + trailer, 'ascii'));
  return Buffer.concat(pieces);
}

const web = path.join(out, 'web');
const icons = path.join(out, 'icons');
const androidRes = path.join(out, 'android', 'res');
const ios = path.join(out, 'ios', 'AppIcon.appiconset');
const desktop = path.join(out, 'desktop');
const print = path.join(out, 'print');
await Promise.all([web, icons, androidRes, ios, desktop, print].map((folder) =>
  fs.mkdir(folder, { recursive: true }),
));

const fullPng = path.join(web, 'nexus-chat-logo.png');
await saveFullLogo(fullPng, 'png');
await saveFullLogo(path.join(web, 'nexus-chat-logo-light.png'), 'png', white);
await saveFullLogo(path.join(web, 'nexus-chat-logo-dark.png'), 'png', navy);
await saveFullLogo(path.join(web, 'nexus-chat-logo.webp'), 'webp');
await writeSvg(
  path.join(web, 'nexus-chat-logo.svg'),
  fullPng,
  trimmedMeta.width,
  trimmedMeta.height,
  'Nexus Chat logo',
);

const markTransparent = path.join(icons, 'nexus-chat-mark-transparent-512.png');
const appIcon = path.join(icons, 'nexus-chat-app-icon-1024.png');
await saveMarkPng(markTransparent, 512, { scale: 0.94 });
await saveMarkPng(appIcon, 1024, { background: navy, scale: 0.78 });
await saveMarkPng(path.join(icons, 'nexus-chat-app-icon-maskable-512.png'), 512, {
  background: navy,
  scale: 0.65,
});
await saveMarkPng(path.join(icons, 'nexus-chat-app-icon-light-512.png'), 512, {
  background: white,
  scale: 0.78,
});
await writeSvg(
  path.join(icons, 'nexus-chat-mark.svg'),
  markTransparent,
  512,
  512,
  'Nexus Chat emblem',
);

const faviconSizes = [16, 32, 48, 64, 128, 256];
const faviconImages = [];
for (const size of faviconSizes) {
  const data = await pngBuffer(size, 0.88);
  await fs.writeFile(path.join(icons, `favicon-${size}.png`), data);
  faviconImages.push({ size, data });
}
await fs.writeFile(path.join(icons, 'favicon.ico'), makeIco(faviconImages));

const androidIcons = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];
for (const [density, size] of androidIcons) {
  const folder = path.join(androidRes, `mipmap-${density}`);
  await fs.mkdir(folder, { recursive: true });
  const data = await pngBuffer(size, 0.82);
  await fs.writeFile(path.join(folder, 'ic_launcher.png'), data);
  await fs.writeFile(path.join(folder, 'ic_launcher_round.png'), data);
}
const anydpi = path.join(androidRes, 'mipmap-anydpi-v26');
const drawable = path.join(androidRes, 'drawable');
const values = path.join(androidRes, 'values');
await Promise.all([anydpi, drawable, values].map((folder) => fs.mkdir(folder, { recursive: true })));
await saveMarkPng(path.join(androidRes, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png'), 432, {
  scale: 0.58,
});
await fs.writeFile(
  path.join(anydpi, 'ic_launcher.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background" />\n    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n</adaptive-icon>\n',
);
await fs.writeFile(
  path.join(values, 'ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B1025</color>\n</resources>\n',
);

const iosEntries = [
  ['20x20', 'iphone', 'AppIcon-20@2x.png', '2x', 40],
  ['20x20', 'iphone', 'AppIcon-20@3x.png', '3x', 60],
  ['29x29', 'iphone', 'AppIcon-29@2x.png', '2x', 58],
  ['29x29', 'iphone', 'AppIcon-29@3x.png', '3x', 87],
  ['40x40', 'iphone', 'AppIcon-40@2x.png', '2x', 80],
  ['40x40', 'iphone', 'AppIcon-40@3x.png', '3x', 120],
  ['60x60', 'iphone', 'AppIcon-60@2x.png', '2x', 120],
  ['60x60', 'iphone', 'AppIcon-60@3x.png', '3x', 180],
  ['76x76', 'ipad', 'AppIcon-76.png', '1x', 76],
  ['76x76', 'ipad', 'AppIcon-76@2x.png', '2x', 152],
  ['83.5x83.5', 'ipad', 'AppIcon-83.5@2x.png', '2x', 167],
  ['1024x1024', 'ios-marketing', 'AppIcon-1024.png', '1x', 1024],
];
const iosContents = {
  images: [],
  info: { version: 1, author: 'xcode' },
};
for (const [sizeName, idiom, filename, scale, pixels] of iosEntries) {
  await fs.writeFile(path.join(ios, filename), await pngBuffer(pixels, 0.78));
  iosContents.images.push({ size: sizeName, idiom, filename, scale });
}
await fs.writeFile(path.join(ios, 'Contents.json'), `${JSON.stringify(iosContents, null, 2)}\n`);

const desktopImages = [];
for (const size of faviconSizes) {
  const data = await pngBuffer(size, 0.88);
  desktopImages.push({ size, data });
}
await fs.writeFile(path.join(desktop, 'nexus-chat.ico'), makeIco(desktopImages));
const icnsEntries = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
];
const icnsImages = [];
for (const [type, size] of icnsEntries) {
  icnsImages.push({ type, data: await pngBuffer(size, 0.78) });
}
await fs.writeFile(path.join(desktop, 'nexus-chat.icns'), makeIcns(icnsImages));

const printPng = path.join(print, 'nexus-chat-logo-300dpi.png');
await sharp(trimmedFull)
  .withMetadata({ density: 300 })
  .png({ compressionLevel: 9 })
  .toFile(printPng);
const jpeg = await sharp(trimmedFull).flatten({ background: white }).jpeg({ quality: 96 }).toBuffer();
await fs.writeFile(
  path.join(print, 'nexus-chat-logo-letter.pdf'),
  makePdf(jpeg, trimmedMeta.width, trimmedMeta.height),
);

console.log(`Exported brand assets from ${path.relative(root, sourcePath)} to ${path.relative(root, out)}.`);
