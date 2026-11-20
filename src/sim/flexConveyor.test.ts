/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { flexStations } from '../core/conveyor/flexPath'
import { clearPackages } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// The Flex Conveyor (examples/parts/flex-conveyor): 16 hinged sections fitted along a path through its control points,
// every deck conveying along its own direction (ctx.setSurfaceSpeed). What it has to get right: the running bed takes
// the shape core/conveyor/flexPath.ts says (the behavior carries a mirror of that code, and this is what holds them together),
// and a case put on the infeed rides every bend of it to the discharge end.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const N = 16
const H = 0.8

function loadExample(dir: string): { manifest: PackageManifest; behavior: string } {
  const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as {
    id: string
    name: string
    category?: string
    geometry: PackageManifest['geometry']
    materials?: PackageManifest['materials']
    conveyor?: PackageManifest['conveyor']
  }
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return { manifest: { id: rig.id, name: rig.name, category: rig.category, geometry: rig.geometry, materials: rig.materials, conveyor: rig.conveyor }, behavior }
}

const SHAPES: Record<string, number[][]> = {
  straight: [[3, 0], [6, 0], [8, 0]],
  's-curve': [[3, 0], [5, -2], [8, -2]],
  // a U a real flex can make: 180 degrees spread over the sections, no hinge past the part's 40
  'u-turn': [[5, 0], [8, 1.5], [8, 4.5], [5, 6]],
}

describe('Flex Conveyor (SDK part, headless)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  function flexWorld(points: number[][], guides: boolean): SimWorld {
    const flex = loadExample('flex-conveyor')
    const box = loadExample('box')
    const length = flexStations(points, N).pitch * N // what the editor's path drag writes alongside the points
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [buildPackage(flex.manifest, flex.behavior), buildPackage(box.manifest, box.behavior)],
      parts: [
        { id: 'flex', type: 'part', packageId: flex.manifest.id, position: [0, H, 0], rotationY: 0, params: { standHeight: H, points, length, speed: 1, sideGuides: guides } },
        // a small case on the first section, just past the infeed
        { id: 'box', type: 'part', packageId: box.manifest.id, position: [0.3, H + 0.1, 0], rotationY: 0, params: { length: 0.3, width: 0.3, height: 0.2 } },
      ],
    })
    if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
    return new SimWorld(Jolt, res.scene)
  }

  for (const [name, points] of Object.entries(SHAPES)) {
    it(`carries a case along a ${name} bed to its end, on the bed the whole way`, () => {
      // the U is the one a real unit takes with its side guides on: without them a case rides wide on the tightest
      // bend and leaves the bed, which is what they are for
      world = flexWorld(points, name === 'u-turn')
      const fit = flexStations(points, N)
      expect(fit.maxHinge * 180 / Math.PI, 'a shape the part could not take').toBeLessThan(40)
      // the running hinges are the core fit: the behavior's mirror of flexPath poses them
      world.step()
      const joints = world.frame().joints?.['flex']
      expect(joints, 'the flex commanded no hinges').toBeDefined()
      if (joints) {
        let prev = 0
        for (let i = 0; i < N; i++) {
          expect(joints[`h${i}`], `hinge h${i}`).toBeCloseTo(fit.headings[i]! - prev, 6)
          prev = fit.headings[i]!
        }
      }
      const end = points[points.length - 1]!
      // distance from a point to the fitted bed (its polyline of hinges)
      const offBed = (x: number, z: number): number => {
        let best = Infinity
        for (let k = 0; k < N; k++) {
          const [ax, az] = fit.stations[k]!, [bx, bz] = fit.stations[k + 1]!
          const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2)) : 0
          best = Math.min(best, Math.hypot(x - (ax + t * vx), z - (az + t * vz)))
        }
        return best
      }
      let nearest = Infinity
      let worstOff = 0
      let lowest = Infinity
      // the bed at 1 m/s, and some slack for the corners
      for (let i = 0; i < 60 * (fit.pitch * N + 6); i++) {
        world.step()
        const f = world.frame()
        const [x, y, z] = [f.positions[0]!, f.positions[1]!, f.positions[2]!]
        if (nearest < 0.35) break // judged until it arrives: past the discharge end it runs off onto the floor
        nearest = Math.min(nearest, Math.hypot(x - end[0]!, z - end[1]!))
        worstOff = Math.max(worstOff, offBed(x, z))
        lowest = Math.min(lowest, y)
      }
      expect(nearest, 'the case never reached the discharge end').toBeLessThan(0.35)
      // a 0.3 case on the 0.6 bed rides against a side guide through a tight bend, 0.15 out, and the bed's chords cut a
      // little inside the curve it rides: so this is 'between the guides', not 'on the centreline'
      expect(worstOff, 'the case wandered off the bed').toBeLessThan(0.18)
      expect(lowest, 'the case dropped off the bed on the way').toBeGreaterThan(H)
    })
  }

  // Zero-pressure accumulation: every section is a zone with its own eye. Cases put down as a loader does (the load
  // eye lets the next one down once the last has cleared it: ~0.3 m behind) must queue a zone apart and stand still
  // while the discharge is held, then leave one at a time, metered, once released. The load eye reports whether there
  // is room at the infeed. (Cases put down touching share a zone and wait together, as on a real zoned bed: zones stop
  // cases pushing each other, they cannot pull a touching pair apart. The metered discharge still singulates them.)
  it('accumulates cases with gaps while held, then releases them one at a time, metered', () => {
    const flex = loadExample('flex-conveyor')
    const box = loadExample('box')
    const takeaway = loadExample('roller-conveyor')
    const points = [[5, 0], [10, 0], [16, 0]] // straight, 16 m: 1 m sections, room for a 0.6 m case in each zone
    const length = flexStations(points, N).pitch * N
    const cases = [0.4, 1.3, 2.2, 3.1, 4.0] // 0.3 m apart: closer than a zone
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [buildPackage(flex.manifest, flex.behavior), buildPackage(box.manifest, box.behavior), buildPackage(takeaway.manifest, takeaway.behavior)],
      parts: [
        { id: 'flex', type: 'part', packageId: flex.manifest.id, position: [0, H, 0], rotationY: 0, params: {
          standHeight: H, points, length, speed: 1, accumulate: true, releaseTag: 'Rel', fullTag: 'Full', meterGap: 2,
        } },
        // what the line would be: a takeaway past the discharge end (centre-origin, 6 m), so released cases are carried off
        { id: 'away', type: 'part', packageId: takeaway.manifest.id, position: [16.1 + 3, H, 0], rotationY: 0, params: {
          length: 6, width: 0.8, standHeight: H, fpmUnits: false, speed: 1,
        } },
        ...cases.map((x, i) => ({ id: `c${i}`, type: 'part', packageId: box.manifest.id, position: [x, H + 0.2, 0], rotationY: 0, params: { length: 0.6, width: 0.4, height: 0.4 } })),
      ],
    })
    if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
    world = new SimWorld(Jolt, res.scene)
    world.setBehaviorDrivenTags(['Rel']) // a program owns the release...
    world.setBehaviorInputTags({ Rel: false }) // ...and holds it
    const xs = (): number[] => {
      const f = world!.frame()
      return cases.map((_, i) => f.positions[f.partIds.indexOf(`c${i}`) * 3]!).sort((a, b) => a - b)
    }
    for (let i = 0; i < 60 * 25; i++) world.step()
    const held = xs()
    for (let i = 0; i < 30; i++) world.step()
    const later = xs()
    // queued at the discharge end: the front case waits in the last zone, nothing has left, nothing is moving
    expect(held[held.length - 1]!, 'the front case waits at the discharge end').toBeGreaterThan(15)
    expect(held[held.length - 1]!).toBeLessThan(16)
    held.forEach((x, i) => expect(Math.abs(later[i]! - x), `case ${i} still moving while held`).toBeLessThan(0.01))
    // ...one to a zone, with a clear gap between each (0.6 m cases in 1 m zones): the queue closed up from 0.3 m gaps
    // without a case pushing the one ahead
    for (let i = 1; i < held.length; i++) expect(held[i]! - held[i - 1]!, `centres behind case ${i}`).toBeGreaterThan(0.8)
    // the infeed is clear again once the queue has moved up: room to load
    expect(world.frame().tags?.flex?.Full ?? false).toBe(false)

    // released: they go one at a time, at least the metered 2 s apart
    world.setBehaviorInputTags({ Rel: true })
    const exits: number[] = []
    let onBed = xs().filter((x) => x < 16.1).length
    for (let i = 0; i < 60 * 20; i++) {
      world.step()
      const now = xs().filter((x) => x < 16.1).length
      if (now < onBed) exits.push(i / 60)
      onBed = now
    }
    expect(exits.length, 'every case left').toBe(cases.length)
    for (let i = 1; i < exits.length; i++) expect(exits[i]! - exits[i - 1]!, `spacing before case ${i}`).toBeGreaterThan(1.9)
  })

  // The zone eyes sit low (15-25 mm over the rollers, as real ones do), so a flat item is seen too: a 60 mm carton on a
  // held bed must stop at the discharge eye, where an eye at case-middle height would let it run under and off the end.
  it('holds a flat 60 mm carton at the discharge eye: the zone eyes sit low', () => {
    const flex = loadExample('flex-conveyor')
    const box = loadExample('box')
    const points = [[3, 0], [6, 0], [8, 0]]
    const length = flexStations(points, N).pitch * N
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [buildPackage(flex.manifest, flex.behavior), buildPackage(box.manifest, box.behavior)],
      parts: [
        { id: 'flex', type: 'part', packageId: flex.manifest.id, position: [0, H, 0], rotationY: 0, params: {
          standHeight: H, points, length, speed: 1, accumulate: true, releaseTag: 'Rel',
        } },
        { id: 'flat', type: 'part', packageId: box.manifest.id, position: [0.4, H + 0.03, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.06 } },
      ],
    })
    if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
    world = new SimWorld(Jolt, res.scene)
    world.setBehaviorDrivenTags(['Rel'])
    world.setBehaviorInputTags({ Rel: false })
    for (let i = 0; i < 60 * 12; i++) world.step()
    const f = world.frame()
    const x = f.positions[f.partIds.indexOf('flat') * 3]!
    // held in the last zone (7.5..8 m), nose at its eye (0.8 of the section): not run off the end
    expect(x).toBeGreaterThan(7.3)
    expect(x).toBeLessThan(8)
  })
})
