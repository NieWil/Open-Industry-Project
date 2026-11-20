import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assetFileName, base64ToBytes, bytesToBase64, isPartAssetPath, joinAssetFiles, splitAssetFiles } from './partAssets'

const bytes = (...xs: number[]): Uint8Array => new Uint8Array(xs)
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

describe('base64', () => {
  it('matches node for every padding length, and round-trips', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255)
      const text = bytesToBase64(b)
      expect(text).toBe(Buffer.from(b).toString('base64'))
      expect(base64ToBytes(text)).toEqual(b)
    }
  })

  it('handles a buffer past the flush size', () => {
    const b = new Uint8Array(100_000).map((_, i) => i & 255)
    expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'))
  })

  it('refuses text that is not base64', () => {
    expect(base64ToBytes('abc')).toBeNull()
    expect(base64ToBytes('ab$d')).toBeNull()
    expect(base64ToBytes('a=bc')).toBeNull()
  })
})

describe('asset file names', () => {
  it('are the SHA-256 of the bytes, with an extension from the mime type', () => {
    const b = bytes(1, 2, 3)
    expect(assetFileName(b, 'model/gltf-binary')).toBe(`${sha(b)}.glb`)
    expect(assetFileName(b, 'image/webp')).toBe(`${sha(b)}.webp`)
    expect(assetFileName(b, 'application/x-unknown')).toBe(`${sha(b)}.bin`)
    expect(isPartAssetPath(`assets/${sha(b)}.glb`)).toBe(true)
    expect(isPartAssetPath('assets/body.glb')).toBe(false)
    expect(isPartAssetPath(`../assets/${sha(b)}.glb`)).toBe(false)
  })
})

describe('splitAssetFiles / joinAssetFiles', () => {
  const glb = bytes(0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0)
  const tex = bytes(9, 8, 7)
  const manifest = {
    id: 'acme.box',
    assets: [
      { id: 'body', mime: 'model/gltf-binary', data: bytesToBase64(glb) },
      { id: 'albedo', mime: 'image/webp', data: bytesToBase64(tex) },
      { id: 'again', mime: 'image/webp', data: bytesToBase64(tex) },
      { id: 'shipped', mime: 'model/gltf-binary', url: '/models/Box.glb' },
    ],
  }

  it('moves embedded assets into hash-named files, shares identical bytes, and leaves url assets alone', () => {
    const { manifest: m, files } = splitAssetFiles(manifest)
    expect(files.map((f) => f.path).sort()).toEqual([`assets/${sha(glb)}.glb`, `assets/${sha(tex)}.webp`].sort())
    expect(m.assets).toEqual([
      { id: 'body', mime: 'model/gltf-binary', file: `assets/${sha(glb)}.glb` },
      { id: 'albedo', mime: 'image/webp', file: `assets/${sha(tex)}.webp` },
      { id: 'again', mime: 'image/webp', file: `assets/${sha(tex)}.webp` },
      { id: 'shipped', mime: 'model/gltf-binary', url: '/models/Box.glb' },
    ])
  })

  it('joins them back to exactly the embedded form', () => {
    const { manifest: m, files } = splitAssetFiles(manifest)
    const byPath = new Map(files.map((f) => [f.path, f.bytes]))
    const joined = joinAssetFiles(JSON.stringify(m), (p) => byPath.get(p))
    expect(joined.error).toBeUndefined()
    expect(JSON.parse((joined as { manifestJson: string }).manifestJson)).toEqual(manifest)
  })

  it('returns a manifest with no file assets untouched, byte for byte', () => {
    const text = JSON.stringify(manifest, null, 2)
    expect(joinAssetFiles(text, () => undefined)).toEqual({ manifestJson: text })
    const bare: { id: string; assets?: unknown[] } = { id: 'x' }
    expect(splitAssetFiles(bare)).toEqual({ manifest: { id: 'x' }, files: [] })
  })

  it('fails the open on a missing file, a file that does not match its name, or a path outside assets/', () => {
    const { manifest: m } = splitAssetFiles(manifest)
    const text = JSON.stringify(m)
    expect(joinAssetFiles(text, () => undefined).error).toMatch(/not found in the part folder/)
    expect(joinAssetFiles(text, () => bytes(0)).error).toMatch(/does not match its contents/)
    // a sha256 the entry names must be the file's: the name and the field cannot disagree
    const named = JSON.stringify({ assets: [{ ...(m.assets![0] as object), sha256: '0'.repeat(64) }] })
    expect(joinAssetFiles(named, () => glb).error).toMatch(/its sha256 does not match/)
    const outside = JSON.stringify({ assets: [{ id: 'a', mime: 'image/webp', file: '../secret.webp' }] })
    expect(joinAssetFiles(outside, () => bytes(0)).error).toMatch(/is not an asset file path/)
  })
})

describe('an app-served (url) asset that names its sha256', () => {
  const glb = bytes(0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 7)
  const sha256 = sha(glb)
  const manifest = { id: 'oip.box', assets: [{ id: 'body', mime: 'model/gltf-binary', url: `/part-assets/${sha256}.glb`, sha256 }] }

  it('is written as its file when the host has the bytes, and read back as data with its sha256 kept', () => {
    const { manifest: m, files } = splitAssetFiles(manifest, { assetBytes: (s) => (s === sha256 ? glb : undefined) })
    expect(files).toEqual([{ path: `assets/${sha256}.glb`, bytes: glb }])
    expect(m.assets).toEqual([{ id: 'body', mime: 'model/gltf-binary', sha256, file: `assets/${sha256}.glb` }])
    const joined = joinAssetFiles(JSON.stringify(m), () => glb)
    expect(JSON.parse((joined as { manifestJson: string }).manifestJson).assets).toEqual([{ id: 'body', mime: 'model/gltf-binary', sha256, data: bytesToBase64(glb) }])
  })

  it('stays a url when the host does not have the bytes (still valid, just not self-contained yet)', () => {
    expect(splitAssetFiles(manifest, { assetBytes: () => undefined })).toEqual({ manifest, files: [] })
    expect(splitAssetFiles(manifest)).toEqual({ manifest, files: [] })
  })

  it('a url asset without a sha256 is never touched', () => {
    const plain = { assets: [{ id: 'body', mime: 'model/gltf-binary', url: '/models/Box.glb' }] }
    expect(splitAssetFiles(plain, { assetBytes: () => glb })).toEqual({ manifest: plain, files: [] })
  })
})
