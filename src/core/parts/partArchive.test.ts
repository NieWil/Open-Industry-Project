import { describe, expect, it } from 'vitest'
import { assetFileName, bytesToBase64 } from './partAssets'
import { isZipData, oippartBytesToFolder, partToOippartBytes } from './partArchive'
import { manifestOfPackage, PACKAGE_FORMAT } from './partPackage'
import type { PartPackage } from './partPackage'

const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 255, 0, 128])
const pkg: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'acme.modelled',
  name: 'Modelled',
  params: {},
  behavior: 'definePart(() => ({}))\n',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [] },
  assets: [{ id: 'body', mime: 'model/gltf-binary', data: bytesToBase64(glb) }],
  origin: { shelf: 'fp-1' },
}

describe('.oippart: one part folder, zipped', () => {
  it('holds the part folder at its root, its model as a hash-named file', async () => {
    const bytes = await partToOippartBytes(pkg)
    expect(isZipData(bytes)).toBe(true)
    const { unzipSync } = await import('fflate')
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual(['assets/' + assetFileName(glb, 'model/gltf-binary'), 'behavior.js', 'manifest.json'].sort())
  })

  it('reads back the manifest (assets joined, origin kept) and the behavior, exactly', async () => {
    const back = await oippartBytesToFolder(await partToOippartBytes(pkg))
    if ('error' in back) throw new Error(back.error)
    expect(JSON.parse(back.manifestJson)).toEqual(JSON.parse(JSON.stringify(manifestOfPackage(pkg))))
    expect(back.behaviorJs).toBe(pkg.behavior)
  })

  it('is byte-reproducible', async () => {
    expect(await partToOippartBytes(pkg)).toEqual(await partToOippartBytes(pkg))
  })

  it('stores the same entry time in every timezone, so a desktop and CI pack the same bytes', async () => {
    // a zip entry's time is local time: each local file header (PK\x03\x04) holds DOS time at +10, date at +12
    const bytes = await partToOippartBytes(pkg)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const stamps: string[] = []
    for (let i = 0; i + 14 <= bytes.length; i++) {
      if (view.getUint32(i, true) === 0x04034b50) stamps.push(`${view.getUint16(i + 12, true)}/${view.getUint16(i + 10, true)}`)
    }
    // 2000-01-01 00:00:00 as DOS date / time
    const midnight2000 = `${((2000 - 1980) << 9) | (1 << 5) | 1}/0`
    expect(stamps.length).toBe(3)
    expect(stamps.every((s) => s === midnight2000)).toBe(true)
  })

  it('reads a folder zipped whole (one top directory)', async () => {
    const { unzipSync, zipSync } = await import('fflate')
    const inner = unzipSync(await partToOippartBytes(pkg))
    const wrapped = zipSync(Object.fromEntries(Object.entries(inner).map(([p, b]) => [`acme.modelled/${p}`, b])))
    const back = await oippartBytesToFolder(wrapped)
    expect('error' in back ? back.error : JSON.parse(back.manifestJson).id).toBe('acme.modelled')
  })

  it('names what is wrong: not a zip, no manifest, a model that does not match its name', async () => {
    expect(await oippartBytesToFolder(new Uint8Array([1, 2, 3]))).toEqual({ error: 'not a valid part file (corrupt or not a zip)' })
    const { strToU8, unzipSync, zipSync } = await import('fflate')
    expect(await oippartBytesToFolder(zipSync({ 'behavior.js': strToU8('x') }))).toEqual({ error: 'not a part file (no manifest.json)' })
    const entries = unzipSync(await partToOippartBytes(pkg))
    const asset = Object.keys(entries).find((p) => p.startsWith('assets/'))!
    const back = await oippartBytesToFolder(zipSync({ ...entries, [asset]: new Uint8Array([0]) }))
    expect('error' in back && back.error).toMatch(/does not match its contents/)
  })
})
