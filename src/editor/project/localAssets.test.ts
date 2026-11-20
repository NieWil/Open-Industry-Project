// What is provable without IndexedDB: the swap between `data` and a hash, and that nothing is swapped before its bytes
// are known to be stored. The database itself is real-browser behaviour, gated by e2e/verify-autosave-quota.mjs.

import { afterEach, describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../../core/parts/partAssets'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { LOCAL_ASSET_FIELD, localAssetRefs, localAssetReviver, markLocalAssetStoredForTest, resetLocalAssetsForTest, withLocalAssets } from './localAssets'

const model = bytesToBase64(Uint8Array.from({ length: 3000 }, (_, i) => (i * 2654435761) >>> 24))

function pkg(id: string, data = model): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: id,
    params: {},
    behavior: 'definePart(() => ({}))',
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'mesh', asset: 'body' } }], joints: [], bounds: { length: 1, width: 1, top: 1, bottom: 0 } },
    assets: [{ id: 'body', mime: 'model/gltf-binary', data, sha256: 'x'.repeat(64) }],
  } as unknown as PartPackage
}

afterEach(() => resetLocalAssetsForTest())

describe('withLocalAssets', () => {
  it('leaves an asset embedded until its bytes are known to be stored', () => {
    const doc = { packages: [pkg('a')] }
    expect(withLocalAssets(doc)).toBe(doc)
  })

  it('names a stored asset by its hash, keeping its other fields, in the library and on the scene', () => {
    const sha = markLocalAssetStoredForTest(model)
    const out = withLocalAssets({ packages: [pkg('a')], scene: { packages: [pkg('b')] } })
    for (const asset of [out.packages![0]!.assets![0]!, out.scene!.packages![0]!.assets![0]!]) {
      expect(asset).toEqual({ id: 'body', mime: 'model/gltf-binary', sha256: 'x'.repeat(64), [LOCAL_ASSET_FIELD]: sha })
    }
  })

  it('does not change the document it was given', () => {
    markLocalAssetStoredForTest(model)
    const doc = { packages: [pkg('a')] }
    withLocalAssets(doc)
    expect(doc.packages[0]!.assets![0]!.data).toBe(model)
  })

  it('leaves non-canonical base64 embedded, since it would not read back as the same text', () => {
    markLocalAssetStoredForTest(model)
    const odd = `${model.slice(0, 40)}\n${model.slice(40)}`
    const doc = { packages: [pkg('a', odd)] }
    expect(withLocalAssets(doc).packages[0]!.assets![0]!.data).toBe(odd)
  })
})

describe('reading a stored text back', () => {
  it('puts the bytes back exactly, and lists the hashes it names', () => {
    const sha = markLocalAssetStoredForTest(model)
    const text = JSON.stringify(withLocalAssets({ packages: [pkg('a')] }))
    expect(text).not.toContain(model.slice(0, 200))
    expect(localAssetRefs(text)).toEqual([sha])
    const missing: string[] = []
    const back = JSON.parse(text, localAssetReviver(missing)) as { packages: PartPackage[] }
    expect(missing).toEqual([])
    expect(back.packages[0]!.assets![0]).toEqual(pkg('a').assets![0])
  })

  it('reports a hash whose bytes this session has not read', () => {
    const sha = markLocalAssetStoredForTest(model)
    const text = JSON.stringify(withLocalAssets({ packages: [pkg('a')] }))
    resetLocalAssetsForTest()
    const missing: string[] = []
    JSON.parse(text, localAssetReviver(missing))
    expect(missing).toEqual([sha])
  })
})
