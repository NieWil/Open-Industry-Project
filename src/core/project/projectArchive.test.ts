import { describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../types'
import { createPart } from '../scene/scene'
import type { PartPackage } from '../parts/partPackage'
import { PROJECT_VERSION, serializeProject, validateProject } from './project'
import type { ProjectJSON } from './project'
import type { PartBaker } from './projectFolder'
import { assetFileName, bytesToBase64 } from '../parts/partAssets'
import { isZipData, oipBytesToProject, projectToOipBytes } from './projectArchive'
import { PACKAGE_FORMAT } from '../parts/partPackage'

/** mirrors projectFolder.test.ts: a minimal real package + a no-exec stand-in for sim/validatePart */
function samplePackage(id = 'acme.widget'): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Widget',
    params: {},
    behavior: 'definePart(() => ({}))',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
}

const testBaker: PartBaker = (manifestJson, behaviorJs) => {
  const m = JSON.parse(manifestJson) as { id: string; name: string; geometry: PartPackage['geometry'] }
  return { package: { format: PACKAGE_FORMAT, id: m.id, name: m.name, params: {}, behavior: behaviorJs, geometry: m.geometry } }
}

function sampleProject(): ProjectJSON {
  return {
    version: PROJECT_VERSION,
    name: 'Ziploc',
    packages: [samplePackage()],
    scene: { version: SCENE_VERSION, parts: [createPart('group', 'rc_1', [0, 0, 0])] },
    stProgram: 'PROGRAM Main\nEND_PROGRAM\n',
  }
}

describe('.oip archive codec', () => {
  it('round-trips: zip → unzip → the same normalized document', async () => {
    const project = sampleProject()
    const bytes = await projectToOipBytes(project)
    expect(isZipData(bytes)).toBe(true)
    const back = await oipBytesToProject(bytes, { bakePart: testBaker })
    if (!back.ok) throw new Error(back.errors.join('; '))
    const normalized = validateProject(JSON.parse(serializeProject(project)))
    if (!normalized.ok) throw new Error(normalized.errors.join('; '))
    expect(serializeProject(back.project)).toBe(serializeProject(normalized.project))
  })

  it('is byte-reproducible: the same project encodes to the identical archive', async () => {
    const a = await projectToOipBytes(sampleProject())
    const b = await projectToOipBytes(sampleProject())
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('sniffs formats: JSON text is not zip data', () => {
    expect(isZipData(new TextEncoder().encode(serializeProject(sampleProject())))).toBe(false)
    expect(isZipData(new TextEncoder().encode('  {"version":2}'))).toBe(false)
  })

  it('rejects corrupt bytes as "not a valid .oip archive"', async () => {
    const result = await oipBytesToProject(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('.oip archive')
  })

  it('a zip that is not a project reports "not a project folder"', async () => {
    const { strToU8, zipSync } = await import('fflate')
    const notAProject = zipSync({ 'readme.txt': strToU8('hello') })
    const result = await oipBytesToProject(notAProject)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('not a project folder')
  })
})

describe('.oip archive: part asset files', () => {
  it('zips an embedded asset as its own entry and reads it back into the part', async () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 0xff, 0x00, 0x80])
    const pkg: PartPackage = { ...samplePackage('acme.modelled'), assets: [{ id: 'body', mime: 'model/gltf-binary', data: bytesToBase64(glb) }] }
    const bytes = await projectToOipBytes({ ...sampleProject(), packages: [pkg] })
    const { unzipSync } = await import('fflate')
    const entries = unzipSync(bytes)
    expect(entries[`parts/acme.modelled/assets/${assetFileName(glb, 'model/gltf-binary')}`]).toEqual(glb)
    expect(new TextDecoder().decode(entries['parts/acme.modelled/manifest.json'])).not.toContain('"data"')
    let seen: unknown
    const back = await oipBytesToProject(bytes, {
      bakePart: (manifestJson, behaviorJs) => {
        seen = (JSON.parse(manifestJson) as { assets?: unknown }).assets
        return testBaker(manifestJson, behaviorJs)
      },
    })
    if (!back.ok) throw new Error(back.errors.join('; '))
    expect(seen).toEqual(pkg.assets)
  })
})
