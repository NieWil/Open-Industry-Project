import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

// The Color + Laser sensors use the same C-sensing beam as the Diffuse sensor, but read different
// fields of ctx.sense(): the colour (classified to a code) and the distance (a range readout). This tests both
// end-to-end in the real SimWorld: a coloured box in the beam yields the right colour code; a box at a known
// distance yields that distance. (The behaviours mirror the bundled examples; inlined so the sim project needs
// no render import.)

const sensorPkg = (id: string, behaviorBody: string) =>
  buildPackage(
    {
      id,
      name: id,
      geometry: {
        kind: 'rig',
        links: [{ name: 'lens', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0.3, 0], beam: { range: 10 } }],
        joints: [],
        bounds: { length: 0.1, width: 0.1, top: 0.4 },
      },
    },
    behaviorBody,
  )

const runWithBox = (pkg: ReturnType<typeof buildPackage>, color: [number, number, number], boxZ: number): Record<string, number | boolean> | undefined => {
  clearPackages() // SimWorld registers the scene's embedded packages itself
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [pkg],
    parts: [{ id: 'cp_1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params: {} }],
  })
  expect(res.ok).toBe(true)
  if (!res.ok) return undefined
  const w = new SimWorld(Jolt, res.scene)
  w.spawnBoxAt(0, 0.3, boxZ, 0.2, 0.2, 0.2, 0, 10, color) // a coloured box in the +Z beam, at the lens height
  for (let i = 0; i < 3; i++) w.step()
  const frame = w.frame()
  const tags = frame.tags?.cp_1
  // the frame carries the same castBeam result the behavior read via ctx.sense; the view draws
  // beams from this instead of re-casting on the main thread, so assert it is always present
  const beam = frame.beamHits?.cp_1?.lens
  expect(beam).toBeDefined()
  expect(beam!.hit).toBe(true)
  expect(beam!.color).toEqual(color)
  w.dispose()
  return tags
}

describe('Color Sensor (C-sensing colour) - classifies cargo colour to a code', () => {
  const colorPkg = sensorPkg(
    'acme.color',
    "function classify(c){ const max=Math.max(c[0],c[1],c[2]); if(max<0.25) return 0; const mid=c[0]+c[1]+c[2]-max-Math.min(c[0],c[1],c[2]); if(mid>max*0.6) return 0; return max===c[0]?1:max===c[1]?2:3 } definePart({ step(ctx){ const s=ctx.sense('lens'); ctx.writeNumber('code', s.hit?classify(s.color):0) } })",
  )
  it('a red box → 1, a green box → 2, a blue box → 3', () => {
    expect(runWithBox(colorPkg, [1, 0, 0], 1)?.code).toBe(1)
    expect(runWithBox(colorPkg, [0, 1, 0], 1)?.code).toBe(2)
    expect(runWithBox(colorPkg, [0, 0, 1], 1)?.code).toBe(3)
  })
  it('a white/ambiguous box → 0 (no dominant primary)', () => {
    expect(runWithBox(colorPkg, [1, 1, 1], 1)?.code).toBe(0)
  })
})

describe('Laser Sensor (C-sensing distance) - reports the range to cargo', () => {
  const laserPkg = sensorPkg('acme.laser', "definePart({ step(ctx){ const s=ctx.sense('lens'); ctx.writeNumber('dist', s.hit ? s.distance : 99) } })")
  it('reports the metres to the box front face along the beam', () => {
    // lens (beam origin) at z=0; box centre z=2, half-extent 0.2 → front face at z=1.8 → distance ≈ 1.8 m
    const dist = runWithBox(laserPkg, [1, 1, 1], 2)?.dist as number
    expect(dist).toBeCloseTo(1.8, 1)
  })
})

describe('the walking pilot blocks a sensor beam', () => {
  const laserPkg = sensorPkg('acme.laser', "definePart({ step(ctx){ const s=ctx.sense('lens'); ctx.writeNumber('dist', s.hit ? s.distance : 99) } })")
  const world = () => {
    clearPackages()
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [laserPkg],
      parts: [{ id: 'cp_1', type: 'part', packageId: laserPkg.id, position: [0, 0, 0], rotationY: 0, params: {} }],
    })
    if (!res.ok) throw new Error('scene invalid')
    return new SimWorld(Jolt, res.scene)
  }
  const beamOf = (w: SimWorld) => {
    for (let i = 0; i < 3; i++) w.step()
    return w.frame().beamHits?.cp_1?.lens
  }

  it('reads the pilot body (radius 0.3) standing in the beam, in a colour a colour sensor calls none', () => {
    const w = world()
    w.setPilotBody([0, 0, 1]) // feet at z=1, so the capsule's near face is at z=0.7
    const beam = beamOf(w)
    expect(beam?.hit).toBe(true)
    expect(beam!.distance).toBeCloseTo(0.7, 3)
    expect(w.frame().tags?.cp_1?.dist).toBeCloseTo(0.7, 3)
    const [r, g, b] = beam!.color
    const max = Math.max(r, g, b)
    expect(max < 0.25 || r + g + b - max - Math.min(r, g, b) > max * 0.6).toBe(true) // no primary dominates
    w.dispose()
  })

  it('the nearer of the pilot and a box wins, and the beam clears when the pilot leaves', () => {
    const w = world()
    w.spawnBoxAt(0, 0.3, 2, 0.2, 0.2, 0.2, 0, 10, [1, 0, 0])
    w.setPilotBody([0, 0, 1])
    expect(beamOf(w)!.distance).toBeCloseTo(0.7, 3) // the pilot, in front of the box
    w.setPilotBody(null)
    const beam = beamOf(w)
    expect(beam!.distance).toBeCloseTo(1.8, 1) // the box again
    expect(beam!.color).toEqual([1, 0, 0])
    w.dispose()
  })

  it('a pilot beside the beam does not block it', () => {
    const w = world()
    w.setPilotBody([0.5, 0, 1]) // 0.5 m off the beam line, radius 0.3
    expect(beamOf(w)?.hit).toBe(false)
    w.dispose()
  })
})
