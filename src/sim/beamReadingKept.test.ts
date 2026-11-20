import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import type { FrameBeamHit } from '../core/frame'
import { clearPackages } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

// A beam's reading is the same object from step to step until the beam reads something new, and so is the part's
// record of its beams (SimWorld.tickBehaviors, castBeamRows). The readings must still be what a cast with nothing
// to compare against gives.

type Vec = [number, number, number]
interface Emitter {
  name: string
  origin: Vec
  dir: Vec
  range: number
}
interface Inside {
  sensors: { beamsOf(id: string): Emitter[] | undefined; castBeam(origin: Vec, dir: Vec, range: number, prev?: FrameBeamHit): FrameBeamHit }
}

const twoBeams = buildPackage(
  {
    id: 'acme.twobeams',
    name: 'Two beams',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'ahead', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0.3, 0], beam: { range: 10 } },
        { name: 'side', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0.3, 0], beam: { range: 4, axis: [1, 0, 0] } },
      ],
      joints: [],
      bounds: { length: 0.1, width: 0.1, top: 0.4 },
    },
  },
  "definePart({ react(ctx){ ctx.writeTag('seen', ctx.sense('ahead').hit) } })",
)

function world(): SimWorld {
  clearPackages() // SimWorld registers the scene's embedded packages itself
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [twoBeams],
    parts: [{ id: 'eye', type: 'part', packageId: twoBeams.id, position: [0, 0, 0], rotationY: 0, params: {} }],
  })
  if (!res.ok) throw new Error('scene')
  return new SimWorld(Jolt, res.scene)
}

/** what each beam reads now, cast with no earlier reading to hand back */
function fresh(w: SimWorld): Record<string, FrameBeamHit> {
  const s = (w as unknown as Inside).sensors
  const out: Record<string, FrameBeamHit> = {}
  for (const e of s.beamsOf('eye')!) out[e.name] = s.castBeam(e.origin, e.dir, e.range)
  return out
}

describe('a beam reading is kept until the beam reads something new', () => {
  it('keeps the record and each reading while nothing is in the beams', () => {
    const w = world()
    w.step()
    const first = w.frame().beamHits!.eye!
    expect(first).toEqual({ ahead: { hit: false, distance: 10, color: [0, 0, 0] }, side: { hit: false, distance: 4, color: [0, 0, 0] } })
    for (let i = 0; i < 5; i++) w.step()
    const later = w.frame().beamHits!.eye!
    expect(later).toBe(first)
    expect(later.ahead).toBe(first.ahead)
    w.dispose()
  })

  it('replaces the reading of the beam that changed, and only that one', () => {
    const w = world()
    w.step()
    const clear = w.frame().beamHits!.eye!
    w.spawnBoxAt(0, 0.3, 1, 0.2, 0.2, 0.2, 0, 10, [1, 0, 0]) // in the beam ahead, at the lens height
    w.step()
    const blocked = w.frame().beamHits!.eye!
    expect(blocked).not.toBe(clear)
    expect(blocked.ahead!.hit).toBe(true)
    expect(blocked.ahead!.color).toEqual([1, 0, 0])
    expect(blocked.side).toBe(clear.side)
    expect(clear.ahead).toEqual({ hit: false, distance: 10, color: [0, 0, 0] }) // the old reading was not written over
    w.dispose()
  })

  it('reads what a cast with nothing to compare against reads, on every step of a box falling through and settling', () => {
    const w = world()
    w.spawnBoxAt(0, 1.2, 1, 0.2, 0.2, 0.2, 0, 10, [0, 1, 0]) // above the beam ahead: it falls through it to the floor
    w.spawnBoxAt(2, 0.3, 0.05, 0.2, 0.2, 0.2, 0.4, 10, [0, 0, 1]) // in the side beam, turned, so its distance moves as it lands
    let records = 0
    let last: unknown
    for (let i = 0; i < 180; i++) {
      const want = fresh(w) // the step casts its beams before it moves anything
      w.step()
      const got = w.frame().beamHits!.eye!
      expect(got).toEqual(want)
      if (got !== last) records++
      last = got
    }
    // it changed while the boxes moved and stopped changing once they came to rest
    expect(records).toBeGreaterThan(2)
    expect(records).toBeLessThan(180)
    w.dispose()
  })
})
