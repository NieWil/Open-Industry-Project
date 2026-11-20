import { afterEach, describe, expect, it } from 'vitest'
import { validatePartPackage } from '../../core/parts/partValidate'
import { buildPackage, packageToWorkspaceFiles } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'
import { parsePartBytes, parsePartText, serializePart } from './partFile'
import { partToOippartBytes } from '../../core/parts/partArchive'
import { withOrigin } from '../../core/parts/partOrigin'
import { unregisterPackage } from '../../core/parts/partRegistry'
import { folderFilesToProject, projectToFolderFiles } from '../../core/project/projectFolder'
import { PROJECT_VERSION } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import { bakePart } from './bakePart'
import { importScannedParts } from './packageSource'
import { EditorStore } from '../store/store'

// the same minimal authored part the sim package tests use (the guide's smallest conveyor)
const behaviorSource = `
definePart({
  params: {
    speed: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.1, label: 'Belt speed (m/s)' },
    reverse: { type: 'boolean', default: false, label: 'Reverse direction' },
  },
  step(ctx) {
    const dir = ctx.params.reverse ? -1 : 1
    const s = ctx.params.speed * dir
    ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
  },
})
`
const manifest: PackageManifest = {
  id: 'oip.powered-deck',
  name: 'Powered Deck',
  category: 'Equipment',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } },
}

describe('part file export/import (.part.json)', () => {
  it('round-trips a package: serialize → parse rebuilds an identical, valid package', () => {
    const pkg = buildPackage(manifest, behaviorSource)
    const res = parsePartText(serializePart(pkg))
    if ('error' in res) throw new Error(res.error)
    expect(validatePartPackage(res.pkg)).toEqual([])
    expect(res.pkg).toEqual(pkg) // params re-baked from the behavior, geometry/assets carried verbatim
  })

  it('reads the older .part.json shape (manifest + behaviorSource)', () => {
    const res = parsePartText(JSON.stringify({ ...manifest, behaviorSource }))
    if ('error' in res) throw new Error(res.error)
    expect(res.pkg.id).toBe('oip.powered-deck')
    expect(res.pkg.params).toHaveProperty('speed')
  })

  it('accepts a full serialized PartPackage (behavior + baked fields) and re-bakes it', () => {
    const pkg = buildPackage(manifest, behaviorSource)
    // tamper the baked params: the import must re-derive them from the behavior, not trust the file
    const tampered = { ...pkg, params: { bogus: { type: 'number', default: 1 } } }
    const res = parsePartText(JSON.stringify(tampered))
    if ('error' in res) throw new Error(res.error)
    expect(res.pkg.params).toHaveProperty('speed')
    expect(res.pkg.params).not.toHaveProperty('bogus')
  })

  it('rejects non-JSON, non-part JSON, and an invalid behavior with readable errors', () => {
    expect(parsePartText('not json {')).toHaveProperty('error', 'File is not valid JSON')
    expect(parsePartText('{"hello": 1}')).toHaveProperty('error', 'Not a part file (no behavior script found)')
    const bad = parsePartText(JSON.stringify({ ...manifest, behaviorSource: 'this is not valid js (' }))
    expect('error' in bad && bad.error.length > 0).toBe(true)
  })
})

// docs/part-sources.md step 8: where a part came from (`origin`, core/parts/partOrigin.ts) is part of its manifest, so it
// travels with the part by every route a person can carry one, and the receiving project can still say "update
// available" against the same shelf or built-in. Nothing re-stamps it on the way in.
describe('a part keeps its origin on every import route', () => {
  const stamped = withOrigin(withOrigin(buildPackage(manifest, behaviorSource), 'shelf', 'shelf-fp'), 'app', 'app-fp')
  const ORIGIN = { shelf: 'shelf-fp', app: 'app-fp' }
  afterEach(() => unregisterPackage(stamped.id))

  it('a .part.json', () => {
    const res = parsePartText(serializePart(stamped))
    if ('error' in res) throw new Error(res.error)
    expect(res.pkg.origin).toEqual(ORIGIN)
  })

  it('a folder import (Import part > A folder of parts…), into the library', () => {
    const store = new EditorStore()
    const { manifestJson, behaviorJs } = packageToWorkspaceFiles(stamped)
    importScannedParts(store, { root: 'C:/p', parts: [{ dir: 'C:/p/a', id: stamped.id, name: stamped.name, manifestJson, behaviorSource: behaviorJs }], problems: [] })
    expect(store.getState().userPackages.find((p) => p.id === stamped.id)?.origin).toEqual(ORIGIN)
  })

  it('a project folder or .oip', () => {
    const files = projectToFolderFiles({ version: PROJECT_VERSION, name: 'P', packages: [stamped], scene: { version: SCENE_VERSION, parts: [] } })
    const res = folderFilesToProject(files, { bakePart })
    if (!res.ok) throw new Error(res.errors.join('; '))
    expect(res.project.packages?.[0]?.origin).toEqual(ORIGIN)
  })
})

describe('.oippart import (core/parts/partArchive.ts)', () => {
  it('reads a part folder zipped, and still reads the older .part.json text by its first bytes', async () => {
    const pkg = buildPackage(manifest, behaviorSource)
    const zipped = await parsePartBytes(await partToOippartBytes(pkg))
    if ('error' in zipped) throw new Error(zipped.error)
    expect(zipped.pkg).toEqual(pkg)
    const text = await parsePartBytes(new TextEncoder().encode(serializePart(pkg)))
    if ('error' in text) throw new Error(text.error)
    expect(text.pkg).toEqual(pkg)
  })
})
