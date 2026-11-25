// Generates every shipped brand asset from the single high-resolution master:
// the web assets in public/ and the native Android/iOS app icons.
//
// Run with:  node scripts/generate-brand-assets.mjs
//
// The master lives at assets/brand/logo-master.png and is the one file that must
// never be regenerated: it was derived (losslessly, alpha-trimmed) from the
// original 1536x1024 brand export, which is recoverable with
//   git show 5f7f8ba:public/logo.png
//
// Why the generated assets are split into two families:
//
//   * The brand mark is a dark navy/teal glyph with cyan highlights. It only
//     reads correctly on a LIGHT background: on the app's near-black surfaces
//     the majority of it falls below the WCAG 3:1 non-text contrast minimum.
//     So every asset consumed by an operating system, browser chrome or link
//     preview carries its own white plate, and contrast is self-contained.
//   * The one exception is the header mark, composed in CSS on top of the app's
//     own light badge plate (`logo-mark-128.png`), so it stays transparent to
//     avoid stacking one plate on another.
//
// Content scale per asset follows how the consumer masks it:
//   `any` icons (full tile visible)                     -> 0.80
//   `maskable` web icons (80% circle)                   -> 0.60
//   iOS app icons (rounded-rect mask)                   -> 0.72
//   legacy Android round icons (circle)                 -> 0.60
//   adaptive-icon foreground (66dp of a 108dp canvas)   -> 0.52
//   favicon (legibility at 16 px beats padding)         -> 0.88
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MASTER = path.join(root, 'assets', 'brand', 'logo-master.png')
const PUBLIC_DIR = path.join(root, 'public')
const ANDROID_RES = path.join(root, 'android', 'app', 'src', 'main', 'res')
const IOS_APPICON = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset')

// The plate every platform-facing asset sits on. Matches the white background the
// Android adaptive icon already uses (values/ic_launcher_background.xml).
const PLATE = { r: 255, g: 255, b: 255 }

const PNG = { compressionLevel: 9, effort: 10, adaptiveFiltering: true }

/** Alpha bounding box of the master, so the generator stays correct if the master is re-cut. */
async function tightBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels + 3] > 4) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) throw new Error(`${file} is fully transparent`)
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * A square tile of `size` px with the mark centred.
 * `content` is the share of the tile height the mark occupies; `plate` is null
 * for a transparent tile. iOS rejects icons with an alpha channel, so every
 * plated tile is fully flattened.
 */
async function tile(mark, { size, content, plate = PLATE }) {
  const markHeight = Math.max(1, Math.round(size * content))
  const resized = await sharp(mark).resize({ height: markHeight, kernel: 'lanczos3' }).png().toBuffer()
  const canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: plate ? { ...plate, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: resized, gravity: 'center' }])
  const flattened = plate ? canvas.flatten({ background: plate }) : canvas
  return flattened.png(PNG).toBuffer()
}

/** Minimal ICO container wrapping PNG entries (understood by every browser since IE11). */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let offset = header.length + directory.length
  entries.forEach((entry, index) => {
    const at = index * 16
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at)
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1)
    directory.writeUInt8(0, at + 2) // palette size (0 = true colour)
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

const manifest = []
function record(where, name, bytes) {
  manifest.push([where, name, bytes])
}

async function generateWebAssets(mark) {
  const write = async (name, buffer) => {
    fs.writeFileSync(path.join(PUBLIC_DIR, name), buffer)
    record('public/', name, buffer.length)
  }

  // Header mark: transparent, fills the tile height. The light plate is CSS.
  await write('logo-mark-128.png', await tile(mark, { size: 128, content: 1, plate: null }))

  // Manifest / notification fallback icons. Not masked, so the mark runs large.
  await write('logo.png', await tile(mark, { size: 512, content: 0.8 }))
  await write('logo-192.png', await tile(mark, { size: 192, content: 0.8 }))

  // Maskable icon: Android may crop to a circle covering 80% of the tile.
  await write('logo-maskable-512.png', await tile(mark, { size: 512, content: 0.6 }))

  // iOS home-screen icon, plus the meta tags that point at it.
  await write('apple-touch-icon.png', await tile(mark, { size: 180, content: 0.72 }))

  const ico = []
  for (const size of [16, 24, 32, 48]) {
    ico.push({ size, png: await tile(mark, { size, content: 0.88 }) })
  }
  await write('favicon.ico', buildIco(ico))

  // Link preview: 1.91:1 so `summary_large_image` cards are not letterboxed.
  const ogWidth = 1200
  const ogHeight = 630
  const ogBackground = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ogWidth}" height="${ogHeight}">` +
      '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#e0f2fe"/>' +
      '</linearGradient></defs>' +
      `<rect width="${ogWidth}" height="${ogHeight}" fill="url(#bg)"/></svg>`
  )
  const ogMark = await sharp(mark)
    .resize({ height: Math.round(ogHeight * 0.68), kernel: 'lanczos3' })
    .png()
    .toBuffer()
  await write(
    'og-image.png',
    await sharp(ogBackground)
      .composite([{ input: ogMark, gravity: 'center' }])
      .flatten({ background: { r: 248, g: 250, b: 252 } })
      .png(PNG)
      .toBuffer()
  )
}

async function generateAndroidIcons(mark) {
  // Legacy launcher icons (API < 26) and the rectangular fallback. The round
  // variant is masked to a circle, so it holds a smaller mark than the square.
  const legacy = [
    ['mipmap-mdpi', 48],
    ['mipmap-hdpi', 72],
    ['mipmap-xhdpi', 96],
    ['mipmap-xxhdpi', 144],
    ['mipmap-xxxhdpi', 192],
  ]
  for (const [dir, size] of legacy) {
    const target = path.join(ANDROID_RES, dir)
    fs.mkdirSync(target, { recursive: true })
    for (const [file, content] of [['ic_launcher.png', 0.8], ['ic_launcher_round.png', 0.6]]) {
      const buffer = await tile(mark, { size, content })
      fs.writeFileSync(path.join(target, file), buffer)
      record(`android/${dir}/`, file, buffer.length)
    }
  }

  // Adaptive-icon foreground (API >= 26). The canvas is 108dp with only the inner
  // 66dp guaranteed visible, and the background comes from
  // @color/ic_launcher_background, so this layer must stay transparent.
  const adaptive = [
    ['mipmap-mdpi', 108],
    ['mipmap-hdpi', 162],
    ['mipmap-xhdpi', 216],
    ['mipmap-xxhdpi', 324],
    ['mipmap-xxxhdpi', 432],
  ]
  for (const [dir, size] of adaptive) {
    const buffer = await tile(mark, { size, content: 0.52, plate: null })
    fs.writeFileSync(path.join(ANDROID_RES, dir, 'ic_launcher_foreground.png'), buffer)
    record(`android/${dir}/`, 'ic_launcher_foreground.png', buffer.length)
  }
}

async function generateIosIcons(mark) {
  fs.mkdirSync(IOS_APPICON, { recursive: true })

  const images = [
    ['AppIcon-20@2x.png', '20x20', 'iphone', 40, '2x'],
    ['AppIcon-20@3x.png', '20x20', 'iphone', 60, '3x'],
    ['AppIcon-29@2x.png', '29x29', 'iphone', 58, '2x'],
    ['AppIcon-29@3x.png', '29x29', 'iphone', 87, '3x'],
    ['AppIcon-40@2x.png', '40x40', 'iphone', 80, '2x'],
    ['AppIcon-40@3x.png', '40x40', 'iphone', 120, '3x'],
    ['AppIcon-60@2x.png', '60x60', 'iphone', 120, '2x'],
    ['AppIcon-60@3x.png', '60x60', 'iphone', 180, '3x'],
    ['AppIcon-76.png', '76x76', 'ipad', 76, '1x'],
    ['AppIcon-76@2x.png', '76x76', 'ipad', 152, '2x'],
    ['AppIcon-83.5@2x.png', '83.5x83.5', 'ipad', 167, '2x'],
    ['AppIcon-1024.png', '1024x1024', 'ios-marketing', 1024, '1x'],
  ]

  for (const [file, size, idiom, pixels, scale] of images) {
    const buffer = await tile(mark, { size: pixels, content: 0.72 })
    fs.writeFileSync(path.join(IOS_APPICON, file), buffer)
    record('ios/AppIcon.appiconset/', file, buffer.length)
    void size
    void idiom
    void scale
  }

  const contents = {
    images: images.map(([filename, size, idiom, , scale]) => ({ size, idiom, filename, scale })),
    info: { version: 1, author: 'xcode' },
  }
  fs.writeFileSync(path.join(IOS_APPICON, 'Contents.json'), `${JSON.stringify(contents, null, 2)}\n`)
}

async function main() {
  if (!fs.existsSync(MASTER)) {
    throw new Error(`Brand master missing: ${MASTER}`)
  }

  const box = await tightBox(MASTER)
  const mark = await sharp(MASTER).extract(box).png().toBuffer()

  await generateWebAssets(mark)
  await generateAndroidIcons(mark)
  await generateIosIcons(mark)

  console.log(`master  assets/brand/logo-master.png  ${box.width}x${box.height}  ${fs.statSync(MASTER).size} B`)
  for (const [where, name, bytes] of manifest) {
    console.log(`wrote   ${(where + name).padEnd(48)} ${String(bytes).padStart(8)} B`)
  }
  console.log(`\n${manifest.length} assets regenerated from the master.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
