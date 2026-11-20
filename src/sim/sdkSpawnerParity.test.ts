/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { CARGO_KIND_PALLET } from '../core/frame'
import { clearPackages } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION, DEFAULT_SIM_HZ } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// The SDK Box/Pallet Spawners (examples/parts/{box-spawner,palletSpawner}) at built-in
// parity. Unlike the render-layer rig-parity tests (which pin the artifact shape), this drives the real shipped
// behaviors headlessly in a SimWorld and asserts the runtime behaviors parity requires:
//   • the first cargo drops on the first sim tick, not after a full period;
//   • boxColors cycles one colour per box (randomColors → a random draw from the list);
//   • randomSize varies each box within the min/max random-size range;
//   • fixedRate off still holds the mean rate (±50% per-interval jitter averages out);
//   • the pallet spawner emits real pallet cargo and a pilot "Use" toggles the line off/on.
// The behaviors are read from the committed example files so a drift between the shipped part and this test is a
// test failure, not a silent divergence.

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

/** A part of the Containers library (libraries/containers), from its source. */
function loadContainersPart(dir: string): { manifest: PackageManifest; behavior: string } {
  const at = join(repo, 'libraries', 'containers', dir)
  return { manifest: JSON.parse(readFileSync(join(at, 'manifest.json'), 'utf8')) as PackageManifest, behavior: readFileSync(join(at, 'behavior.js'), 'utf8') }
}

/** A SimWorld with a single spawner instance placed high (cargo falls clear, nothing culls in a short run). */
function spawnerWorld(dir: string, params: Record<string, unknown>, y = 5): SimWorld {
  const { manifest, behavior } = loadExample(dir)
  const pkg = buildPackage(manifest, behavior)
  // the spawners' products, handed to the world as the editor's forSim hands them to the worker
  const products = [loadExample('box'), loadExample('pallet'), loadContainersPart('tote')].map((e) => buildPackage(e.manifest, e.behavior))
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [pkg, ...products],
    parts: [{ id: 'sp', type: 'part', packageId: manifest.id, position: [0, y, 0], rotationY: 0, params }],
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

/** [r,g,b] of the i-th cargo body in spawn order (frame() lists boxes oldest-first). */
function colorOf(w: SimWorld, i: number): [number, number, number] {
  const f = w.frame()
  return [f.colors[i * 3]!, f.colors[i * 3 + 1]!, f.colors[i * 3 + 2]!]
}
/** [hx,hy,hz] half-extents of the i-th cargo body. */
function sizeOf(w: SimWorld, i: number): [number, number, number] {
  const f = w.frame()
  return [f.halfExtents[i * 3]!, f.halfExtents[i * 3 + 1]!, f.halfExtents[i * 3 + 2]!]
}

describe('SDK spawner sim parity (first-tick / colours / random size / jitter / pallet Use)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('drops the first box on the first sim tick, not after a full period', () => {
    world = spawnerWorld('box-spawner', { boxesPerMinute: 60 }) // period 1 s ≫ one tick
    expect(world.frame().count).toBe(0) // nothing before the first step
    world.step()
    expect(world.frame().count).toBe(1) // a box on tick 1, despite the 1 s period
  })

  it('cycles boxColors one colour per box (red, blue, red, …)', () => {
    world = spawnerWorld('box-spawner', { boxesPerMinute: 600, boxColors: '#ff0000,#0000ff', randomColors: false })
    for (let i = 0; i < 20 && world.frame().count < 3; i++) world.step()
    expect(world.frame().count).toBeGreaterThanOrEqual(3)
    expect(colorOf(world, 0)).toEqual([1, 0, 0]) // #ff0000
    expect(colorOf(world, 1)).toEqual([0, 0, 1]) // #0000ff
    expect(colorOf(world, 2)).toEqual([1, 0, 0]) // wraps back to red
  })

  it('randomColors draws from the boxColors list (both colours appear, all from the palette)', () => {
    world = spawnerWorld('box-spawner', { boxesPerMinute: 1200, boxColors: '#ff0000,#0000ff', randomColors: true })
    for (let i = 0; i < 40 && world.frame().count < 8; i++) world.step()
    const n = world.frame().count
    expect(n).toBeGreaterThanOrEqual(6)
    const seen = new Set<string>()
    for (let i = 0; i < n; i++) {
      const [r, g, b] = colorOf(world, i)
      expect(g).toBe(0) // neither palette colour has a green channel
      expect(r === 1 || b === 1).toBe(true) // every box is red or blue, nothing off-palette
      seen.add(`${r},${b}`)
    }
    expect(seen.size).toBeGreaterThan(1) // the draw actually varies (not a stuck colour)
  })

  it('randomSize varies each box within the min/max random-size range', () => {
    world = spawnerWorld('box-spawner', { boxesPerMinute: 1200, randomSize: true })
    for (let i = 0; i < 40 && world.frame().count < 6; i++) world.step()
    const n = world.frame().count
    expect(n).toBeGreaterThanOrEqual(4)
    const xs = new Set<number>()
    for (let i = 0; i < n; i++) {
      const [hx, hy, hz] = sizeOf(world, i)
      // half-extents = full [0.4,0.8]×[0.3,0.5]×[0.3,0.5] / 2 (BOX_RANDOM_SIZE_MIN/MAX)
      expect(hx).toBeGreaterThanOrEqual(0.2 - 1e-6)
      expect(hx).toBeLessThanOrEqual(0.4 + 1e-6)
      expect(hy).toBeGreaterThanOrEqual(0.15 - 1e-6)
      expect(hy).toBeLessThanOrEqual(0.25 + 1e-6)
      expect(hz).toBeGreaterThanOrEqual(0.15 - 1e-6)
      expect(hz).toBeLessThanOrEqual(0.25 + 1e-6)
      xs.add(+hx.toFixed(4))
    }
    expect(xs.size).toBeGreaterThan(1) // dimensions actually vary box-to-box
  })

  it('a fixed box uses the authored length×height×width (default 0.6×0.4×0.4)', () => {
    world = spawnerWorld('box-spawner', { boxesPerMinute: 60, length: 0.6, height: 0.4, width: 0.4 })
    world.step()
    const [hx, hy, hz] = sizeOf(world, 0) // half of 0.6×0.4×0.4 (Float32, so compare with tolerance)
    expect(hx).toBeCloseTo(0.3, 5)
    expect(hy).toBeCloseTo(0.2, 5)
    expect(hz).toBeCloseTo(0.2, 5)
  })

  it('fixedRate off holds the mean rate - ±50% jitter averages out over the run', () => {
    // 120/min = 2/s over 4 s ⇒ ~8 boxes either way; the jittered run stays within a couple of the fixed run.
    const steps = DEFAULT_SIM_HZ * 4
    const fixed = spawnerWorld('box-spawner', { boxesPerMinute: 120, fixedRate: true })
    for (let i = 0; i < steps; i++) fixed.step()
    const fixedCount = fixed.frame().count
    fixed.dispose()
    world = spawnerWorld('box-spawner', { boxesPerMinute: 120, fixedRate: false })
    for (let i = 0; i < steps; i++) world.step()
    const jitterCount = world.frame().count
    expect(fixedCount).toBe(8) // the fixed cadence is exact
    expect(Math.abs(jitterCount - fixedCount)).toBeLessThanOrEqual(3) // jitter preserves the mean
  })

  it('the translucent drop-cone is render-only - spawned cargo falls straight through it', () => {
    // the drop cone sits right where cargo emerges (offset y −0.2, cone at y −0.21). A `cone` link builds no
    // collision body, so the box must free-fall past it rather than rest on a phantom collider.
    world = spawnerWorld('box-spawner', { boxesPerMinute: 60 }) // one box on tick 1 (period 1 s)
    world.step()
    const y1 = world.frame().positions[1]!
    for (let i = 0; i < 30; i++) world.step()
    const y2 = world.frame().positions[1]!
    expect(y2).toBeLessThan(y1 - 0.5) // kept falling - not caught on the cone
  })

  it('the pallet spawner emits real pallet cargo on the first tick', () => {
    world = spawnerWorld('palletSpawner', { palletsPerMinute: 60 })
    world.step()
    const f = world.frame()
    expect(f.count).toBe(1)
    expect(f.kinds[0]).toBe(CARGO_KIND_PALLET) // a real EUR pallet, not a box
  })

  it('the pallet spawner drops pallets of the size it is set to', () => {
    world = spawnerWorld('palletSpawner', { palletsPerMinute: 60, palletSize: '1200x800' })
    world.step()
    expect(world.frame().kinds[0]).toBe(CARGO_KIND_PALLET)
    expect(sizeOf(world, 0).map((v) => +(v * 2).toFixed(4))).toEqual([1.2, 0.135, 0.8])
  })

  it('a pilot "Use" toggles the pallet spawner off, then on again', () => {
    world = spawnerWorld('palletSpawner', { palletsPerMinute: 600 }, 1) // low so pallets rest on the floor
    world.step() // first pallet
    const afterFirst = world.frame().count
    expect(afterFirst).toBe(1)

    world.usePart('sp') // pilot click → latch the line OFF
    for (let i = 0; i < 30; i++) world.step()
    const whileOff = world.frame().count
    expect(whileOff).toBe(afterFirst) // no new pallets while toggled off

    world.usePart('sp') // pilot click → latch the line back ON
    for (let i = 0; i < 30; i++) world.step()
    expect(world.frame().count).toBeGreaterThan(whileOff) // production resumes
  })

  // A pallet magazine is commanded, not paced: the PLC demo pulses its run tag for about a second per pallet
  // change and expects exactly one pallet to fall, which only works if each re-enable re-arms the drop. If the
  // countdown carried across the hold, the first pulse would dispense (the timer starts at zero) and every pulse
  // after it would only take a second off a ten-second period, so the cell would build its second load onto a
  // bare deck.
  it('dispenses on every re-enable, not just the first - the gate re-arms the drop', () => {
    world = spawnerWorld('palletSpawner', { palletsPerMinute: 6 }, 1) // 10 s period ≫ the ~1 s command pulse
    world.step()
    expect(world.frame().count).toBe(1)

    world.usePart('sp') // held off between pallet changes
    for (let i = 0; i < 30; i++) world.step()
    expect(world.frame().count).toBe(1) // nothing falls while it is held

    world.usePart('sp') // commanded again
    world.step()
    expect(world.frame().count).toBe(2) // a pallet now, not nine seconds from now
  })

  // ...and one per command, not a burst: the rate still paces it while the gate is held open.
  it('drops exactly one pallet per command pulse (the rate paces it while the gate stays open)', () => {
    world = spawnerWorld('palletSpawner', { palletsPerMinute: 6 }, 1)
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) world.step() // a full second of "feed"
    expect(world.frame().count).toBe(1)
  })

  /** The real box spawner interlocked to a belt that runs, stops at `offSec`, and runs again at `onSec`. */
  function gatedBoxSpawner(periodSec: number, offSec: number, onSec: number): SimWorld {
    const { manifest, behavior } = loadExample('box-spawner')
    const gate = buildPackage(
      {
        id: 'acme.gate',
        name: 'Gate',
        geometry: {
          kind: 'rig',
          links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }],
          joints: [],
          bounds: { length: 2, width: 1, top: 0.1 },
        },
      },
      `let t = 0
       definePart({ step(ctx) {
         t += ctx.dt
         const running = t < ${offSec} || t >= ${onSec}
         ctx.setSurfaceVelocity({ x: running ? 1 : 0, y: 0, z: 0 })
       } })`,
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [gate, buildPackage(manifest, behavior), buildPackage(loadExample('box').manifest, loadExample('box').behavior)],
      parts: [
        { id: 'belt', type: 'part', packageId: 'acme.gate', position: [5, 1, 0], rotationY: 0, params: {} },
        { id: 'sp', type: 'part', packageId: manifest.id, position: [0, 1, 0], rotationY: 0, params: { boxesPerMinute: 60 / periodSec, conveyorId: 'belt' } },
      ],
    })
    if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
    return new SimWorld(Jolt, res.scene)
  }
  /** run to `seconds` of sim time (the world starts at 0) */
  const runTo = (w: SimWorld, seconds: number): number => {
    while (w.frame().simTime < seconds) w.step()
    return w.frame().count
  }

  // A hopper is paced, not commanded: what the author sets is the interval between boxes, so that is what a hold
  // preserves. The countdown keeps running while the gate is shut, so a hopper released after longer than a period
  // drops at once instead of waiting out the remainder of an interval it spent standing still. That remainder is
  // costly on an interlocked line: in the PLC demo it measured ~2.7 s of empty lane at the top of every row, twice
  // a layer. (The pallet spawner's rule above is the opposite: a magazine is commanded.)
  it('a hold does not cost a period: a gated hopper drops as soon as the interlock clears', () => {
    world = gatedBoxSpawner(3, 1, 4) // 3 s period; held from t=1 to t=4, i.e. a hold longer than the 2 s left
    expect(runTo(world, 0.5)).toBe(1) // the first box, on the first tick
    expect(runTo(world, 3.9)).toBe(1) // nothing falls while the belt is stopped, however long the hold
    expect(runTo(world, 4.2)).toBe(2) // released → now, not 2 s into the run
  })

  // ...and floored at zero, which is what keeps that safe. If the countdown ran negative across a long hold, it
  // would accumulate a box per period, all released in the same tick the moment an interlock clears, so a conveyor
  // that stutters would get a burst onto the lane it just restarted.
  // Release: a 5 s interval with the gate pulsed open for 0.5 s every 3 s, the way a program asking for one item at a
  // time pulses a run tag. A steady interval keeps the gap since its last drop, so it drops on every other pulse; on
  // each enable treats every pulse as an order.
  function pulsedSpawner(release: 'interval' | 'enable'): SimWorld {
    const { manifest, behavior } = loadExample('box-spawner')
    const gate = buildPackage(
      { id: 'acme.pulse', name: 'Pulse', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 1, top: 0.1 } } },
      `let t = 0
       definePart({ step(ctx) {
         const open = t % 3 < 0.5 - 1e-9
         t += ctx.dt
         ctx.setSurfaceVelocity({ x: open ? 1 : 0, y: 0, z: 0 })
       } })`,
    )
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [gate, buildPackage(manifest, behavior), buildPackage(loadExample('box').manifest, loadExample('box').behavior)],
      parts: [
        { id: 'belt', type: 'part', packageId: 'acme.pulse', position: [5, 1, 0], rotationY: 0, params: {} },
        { id: 'sp', type: 'part', packageId: manifest.id, position: [0, 5, 0], rotationY: 0, params: { boxesPerMinute: 12, conveyorId: 'belt', release } },
      ],
    })
    if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
    return new SimWorld(Jolt, res.scene)
  }

  it('release, steady interval: pulses quicker than the interval drop on every other one, keeping the gap', () => {
    world = pulsedSpawner('interval')
    expect([1, 4, 7, 10].map((t) => runTo(world!, t))).toEqual([1, 1, 2, 2])
  })

  it('release, on each enable: every pulse drops one', () => {
    world = pulsedSpawner('enable')
    expect([1, 4, 7, 10].map((t) => runTo(world!, t))).toEqual([1, 2, 3, 4])
  })

  it('never banks a burst across a long hold: one box on release, then the rate again', () => {
    world = gatedBoxSpawner(3, 1, 20) // held for 19 s - over six periods' worth
    expect(runTo(world, 0.5)).toBe(1)
    expect(runTo(world, 20.2)).toBe(2) // exactly one, not the seven an accumulated countdown would release
    expect(runTo(world, 22.9)).toBe(2) // and the rate paces it from there
    expect(runTo(world, 23.3)).toBe(3)
  })
})
