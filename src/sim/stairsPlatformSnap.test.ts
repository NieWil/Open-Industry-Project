import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { validatePartPackage } from '../core/parts/partValidate'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { findSnap, type SnapPose } from '../core/snap/snapFeatures'
import { STAIRS_STANDARD_TREAD } from '../core/types'
import type { SdkPart } from '../core/types'
import { angleDiff, forwardXZ } from '../core/math'

// End-to-end test that the shipped SDK Stairs (oip.stairs) snap onto the shipped SDK Platform (oip.platform)
// via the declarative `edgeMount` (facing into the deck, from the floor) + deck `surfaces` kinds: the
// stairs-to-platform snap. It reads the same committed files the app bundles and runs them through the same
// buildPackage the app's bundledExamples uses, so it covers the whole pipeline on the real first-party parts: the
// platform's committed behavior bakes a `deck` surface with a heightParam, the stairs' bakes snap.edgeMount, buildPackage extracts
// both, and the real snap engine sizes + seats the flight (docs/part-snap-stairs.md).
const load = (dir: string): { manifest: PackageManifest; behavior: string } => {
  const base = fileURLToPath(new URL(`../../examples/parts/${dir}/`, import.meta.url))
  return {
    manifest: JSON.parse(readFileSync(`${base}rig.json`, 'utf8')) as PackageManifest,
    behavior: readFileSync(`${base}behavior.ts`, 'utf8'),
  }
}
const stairsPackage = () => { const { manifest, behavior } = load('stairs'); return buildPackage(manifest, behavior) }
const platformPackage = () => { const { manifest, behavior } = load('platform'); return buildPackage(manifest, behavior) }

// a platform instance sits with its deck top at world y = height (floor-rested); a stairs instance's origin is
// its foot (world y = the floor it stands on).
const platform = (id: string, x: number, z: number, height = 2, rot = 0): SdkPart =>
  ({ id, type: 'part', packageId: 'oip.platform', position: [x, height, z], rotationY: rot, params: { length: 4, width: 4, height } }) as unknown as SdkPart
const stairs = (id: string, x: number, z: number, numSteps = 5, rot = 0): SdkPart =>
  ({ id, type: 'part', packageId: 'oip.stairs', position: [x, 0, z], rotationY: rot, params: { numSteps, width: 1.2 } }) as unknown as SdkPart

describe('shipped SDK Stairs ↔ Platform snapping (real bundled parts → edgeMount into a deck surface)', () => {
  afterEach(() => clearPackages())

  it('bakes the deck surface (with heightParam) and the edgeMount from the committed behavior sources', () => {
    const plat = platformPackage()
    const stair = stairsPackage()
    expect(validatePartPackage(plat)).toEqual([])
    expect(validatePartPackage(stair)).toEqual([])
    const deck = plat.snap?.surfaces?.find((s) => s.kind === 'deck')
    expect(deck).toBeTruthy()
    expect(deck?.heightParam).toBe('height')
    expect(stair.snap?.edgeMount).toMatchObject({ accepts: 'deck', alongParam: 'width', facing: 'into', fromFloor: { param: 'numSteps' }, opens: true, notch: true, lift: true })
  })

  it('seats a flight onto a real platform: top on the edge, foot on the floor, sized to the deck', () => {
    registerPackage(platformPackage())
    registerPackage(stairsPackage())
    // 4×4 platform, height 2 → deck top at y=2, floor at y=0. Steps = round(2/0.178) = 11; run = 11*0.28 = 3.08.
    const steps = 11
    const drop: SnapPose = { position: [4.8, 0, 0], rotationY: 0 } // foot dropped just outside the +X deck edge (x=2)
    const snap = findSnap(stairs('m', 99, 99, 5), drop, [platform('t', 0, 0, 2)])
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('t')
    // foot `run` outward: the top of the flight butts the edge (the whole flight outside the deck, which is its landing)
    expect(snap!.pose.position[0]).toBeCloseTo(2 + steps * STAIRS_STANDARD_TREAD, 6)
    expect(snap!.pose.position[1]).toBeCloseTo(0, 6) // foot on the platform's floor
    expect(snap!.pose.position[2]).toBeCloseTo(0, 6)
    expect(Math.abs(angleDiff(snap!.pose.rotationY, Math.PI))).toBeCloseTo(0, 6) // ascends into the deck (−X)
    expect(forwardXZ(snap!.pose.rotationY).x).toBeCloseTo(-1, 6)
    expect(snap!.paramOverrides).toEqual({ numSteps: steps }) // flight resized to reach the deck
    expect(snap!.junction.y).toBeCloseTo(2, 6) // cue on the deck edge at the deck top
  })

  it('sizes to a shorter platform (fewer steps) and lands the foot on that platform’s floor', () => {
    registerPackage(platformPackage())
    registerPackage(stairsPackage())
    const steps = 6 // round(1/0.178)
    const snap = findSnap(stairs('m', 99, 99, 11), { position: [3.2, 0, 0], rotationY: 0 }, [platform('t', 0, 0, 1)])
    expect(snap).not.toBeNull()
    expect(snap!.paramOverrides).toEqual({ numSteps: steps })
    expect(snap!.pose.position[0]).toBeCloseTo(2 + steps * STAIRS_STANDARD_TREAD, 6)
    expect(snap!.pose.position[1]).toBeCloseTo(0, 6) // deck top 1 − height 1 = floor 0
  })
})
