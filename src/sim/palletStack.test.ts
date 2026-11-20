import type { PackageManifest } from '../core/parts/partPackage'
// A stack of empty pallets must stand.
//
// If a pallet's collider is a deck slab on nine blocks that stop at the deck's underside, each pallet in a stack
// stands on nine small feet pressing into the 29.5 mm deck below. That holds while a stack sleeps, but every wake
// settles it a little further into the penetration slop (the demo wakes all cargo whenever a deck starts). It
// leans, and once the feet on the low side get past the deck's midplane the contact normal flips and the stack
// falls through itself: the demo's second stock stack did this every run. So each block is a column up through
// the deck (bodyFactory.ts buildPalletShape), and a foot rests on 135 mm of solid.
//
// The poses below are that stack as the demo left it (relative to its bottom pallet), captured the moment before
// it fell: ~4 mm into each deck, leaning ~0.6 degrees at the top. Kept awake on the block-only collider it fell
// through itself within 2 s. They were captured on that collider; the current one (deck slab on block columns and three
// runners, core/pallet.ts) starts from them overlapping a little differently, settles ~5 mm per level deeper within
// 2 s, then holds. The second test is the stack as it actually stands, placed and let settle.

import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { registerPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import { PALLET_SIZE, SCENE_VERSION } from '../core/types'
import { PALLET_STANDARDS } from '../core/pallet'
import type { PartInstance } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

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
const PALLET_PKG = loadPkg('pallet')

/** [dx, y, dz, qx, qy, qz] per pallet, bottom first (qw from normalisation) */
const SETTLED_LEANING_STACK: readonly (readonly [number, number, number, number, number, number])[] = [
  [0.0, 0.0654, 0.0, 0.0001, 0, -0.0001],
  [0.0004, 0.1968, 0.0003, 0.0006, 0, -0.0002],
  [0.0013, 0.3286, 0.0009, -0.0007, 0, 0.0002],
  [0.0009, 0.4601, 0.0003, -0.0014, 0, 0.0007],
  [0.0001, 0.5911, -0.0008, -0.002, 0, 0.001],
  [-0.0008, 0.7228, -0.0014, -0.0021, 0, 0.0025],
  [-0.0024, 0.8565, -0.0025, -0.0034, 0, 0.0044],
  [-0.0045, 0.9909, -0.0039, -0.0041, 0, 0.0051],
]

type JoltAny = typeof Jolt & Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- reaches Jolt classes the typings omit
interface WorldInternals {
  boxes: { body: { GetID(): unknown; GetPosition(): { GetX(): number; GetY(): number; GetZ(): number } } }[]
  bodyInterface: { SetPositionAndRotation(id: unknown, p: unknown, q: unknown, a: unknown): void }
  system: { GetPhysicsSettings(): { mAllowSleeping: boolean }; SetPhysicsSettings(s: unknown): void }
}

/** Stands the captured stack up, keeps it awake for `seconds`, and returns how far the top pallet dropped (mm). */
function topDrop(seconds: number): number {
  const parts: PartInstance[] = SETTLED_LEANING_STACK.map((_, i) => createSdkPart(PALLET_PKG, `p${i}`, [0, PALLET_SIZE[1] * (i + 0.5), 0], 0))
  const world = new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages: [PALLET_PKG] }, { hz: 60 })
  const w = world as unknown as WorldInternals
  const J = Jolt as JoltAny
  // awake throughout: sleep would only postpone the question to the next wake
  const ps = w.system.GetPhysicsSettings()
  ps.mAllowSleeping = false
  w.system.SetPhysicsSettings(ps)
  w.boxes.forEach((b, i) => {
    const [dx, y, dz, qx, qy, qz] = SETTLED_LEANING_STACK[i]!
    const pos = new J.RVec3(dx, y, dz)
    const rot = new J.Quat(qx, qy, qz, Math.sqrt(1 - qx * qx - qy * qy - qz * qz))
    w.bodyInterface.SetPositionAndRotation(b.body.GetID(), pos, rot, J.EActivation_Activate)
    J.destroy(pos)
    J.destroy(rot)
  })
  const topOf = (): number => Math.max(...w.boxes.map((b) => b.body.GetPosition().GetY()))
  const start = topOf()
  let lowest = start
  for (let i = 0; i < 60 * seconds; i++) {
    world.step()
    lowest = Math.min(lowest, topOf())
  }
  world.dispose()
  return (start - lowest) * 1000
}

describe('a stack of empty pallets', () => {
  it('stands when it has settled into the decks and leans, instead of falling through itself', { timeout: 60000 }, () => {
    // measured: 31.5 mm at worst (2 s in), holding at 17 mm from 10 s on. With blocks that stop at the deck's
    // underside it drops 619 mm and the top pallet ends up most of the way to the floor. The bound separates
    // settling from falling through.
    expect(topDrop(20)).toBeLessThan(45)
  })

  // measured on the default size: 134.3-134.9 mm per level and the bottom pallet at 67.4 mm, i.e. within a
  // millimetre of resting on its full height everywhere
  for (const std of PALLET_STANDARDS) {
    it(`${std.label}: rests at its own height per level when stacked and left to settle`, { timeout: 60000 }, () => {
      const n = 8
      const parts: PartInstance[] = Array.from({ length: n }, (_, i) => {
        const p = createSdkPart(PALLET_PKG, `p${i}`, [0, PALLET_SIZE[1] * (i + 0.5) + 0.002 * i, 0], 0)
        p.params.size = std.value
        return p
      })
      const world = new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages: [PALLET_PKG] }, { hz: 60 })
      const w = world as unknown as WorldInternals
      for (let i = 0; i < 60 * 10; i++) world.step()
      const ys = w.boxes.map((b) => b.body.GetPosition().GetY()).sort((a, b) => a - b)
      const xz = w.boxes.map((b) => b.body.GetPosition()).map((q) => Math.hypot(q.GetX(), q.GetZ()))
      world.dispose()
      expect(ys[0]!).toBeGreaterThan(PALLET_SIZE[1] / 2 - 0.0015)
      for (let i = 1; i < n; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThan(PALLET_SIZE[1] - 0.0015)
      expect(Math.max(...xz)).toBeLessThan(0.01) // and nothing slid off the stack
    })
  }
})
