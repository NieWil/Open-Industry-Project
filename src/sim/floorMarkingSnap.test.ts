import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { validatePartPackage } from '../core/parts/partValidate'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { findSnap, type SnapPose } from '../core/snap/snapFeatures'
import type { SdkPart } from '../core/types'

// End-to-end test that the shipped SDK Floor Marking (oip.floor-marking) snaps edge-to-edge via the declarative
// `edges` kind (docs/part-snap-edges.md). It reads the same committed files the app bundles
// (examples/parts/floor-marking/{rig.json, behavior.ts}) and runs them through the same buildPackage the app's
// bundledExamples uses. So it covers the whole pipeline on the real first-party part: the committed behavior bakes
// snap.edges, buildPackage extracts it, and the real snap engine tiles the part identically to the built-in floor
// marking it re-authors.
const dir = fileURLToPath(new URL('../../examples/parts/floor-marking/', import.meta.url))
const manifest = JSON.parse(readFileSync(`${dir}rig.json`, 'utf8')) as PackageManifest
const behavior = readFileSync(`${dir}behavior.ts`, 'utf8')
const markingPackage = () => buildPackage(manifest, behavior)

const sdk = (id: string, x: number, z: number, rot = 0): SdkPart =>
  ({ id, type: 'part', packageId: 'oip.floor-marking', position: [x, 0, z], rotationY: rot, params: { length: 2, width: 8 } }) as unknown as SdkPart

describe('shipped SDK Floor Marking edge-to-edge snapping (real bundled part → edges kind)', () => {
  afterEach(() => clearPackages())

  it('bakes snap.edges into the package from the committed behavior source', () => {
    const pkg = markingPackage()
    expect(validatePartPackage(pkg)).toEqual([])
    expect(pkg.snap?.tile?.group).toBe('floorMarking')
    expect(pkg.snap?.tile?.lengthParam).toBe('length')
    expect(pkg.snap?.tile?.widthParam).toBe('width')
    expect(pkg.snap?.tile?.cornerFlush).toBe(true)
  })

  it('tiles two shipped markings flush along a shared edge in the real snap engine', () => {
    registerPackage(markingPackage())
    const drop: SnapPose = { position: [2.05, 0, 0.3], rotationY: 0.05 } // just past the target's +X edge (x=1)
    const snap = findSnap(sdk('m', 99, 99), drop, [sdk('t', 0, 0)])
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('t')
    expect(snap!.pose.position[0]).toBeCloseTo(2, 6) // mover's −X edge butts the target's +X edge
    expect(snap!.pose.position[2]).toBeCloseTo(0.3, 6) // slid along the edge to the cursor
    expect(snap!.pose.rotationY).toBeCloseTo(0, 6)
  })
})
