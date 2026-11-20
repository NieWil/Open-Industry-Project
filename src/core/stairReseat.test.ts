import { afterEach, describe, expect, it } from 'vitest'
import { reseatOlderStairs, STAIRS_PACKAGE_ID } from './stairReseat'
import { clearPackages, registerPackage } from './parts/partRegistry'
import { PACKAGE_FORMAT } from './parts/partPackage'
import type { PartPackage } from './parts/partPackage'
import { validateScene } from './scene/scene'
import type { PartInstance } from './types'
import { SCENE_VERSION, STAIRS_LANDING_DEPTH, STAIRS_STANDARD_RISE, STAIRS_STANDARD_TREAD } from './types'

// fixtures shaped like the shipped platform (a `deck` surface with a heightParam) and stairs (an edgeMount whose
// contact is the top of the run, `at[0]` = seatX past it)
function platformPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT, id: 'acme.platform', name: 'Platform',
    params: { length: { type: 'number', default: 4 }, width: { type: 'number', default: 4 }, height: { type: 'number', default: 2 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.006, 4] }, offset: [0, -0.003, 0], notchable: true }], joints: [], bounds: { length: 4, width: 4, top: 1.07 } },
    snap: { surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width', heightParam: 'height' }] },
  } as unknown as PartPackage
}
function stairsPkg(seatX = 0): PartPackage {
  return {
    format: PACKAGE_FORMAT, id: STAIRS_PACKAGE_ID, name: 'Stairs',
    params: { numSteps: { type: 'number', default: 11, min: 2, max: 40 }, width: { type: 'number', default: 1.2 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'tread', shape: { kind: 'box', size: [0.3, 0.05, 1.2] }, offset: [0.14, 0.178, 0] }], joints: [], bounds: { length: 3.18, width: 1.4, top: 3 } },
    snap: {
      edgeMount: {
        accepts: 'deck', alongParam: 'width', reach: 3, facing: 'into', at: [seatX, 0, 0],
        atParams: [{ axis: 0, param: 'numSteps', scale: STAIRS_STANDARD_TREAD }, { axis: 1, param: 'numSteps', scale: STAIRS_STANDARD_RISE }],
        fromFloor: { param: 'numSteps' }, opens: true, notch: true, lift: true,
      },
    },
  } as unknown as PartPackage
}
const platform = (): PartInstance =>
  ({ id: 'p', type: 'part', packageId: 'acme.platform', position: [0, 2, 0], rotationY: 0, params: { length: 4, width: 4, height: 2 } }) as unknown as PartInstance
const stair = (x: number, z = 0): PartInstance =>
  ({ id: 's', type: 'part', packageId: STAIRS_PACKAGE_ID, position: [x, 0, z], rotationY: Math.PI, params: { numSteps: 11, width: 1.2 } }) as unknown as PartInstance

const RUN = 11 * STAIRS_STANDARD_TREAD
const OLD_SEAT = 2 + RUN + STAIRS_LANDING_DEPTH // an older app's snap: the landing's far end on the +X edge (x = 2)
const NEW_SEAT = 2 + RUN

describe('reseatOlderStairs - a stair an older app seated by its own landing moves onto the deck edge', () => {
  afterEach(() => clearPackages())
  const setup = (seatX = 0): void => {
    registerPackage(platformPkg())
    registerPackage(stairsPkg(seatX), true)
  }

  it('moves a stair standing a landing depth off the edge in along its own +X, onto the edge', () => {
    setup()
    const parts = [platform(), stair(OLD_SEAT)]
    expect(reseatOlderStairs(parts, new Set())).toEqual([1])
    expect(parts[1]!.position[0]).toBeCloseTo(NEW_SEAT, 9)
    expect(parts[1]!.position[1]).toBe(0)
    // a second run is a no-op: the moved stair meets the edge
    expect(reseatOlderStairs(parts, new Set())).toEqual([])
  })

  it('leaves a stair already on the edge, a freestanding one, and one a project runs its own copy of', () => {
    setup()
    expect(reseatOlderStairs([platform(), stair(NEW_SEAT)], new Set())).toEqual([])
    expect(reseatOlderStairs([platform(), stair(OLD_SEAT, 9)], new Set())).toEqual([])
    expect(reseatOlderStairs([platform(), stair(OLD_SEAT)], new Set([STAIRS_PACKAGE_ID]))).toEqual([])
  })

  it('does nothing under an app whose stairs still seat their landing end', () => {
    setup(STAIRS_LANDING_DEPTH)
    expect(reseatOlderStairs([platform(), stair(OLD_SEAT)], new Set())).toEqual([])
  })

  // the scene embeds an older copy of the stairs (seated by its landing end): the app's built-in is what runs
  it('runs on load, and says so', () => {
    setup()
    const r = validateScene({ version: SCENE_VERSION, parts: [platform(), stair(OLD_SEAT)], packages: [platformPkg(), stairsPkg(STAIRS_LANDING_DEPTH)] })
    expect(r.ok ? [] : r.errors).toEqual([])
    if (!r.ok) return
    expect(r.scene.parts[1]!.position[0]).toBeCloseTo(NEW_SEAT, 9)
    expect(r.repairs?.some((m) => m.startsWith('parts[1]') && m.includes('onto the deck edge'))).toBe(true)
  })
})
