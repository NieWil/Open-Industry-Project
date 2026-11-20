import { describe, expect, it } from 'vitest'
import { partFingerprint } from './parts/partOrigin'
import { PACKAGE_FORMAT } from './parts/partPackage'
import { validatePartPackage } from './parts/partValidate'
import type { PartPackage } from './parts/partPackage'
import { PART_ASSETS_PATH, pinShippedAsset, referenceShippedAssets, shippedAssetUrl, shippedFetchUrl } from './shippedAssets'
import { SHIPPED_PART_ASSETS } from './shippedPartAssets'

const [sourceUrl, baked] = Object.entries(SHIPPED_PART_ASSETS)[0]!
const part = (assets: PartPackage['assets']): PartPackage => ({
  format: PACKAGE_FORMAT,
  id: 'acme.robot',
  name: 'Robot',
  params: {},
  behavior: 'definePart({ step() {} })',
  geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }], joints: [] },
  assets,
})

describe('shipped part assets (public/part-assets, by hash)', () => {
  it('a first-party source URL is pointed at its baked bytes, with their hash', () => {
    const pinned = pinShippedAsset({ id: 'glb', mime: 'model/gltf-binary', url: sourceUrl })
    expect(pinned).toEqual({ id: 'glb', mime: 'model/gltf-binary', url: `${PART_ASSETS_PATH}${baked.sha256}${baked.ext}`, sha256: baked.sha256 })
    expect(shippedAssetUrl(baked.sha256)).toBe(pinned.url)
    // anything else is left alone
    const other = { id: 'x', mime: 'image/webp', url: '/somewhere/else.webp' }
    expect(pinShippedAsset(other)).toBe(other)
    expect(pinShippedAsset(pinned)).toBe(pinned)
  })

  it('an asset that knows its hash fingerprints by the hash: the same part as bytes or as a reference', () => {
    const asRef = part([pinShippedAsset({ id: 'glb', mime: 'model/gltf-binary', url: sourceUrl })])
    const asBytes = part([{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA', sha256: baked.sha256 }])
    expect(partFingerprint(asBytes)).toBe(partFingerprint(asRef))
    // a different hash is a different part (a re-exported model is an update)
    expect(partFingerprint(part([{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA', sha256: 'f'.repeat(64) }]))).not.toBe(partFingerprint(asRef))
    // an asset with no hash is compared as written
    expect(partFingerprint(part([{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA' }]))).not.toBe(partFingerprint(part([{ id: 'glb', mime: 'model/gltf-binary', data: 'BBBB' }])))
  })

  it('bytes the app ships come back from disk as a reference; anything else keeps its bytes', () => {
    const fromDisk = part([
      { id: 'glb', mime: 'model/gltf-binary', data: 'AAAA', sha256: baked.sha256 },
      { id: 'own', mime: 'image/webp', data: 'BBBB', sha256: 'e'.repeat(64) },
    ])
    const light = referenceShippedAssets(fromDisk)
    expect(light.assets).toEqual([
      { id: 'glb', mime: 'model/gltf-binary', sha256: baked.sha256, url: shippedAssetUrl(baked.sha256) },
      { id: 'own', mime: 'image/webp', data: 'BBBB', sha256: 'e'.repeat(64) },
    ])
    expect(partFingerprint(light)).toBe(partFingerprint(fromDisk))
    const plain = part([{ id: 'own', mime: 'image/webp', data: 'BBBB' }])
    expect(referenceShippedAssets(plain)).toBe(plain)
  })

  it("an older copy's source path is fetched from its baked file; anything else is fetched as it is", () => {
    expect(shippedFetchUrl(sourceUrl)).toBe(`${PART_ASSETS_PATH}${baked.sha256}${baked.ext}`)
    expect(shippedFetchUrl('/somewhere/else.webp')).toBe('/somewhere/else.webp')
    const baked0 = `${PART_ASSETS_PATH}${baked.sha256}${baked.ext}`
    expect(shippedFetchUrl(baked0)).toBe(baked0)
  })

  it('a sha256 that is not 64 lowercase hex is refused', () => {
    expect(validatePartPackage(part([{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA', sha256: 'ABC' }])).map((p) => p.field)).toContain('assets[0].sha256')
  })
})

describe('the baked table is current (run `node scripts/bake-part-assets.mjs` after changing a part model)', async () => {
  const { existsSync, readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  // @ts-expect-error - a plain .mjs build helper, untyped
  const { computeAssetVersions } = (await import('../../scripts/lib/asset-versions.mjs')) as { computeAssetVersions: (root: string) => Record<string, string> }
  const root = join(__dirname, '..', '..')
  const urls = new Set<string>()
  for (const d of readdirSync(join(root, 'examples', 'parts'), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const name of ['rig.json', 'manifest.json']) {
      const file = join(root, 'examples', 'parts', d.name, name)
      if (!existsSync(file)) continue
      for (const a of (JSON.parse(readFileSync(file, 'utf8')) as { assets?: { url?: unknown }[] }).assets ?? []) if (typeof a.url === 'string' && a.url.startsWith('/')) urls.add(a.url)
    }
  }
  const inputs = computeAssetVersions(root)

  it('every model and texture a first-party part names is baked from its current source, and the file is there', () => {
    const stale = [...urls].filter((url) => {
      const e = SHIPPED_PART_ASSETS[url]
      return !e || e.input !== inputs[url] || !existsSync(join(root, 'public', 'part-assets', `${e.sha256}${e.ext}`))
    })
    expect(stale, 'part assets not baked as this build would ship them').toEqual([])
  })

  // An older project's copy may name any source path the table has ever held, and is fetched from its baked file
  // (shippedFetchUrl), so the source can be deleted once no current part names it. That holds only while the baked
  // file is there: public/part-assets is append-only.
  it('every source path the table has ever held still has its baked file, so old copies load without the source', () => {
    const missing = Object.entries(SHIPPED_PART_ASSETS).filter(([, e]) => !existsSync(join(root, 'public', 'part-assets', `${e.sha256}${e.ext}`))).map(([url]) => url)
    expect(missing).toEqual([])
  })
})
