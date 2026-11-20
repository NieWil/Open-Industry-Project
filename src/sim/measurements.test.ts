/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION, DEFAULT_SIM_HZ } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..') // src/sim → repo root

/** Build a package from a committed example part (its real rig.json + behavior.ts). */
function loadExample(dir: string): { manifest: PackageManifest; behavior: string } {
  const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as {
    id: string
    name: string
    category?: string
    geometry: PackageManifest['geometry']
  }
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return { manifest: { id: rig.id, name: rig.name, category: rig.category, geometry: rig.geometry }, behavior }
}

// A spawner high above a large despawner zone: boxes spawn at y=6, fall, and complete (despawn) in the zone.
// It drives the throughput/cycle/WIP counters through the real shipped SDK parts (examples/parts/{box-spawner,despawner}). The despawner's
// `mouth` zone spans world Y [py, py+height], so height 4 at py 0 catches every box on its way down.
function line(): SimWorld {
  const sp = loadExample('box-spawner')
  const dp = loadExample('despawner')
  const spPkg = buildPackage(sp.manifest, sp.behavior)
  const dpPkg = buildPackage(dp.manifest, dp.behavior)
  // the spawner's product, handed to the world as the editor's forSim hands it to the worker
  const box = loadExample('box')
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [spPkg, dpPkg, buildPackage(box.manifest, box.behavior)],
    parts: [
      { id: 's', type: 'part', packageId: sp.manifest.id, position: [0, 6, 0], rotationY: 0, params: { boxesPerMinute: 200 } },
      { id: 'd', type: 'part', packageId: dp.manifest.id, position: [0, 0, 0], rotationY: 0, params: { length: 4, width: 4, height: 4 } },
    ],
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

afterEach(() => clearPackages())

describe('SimCore determinism', () => {
  it('same scene + seed → identical run (seeded RNG + fixed timestep)', () => {
    const a = line()
    const b = line()
    for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) {
      a.step()
      b.step()
    }
    expect(a.measurements()).toEqual(b.measurements())
    const fa = a.frame()
    const fb = b.frame()
    expect(fa.count).toBe(fb.count)
    expect(Array.from(fa.positions)).toEqual(Array.from(fb.positions))
    a.dispose()
    b.dispose()
  })
})

describe('SimCore measurements', () => {
  it('reports throughput, cycle time, and WIP from a spawn→despawn line', () => {
    const w = line()
    for (let i = 0; i < DEFAULT_SIM_HZ * 5; i++) w.step()
    const m = w.measurements()

    expect(m.simSeconds).toBeCloseTo(5, 1)
    expect(m.spawnedTotal).toBeGreaterThan(0)
    expect(m.completedTotal).toBeGreaterThan(0) // boxes fell into the despawner zone
    expect(m.throughputPerMin).toBeGreaterThan(0) // completions / min
    expect(m.spawnThroughputPerMin).toBeGreaterThan(0)
    expect(m.avgCycleSeconds).toBeGreaterThan(0) // spawn → despawn fall time
    expect(m.avgCycleSeconds).toBeLessThan(5)
    expect(m.liveCount).toBeGreaterThanOrEqual(0)
    w.dispose()
  })

  // The line's numbers come from the parts: the despawner and spawner publish them as displays. On a one-sink
  // line they must agree exactly with the engine's own tally, the cycle time especially, since ctx.zoneAge is
  // the only way a part can read a body's age.
  it('the spawner and despawner displays agree with the engine on a one-sink line', () => {
    const w = line()
    for (let i = 0; i < DEFAULT_SIM_HZ * 5; i++) w.step()
    const m = w.measurements()
    const d = w.frame().displays ?? {}
    expect(m.completedTotal).toBeGreaterThan(0)
    expect(d.d?.count).toBe(m.completedTotal)
    expect(d.d?.cycle as number).toBeCloseTo(m.avgCycleSeconds, 9)
    expect(d.d?.rate as number).toBeCloseTo(m.throughputPerMin, 9)
    expect(d.s?.spawned).toBe(m.spawnedTotal)
    expect(String(d.d?.readout)).toContain(`${m.completedTotal} done`)
    w.dispose()
  })

  it('measurements are reproducible across runs', () => {
    const run = (): unknown => {
      const w = line()
      for (let i = 0; i < DEFAULT_SIM_HZ * 5; i++) w.step()
      const m = w.measurements()
      w.dispose()
      return m
    }
    expect(run()).toEqual(run())
  })
})
