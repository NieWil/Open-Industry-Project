import type { PackageManifest } from '../core/parts/partPackage'
// A loaded pallet must stay on the deck it rides.
//
// A pallet stands on nine 0.1 m blocks under a load many times its own mass. With Jolt's default solver
// iterations that does not hold on a running conveyor: the blocks sink into the deck until the pallet's top
// board rests on it, ~12 cm down, where the rollers can no longer drive it. Measured with the defaults: the
// demo cell stalls at 29-40 Hz, and a 1050 kg load sinks at the default 60 Hz, a load a real EUR pallet carries
// routinely.
// SimWorld gives every pallet body a per-body solver iteration override (bodyFactory.ts PALLET_VELOCITY_STEPS);
// these pin that it holds across the step-rate range, and that the failure is still visible without it, so
// a green run means the override is doing the work rather than the scenario having gone easy.

import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { CARGO_KIND_PALLET } from '../core/frame'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { registerPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import { MAX_SIM_HZ, MIN_SIM_HZ, SCENE_VERSION } from '../core/types'
import type { PartInstance, SimRate } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()
const SLOW = { timeout: 60000 }

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const pkg = buildPackage(
    { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...((manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) },
    behavior.replace(/\r\n/g, '\n'),
  )
  registerPackage(pkg)
  return pkg
}
const ROLLER_PKG = loadPkg('roller-conveyor')
const BOX_PKG = loadPkg('box')
const PALLET_PKG = loadPkg('pallet')

/** the demo cell's load: three courses of five 0.6 x 0.4 x 0.4 m cases, interlocked */
const CASE_H = 0.4
const LAYER = [
  { dx: -0.3, dz: 0.3, turned: false }, { dx: 0.3, dz: 0.3, turned: false },
  { dx: -0.4, dz: -0.2, turned: true }, { dx: 0, dz: -0.2, turned: true }, { dx: 0.4, dz: -0.2, turned: true },
]
const DECK_Y = 1.0
const PALLET_REST_Y = DECK_Y + 0.0675 // deck top + half the 0.135 m pallet
const START_Z = 2.5

/**
 * A pallet carrying `load` kg in fifteen cases, riding a running 8 m roller deck for 4 s at `hz`, set down `shift` m
 * further along the deck than START_Z. Returns how far below its resting height the pallet ever got.
 * `withoutOverride` clears the pallet's solver override after build - the control that shows what the override is
 * holding back.
 */
function loadedPallet(hz: SimRate, load: number, withoutOverride = false, shift = 0): number {
  const deck = createSdkPart(ROLLER_PKG, 'deck', [0, DECK_Y, 0], Math.PI / 2)
  Object.assign(deck.params, { length: 8, width: 1.35, standHeight: DECK_Y, speed: 0.4, leftGuard: false, rightGuard: false })
  const pallet = createSdkPart(PALLET_PKG, 'pallet', [0, PALLET_REST_Y, START_Z + shift], 0)
  const parts: PartInstance[] = [deck, pallet]
  for (let course = 0; course < 3; course++) {
    const flip = course % 2 === 1 ? -1 : 1
    for (const c of LAYER) {
      const box = createSdkPart(BOX_PKG, `c${parts.length}`, [flip * c.dx, PALLET_REST_Y + 0.2675 + course * CASE_H, START_Z + shift + flip * c.dz], ((c.turned ? -1 : 0) + (flip < 0 ? 2 : 0)) * (Math.PI / 2))
      box.params.mass = load / 15
      parts.push(box)
    }
  }
  const world = new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages: [ROLLER_PKG, BOX_PKG, PALLET_PKG] }, { hz })
  if (withoutOverride) {
    type Body = { GetMotionProperties(): { SetNumVelocityStepsOverride(n: number): void; SetNumPositionStepsOverride(n: number): void } }
    for (const b of (world as unknown as { boxes: { body: Body; kind: number }[] }).boxes) {
      if (b.kind !== CARGO_KIND_PALLET) continue
      b.body.GetMotionProperties().SetNumVelocityStepsOverride(0)
      b.body.GetMotionProperties().SetNumPositionStepsOverride(0)
    }
  }
  let lowest = Infinity
  for (let i = 0; i < hz * 4; i++) {
    world.step()
    const f = world.frame()
    if (f.simTime < 0.25) continue // placement settling is not sinking
    for (let b = 0; b < f.count; b++) if (f.kinds[b] === CARGO_KIND_PALLET) lowest = Math.min(lowest, f.positions[b * 3 + 1]!)
  }
  world.dispose()
  return (PALLET_REST_Y - lowest) * 100
}

describe('a loaded pallet on a running roller deck', () => {
  it.each([MIN_SIM_HZ, 75, 144, MAX_SIM_HZ])('holds 1500 kg of cases at %i Hz without sinking into the deck', (hz) => {
    // measured with the override and blocks that stop at the deck's underside: worst 1.2 cm (60 Hz); a sunk
    // pallet reads ~13 cm. With full-height block columns (palletStack.test.ts) the 60 Hz run bobs a little
    // deeper as it crosses the rollers (0.7-1.8 cm, one 3.0 cm dip) while riding at full belt speed the whole way;
    // 75-1000 Hz stays at ~0.5 cm. The line is set against the failure, which stalls the pallet at 13 cm or worse.
    expect(loadedPallet(hz, 1500)).toBeLessThan(4)
  }, 60000)

  it('holds 1500 kg at 60 Hz from wherever it is set down', SLOW, () => {
    // 60 Hz is the marginal rate, and whether a load sinks there depends on where the pallet's blocks meet the
    // rollers when the contacts first load. One start position can pass by luck: with 40 velocity iterations 9 of
    // these 24 sank 4.2-6.2 cm (and 1-3 of 48 placements 2 mm apart went through the deck). So the claim is checked
    // over 10 cm of placements.
    const sunk: string[] = []
    for (let k = 0; k < 24; k++) {
      const cm = loadedPallet(MIN_SIM_HZ, 1500, false, k * 0.0042)
      if (cm >= 4) sunk.push(`${(k * 4.2).toFixed(1)} mm: ${cm.toFixed(1)} cm`)
    }
    expect(sunk).toEqual([])
  })

  it('sinks without the solver override, so the test above is watching the real failure', SLOW, () => {
    // measured at 1050 kg with blocks that stop at the deck's underside: 13.0 cm, the blocks all the way in and the
    // top board resting on the deck. Block columns resist that load better without the override (6.2 cm), so this uses the load the
    // test above holds: without the override it goes clean through the deck (100 cm), with it < 4 cm.
    expect(loadedPallet(MIN_SIM_HZ, 1500, true)).toBeGreaterThan(10)
  })
})
