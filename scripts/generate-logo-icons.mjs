// Derives the browser-chrome raster icons from the vector brand mark so the
// favicon, iOS home-screen icon, and PWA manifest icons all show the current
// logo instead of the legacy raster master.
//
// Run with:  node scripts/generate-logo-icons.mjs
//
// Public filenames and pixel dimensions are preserved on purpose: index.html
// and manifest.webmanifest keep pointing at the same paths, so installed apps
// and cached HTML do not break while the artwork is refreshed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(root, 'public')
const LOGO = path.join(PUBLIC_DIR, 'nexus-logo.svg')

// Matches the logo badge background so flattened icons have no transparent
// corners (iOS rejects alpha in home-screen icons).
const BACKDROP = { r: 5, g: 7, b: 15, alpha: 1 }
const PNG = { compressionLevel: 9, effort: 10, adaptiveFiltering: true }

// Render the vector logo at `size` px. `content` is the share of the tile the
// badge occupies; anything below 1 is safe for Android's maskable crop.
const svg = fs.readFileSync(LOGO)

async function render(size, content = 1) {
  const inner = Math.max(1, Math.round(size * content))
  const badge = await sharp(svg, { density: 384 })
    .resize({ width: inner, height: inner, fit: 'contain' })
    .png()
    .toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background: BACKDROP } })
    .composite([{ input: badge, gravity: 'center' }])
    .flatten({ background: BACKDROP })
    .removeAlpha()
    .png(PNG)
    .toBuffer()
}

// Minimal ICO container wrapping PNG entries (understood by every browser since IE11).
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let offset = header.length + directory.length
  entries.forEach((entry, index) => {
    const at = index * 16
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at)
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1)
    directory.writeUInt8(0, at + 2)
    directory.writeUInt8(0, at + 3)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

const written = []
const write = (name, buffer) => {
  fs.writeFileSync(path.join(PUBLIC_DIR, name), buffer)
  written.push([name, buffer.length])
}

// Manifest + notification fallback icons (not masked, so the badge runs large).
write('logo.png', await render(512))
write('logo-192.png', await render(192))
// Android may crop a maskable icon to a circle covering 80% of the tile.
write('logo-maskable-512.png', await render(512, 0.8))
// iOS home-screen icon.
write('apple-touch-icon.png', await render(180))

const ico = []
for (const size of [16, 24, 32, 48]) ico.push({ size, png: await render(size) })
write('favicon.ico', buildIco(ico))

for (const [name, bytes] of written) console.log(`wrote public/${name} (${bytes} bytes)`)
