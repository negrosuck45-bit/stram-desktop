'use strict'

/**
 * Builds the app icons from the Stram mark:
 *   build/icon.ico  - Windows installer + exe icon (multi-size)
 *   build/icon.png  - 512px source for other platforms
 *   assets/icon.png - window/taskbar icon used at runtime
 */

const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const root = path.join(__dirname, '..')
const buildDir = path.join(root, 'build')
const assetsDir = path.join(root, 'assets')
const icoSizes = [256, 128, 64, 48, 32, 16]

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a1a1f"/>
      <stop offset="1" stop-color="#363050"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.08" r="0.8">
      <stop offset="0" stop-color="#8f7dff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#8f7dff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#d8d2ff"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <rect width="512" height="512" rx="116" fill="url(#glow)"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="114.5" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>

  <g filter="url(#shadow)" transform="translate(84 84) scale(5.375)">
    <path fill="url(#mark)" d="M48.28 46.88A22.42 22.42 0 0 1 18.12 16.72 22.42 22.42 0 1 0 48.28 46.88Z"/>
    <path fill="#B8AEFF" opacity=".55" d="M43.46 42.11a18.5 18.5 0 0 1-15.6-15.6 18.63 18.63 0 0 0 15.6 15.6Z"/>
  </g>
</svg>`

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + directory.length

  entries.forEach((entry, index) => {
    const base = index * 16
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base)
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1)
    directory.writeUInt8(0, base + 2) // palette
    directory.writeUInt8(0, base + 3) // reserved
    directory.writeUInt16LE(1, base + 4) // color planes
    directory.writeUInt16LE(32, base + 6) // bits per pixel
    directory.writeUInt32LE(entry.buffer.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.buffer.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.buffer)])
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true })
  fs.mkdirSync(assetsDir, { recursive: true })

  const source = Buffer.from(svg)
  const png512 = await sharp(source).resize(512, 512).png({ compressionLevel: 9 }).toBuffer()

  fs.writeFileSync(path.join(buildDir, 'icon.png'), png512)
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), png512)

  const entries = []
  for (const size of icoSizes) {
    const buffer = await sharp(source).resize(size, size).png({ compressionLevel: 9 }).toBuffer()
    entries.push({ size, buffer })
  }

  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(entries))
  console.log(`Icons written: build/icon.ico (${icoSizes.join(', ')}), build/icon.png, assets/icon.png`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
