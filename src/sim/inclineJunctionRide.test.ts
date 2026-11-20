import type { PackageManifest } from '../core/parts/partPackage'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON, SdkPart } from '../core/types'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { registerPackage } from '../core/parts/partRegistry'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// A carton riding flat -> incline -> flat on three roller conveyors, joined the way the incline end-mate seats
// them (docs/conveyor-incline.md). A roller bed is rigid, so a grade change is two separate decks meeting at an
// angle: a concave joint at the foot, a convex crest at the top. Nothing here merges those decks, and Jolt's
// internal-edge smoothing does not span separate bodies, which is how an unmerged guard seam kicks cargo
// (guardRunMerge.test.ts). So the joints were measured first. At 1 m/s, a 0.3 x 0.4 x 0.3 m box:
//
//   tilt  crosses   foot: slowest / hop        crest: speed range / peak vy (steady climb)   lateral
//    5    yes       0.79 m/s / 0.9 mm           1.00-1.22 / 0.09 (0.09)                        1.2 mm
//   10    yes       0.74     / 0.8 mm           0.53-1.39 / 0.47 (0.17)                        1.5 mm
//   15    yes       0.72     / 0.2 mm           0.86-1.44 / 0.26 (0.26)                        2.1 mm
//   20    yes       0.62     / 0.15 mm          0.61-1.46 / 0.42 (0.34)                        1.0 mm
//   25    STALLS 0.5 m up the incline;   30   STALLS at the foot
//
// The foot and lateral columns are the worst over eight start positions spread across one 60 Hz step (16.7 mm of
// travel at 1 m/s); the crest columns are from one start: what the box does at the foot depends on where the step lands against the joint. The foot is
// clean: the box slows as it pivots onto the slope (its centre rises more than it advances), never stops, and its
// nose meeting the slope lifts it at most ~0.13 m/s faster than the steady climb, a hop of about 1 mm. A seam ram
// pops a box tens of mm (guardRunMerge.test.ts). The crest is a real crest: the box tips over the edge, lurches forward,
// at some angles bounces a few mm, then settles on the flat at belt speed; a carton over a sharp roller crest
// does that too, which is why belts use a filleted nose-over (the belt part's `segments`). Above ~20 degrees
// the carton slips back on the rollers: friction, not a snag, and the right lesson (use a belt), so it is
// pinned too, even though the Inspector allows a roller 30 degrees.

const Jolt = await initJolt()
const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const m = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!m || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const pkg = buildPackage({ id: m.id, name: m.name, geometry: m.geometry, ...(m.materials ? { materials: m.materials } : {}), ...((m as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (m as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) }, behavior.replace(/\r\n/g, '\n'))
  registerPackage(pkg)
  return pkg
}
const ROLLER = loadPkg('roller-conveyor')
loadPkg('box')

const Y = 0.75
const L = 3
const HY = 0.2 // box half-height (0.3 x 0.4 x 0.3 m box)
const DT = 1 / 60

function roller(id: string, x: number, y: number, tiltDeg: number): SdkPart {
  const p = createSdkPart(ROLLER, id, [x, y, 0], 0)
  Object.assign(p.params, { length: L, width: 0.6, speed: 1, leftGuard: true, rightGuard: true, skew: 0, tiltDeg })
  return p
}

interface Zone { vxMin: number; vyMax: number; vyMin: number; n: number }
interface Ride { crossed: boolean; finalX: number; maxLateral: number; zones: Record<string, Zone>; steadyVy: number }

/** ride a box from the flat infeed over an incline of `tiltDeg` and onto the flat discharge */
function ride(tiltDeg: number, shift = 0): Ride {
  const th = (tiltDeg * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  // A's head at x = 0; B's tail on it, its head at (L·cos, Y + L·sin); C's tail on B's head (the snap geometry)
  const topX = L * c
  const topY = Y + L * s
  const parts = [roller('a', -L / 2, Y, 0), roller('b', (L / 2) * c, Y + (L / 2) * s, tiltDeg), roller('c', topX + L / 2, topY, 0)]
  const world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: parts as PartInstance[] } as SceneJSON)
  world.spawnBoxAt(-2.4 + shift, Y + HY + 0.01, 0, 0.15, HY, 0.15)
  const zoneOf = (x: number): string | null =>
    Math.abs(x) < 0.35 ? 'foot' : Math.abs(x - topX) < 0.35 ? 'crest' : x > topX + 0.6 && x < topX + 2.2 ? 'discharge' : null
  const zones: Record<string, Zone> = {}
  let px = NaN
  let py = NaN
  let maxLateral = 0
  let crossed = false
  for (let i = 0; i < 900; i++) {
    world.step()
    const f = world.frame()
    const x = f.positions[0]!
    const y = f.positions[1]!
    if (x > topX + L - 0.4) break // stop before it runs off the end of the discharge
    maxLateral = Math.max(maxLateral, Math.abs(f.positions[2]!))
    if (x > topX + 0.8) crossed = true
    const k = zoneOf(x)
    if (k && !Number.isNaN(px)) {
      const vx = (x - px) / DT
      const vy = (y - py) / DT
      const z = (zones[k] ??= { vxMin: Infinity, vyMax: -Infinity, vyMin: Infinity, n: 0 })
      z.vxMin = Math.min(z.vxMin, vx)
      z.vyMax = Math.max(z.vyMax, vy)
      z.vyMin = Math.min(z.vyMin, vy)
      z.n++
    }
    px = x
    py = y
  }
  const finalX = world.frame().positions[0]!
  world.dispose()
  return { crossed, finalX, maxLateral, zones, steadyVy: s /* 1 m/s along the slope */ }
}

describe('a carton over a roller grade change (flat -> incline -> flat)', () => {
  for (const tilt of [5, 15, 20]) {
    it(`${tilt} deg: crosses both joints with no snag, and settles on the discharge at belt speed`, { timeout: 120000 }, () => {
      // eight start positions across one step of travel (see the header)
      for (let k = 0; k < 8; k++) {
        const shift = (k * DT) / 8
        const at = `${tilt} deg, start +${(shift * 1000).toFixed(1)} mm`
        const r = ride(tilt, shift)
        expect(r.crossed, at).toBe(true)
        expect(r.maxLateral, at).toBeLessThan(0.01) // no seam ram knocking it sideways
        const foot = r.zones.foot!
        expect(foot.n, at).toBeGreaterThan(0)
        expect(foot.vxMin, at).toBeGreaterThan(0.5) // slows while pivoting onto the slope, never stops
        const kick = Math.max(0, foot.vyMax - r.steadyVy)
        expect((kick * kick) / (2 * 9.81), at).toBeLessThan(0.002) // lifted past the steady climb by at most a 2 mm hop
        const out = r.zones.discharge!
        expect(out.n, at).toBeGreaterThan(0)
        expect(out.vxMin, at).toBeGreaterThan(0.95) // riding the discharge at belt speed again
        expect(Math.max(out.vyMax, -out.vyMin), at).toBeLessThan(0.02) // settled, not bouncing
      }
    })
  }

  it('30 deg: the carton slips back on the rollers and never reaches the top (use a belt)', { timeout: 120000 }, () => {
    const r = ride(30)
    expect(r.crossed).toBe(false)
    expect(r.finalX).toBeLessThan(1) // stalled at the foot of the incline
  })
})
