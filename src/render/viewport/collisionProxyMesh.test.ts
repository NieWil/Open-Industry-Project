import { describe, expect, it } from 'vitest'
import { Group, Raycaster, Vector3 } from 'three'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart } from '../../core/types'
import { registerPackage } from '../../core/parts/partRegistry'
import { collisionProxy, shapeCornersLocal } from '../../core/geometry/collisionShapes'
import { conveyingSurfaceAt } from '../../core/conveyor/conveyorSurface'
import { refreshCollisionProxy } from './collisionProxyMesh'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// Cargo (box) is the C-cargo SDK part: a `custom` part whose package declares geometry.kind:'cargo' (there is
// no built-in box type; docs/architecture.md). collisionProxy reads its centre-origin box
// footprint through cargoView, so we register the package and build the drop-target fixture as an `oip.box`.
registerPackage({
  format: PACKAGE_FORMAT,
  id: 'oip.box',
  name: 'Box',
  params: {
    length: { type: 'number', default: 0.6 },
    height: { type: 'number', default: 0.4 },
    width: { type: 'number', default: 0.4 },
    mass: { type: 'number', default: 10 },
    color: { type: 'color', default: '#ffffff' },
  },
  behavior: 'definePart({ step(){} })',
  geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } },
} as unknown as PartPackage)

function boxPart(id: string, position: [number, number, number], rotationY: number): SdkPart {
  return { id, type: 'part', packageId: 'oip.box', position, rotationY, params: { length: 0.6, height: 0.4, width: 0.4, mass: 10, color: '#ffffff' } }
}

describe('collisionProxy (core)', () => {
  it('exposes the part footprint as one flat-topped solid (top above bottom, real depth)', () => {
    const part = boxPart('s', [0, 1, 0], 0)
    const h = (part.params as { height: number }).height
    const shapes = collisionProxy(part)
    expect(shapes).toHaveLength(1)
    const pts = shapeCornersLocal(shapes[0]!)
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(h / 2, 9) // flat top face
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(-h / 2, 9) // slab has depth
  })
})

describe('refreshCollisionProxy (drop target)', () => {
  it('rests a downward ray on the flat top across the full width', () => {
    const part = boxPart('s', [0, 1, 0], 0)
    const h = (part.params as { height: number }).height
    const hw = (part.params as { width: number }).width / 2
    const top = 1 + h / 2 // world y of the proxy top (part at y=1)
    const group = new Group()
    refreshCollisionProxy(group, part)

    const ray = new Raycaster()
    const down = new Vector3(0, -1, 0)
    // sample across the proxy width at x=0: every ray hits the flat top, none passes through
    for (const f of [-0.9, -0.5, 0, 0.5, 0.9]) {
      const z = f * hw
      ray.set(new Vector3(0, 5, z), down)
      const hit = ray.intersectObject(group, true)[0]
      expect(hit, `z=${z}`).toBeTruthy()
      expect(hit!.point.y, `z=${z}`).toBeCloseTo(top, 5)
    }
  })

  it('builds nothing for an empty/cleared group rebuild (idempotent)', () => {
    const part = boxPart('s', [0, 1, 0], 0)
    const group = new Group()
    refreshCollisionProxy(group, part)
    const first = group.children.length
    refreshCollisionProxy(group, part)
    expect(group.children.length).toBe(first) // rebuild replaces, doesn't accumulate
  })
})

// An inclined straight roller conveyor: its render deck tilts about the centre (rigWorldPoses inclineRad,
// docs/conveyor-incline.md), and the drop-raycast proxy must follow the tilt so drops land on the true deck. A
// rise-expanded axis-aligned footprint AABB would be a phantom flat top at head height across the whole bed: a
// box dropped over the tail would float up (and, cast from an angled camera ray, land displaced).
registerPackage({
  format: PACKAGE_FORMAT,
  id: 'oip.roller-conveyor',
  name: 'Roller Conveyor', conveyor: { bed: 'straight', surface: 'roller' },
  params: {
    length: { type: 'number', default: 3, handle: { kind: 'face', axis: 'x' } },
    width: { type: 'number', default: 1, handle: { kind: 'face', axis: 'z' } },
    tiltDeg: { type: 'number', default: 0 },
    standHeight: { type: 'number', default: 0.75 },
  },
  behavior: 'definePart({ step(){} })',
  geometry: {
    kind: 'rig',
    inclineParam: 'tiltDeg',
    maxInclineDeg: 30,
    links: [{ name: 'deck', shape: { kind: 'box', size: [3, 0.04, 1] }, offset: [0, -0.02, 0], conveys: true }],
    joints: [],
    bounds: { length: 3, width: 1, top: 2.3 },
  },
} as unknown as PartPackage)

function rollerPart(id: string, position: [number, number, number], tiltDeg: number, length = 3): SdkPart {
  return { id, type: 'part', packageId: 'oip.roller-conveyor', position, rotationY: 0, params: { length, width: 1, tiltDeg, standHeight: 0.75 } }
}

describe('collisionProxy (inclined roller conveyor)', () => {
  it('drop-raycast follows the tilted deck - tail is lower than the head, both track hx·sin', () => {
    const tiltDeg = 20
    const length = 3
    const part = rollerPart('r', [0, 0, 0], tiltDeg, length) // origin at belt height (y=0), centre-pivot tilt
    const group = new Group()
    refreshCollisionProxy(group, part)

    const rise = (length / 2) * Math.sin((tiltDeg * Math.PI) / 180) // head lift / tail drop from the centre
    const ray = new Raycaster()
    const down = new Vector3(0, -1, 0)
    const dropY = (x: number): number => {
      ray.set(new Vector3(x, 5, 0), down)
      const hit = ray.intersectObject(group, true)[0]
      expect(hit, `x=${x}`).toBeTruthy()
      return hit!.point.y
    }

    const head = dropY(1.2) // near the +X (raised) head
    const centre = dropY(0) // centre stays at belt height
    const tail = dropY(-1.2) // near the −X (lowered) tail

    // the tilt is real: head is meaningfully above the tail (a flat AABB top would make these equal)
    expect(head - tail).toBeGreaterThan(0.7)
    // a vertical ray at world x hits the tilted top plane at Δy = x·tanθ from the centre, linear + symmetric,
    // not a phantom flat top (an AABB proxy would land every ray at the same head height)
    const tan = Math.tan((tiltDeg * Math.PI) / 180)
    expect(head - centre).toBeCloseTo(1.2 * tan, 2)
    expect(centre - tail).toBeCloseTo(1.2 * tan, 2)
    // sanity: sampled inside the ±length/2 bed, so below the full-run rise above the centre
    expect(head - centre).toBeLessThan(rise + 1e-6)
    // the proxy reaches the bed's real ends: 2 cm short of the head in plan ((L/2)·cos) still lands on the deck.
    // The slab is the slope length even though partFootprint reports the plan length ((L/2)·cos): built from
    // the footprint's hx it would stop ~7 cm short here and a box dropped on the head would fall through
    const endX = (length / 2) * Math.cos((tiltDeg * Math.PI) / 180) - 0.02
    expect(dropY(endX) - centre).toBeCloseTo(endX * tan, 2)
  })
})

// A Z-frame belt (path bed): its footprint is one box topped at the high run. As a drop target that box put a
// phantom top 0.6 m above the low run, so an angled cursor ray hit it far from where it pointed on the belt.
registerPackage({
  format: PACKAGE_FORMAT,
  id: 'test.belt',
  name: 'Test Belt', conveyor: { bed: 'path', surface: 'belt', speedParam: 'speed' },
  params: {
    segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
    width: { type: 'number', default: 0.6 },
    height: { type: 'number', default: 0.5 },
    speed: { type: 'number', default: 1 },
  },
  behavior: 'definePart({ step(){} })',
  geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
} as unknown as PartPackage)

describe('collisionProxy (Z-frame belt)', () => {
  it('drop-raycast lands on the belt path, low run and high run alike', () => {
    const segments = [[2, 0], [3, 12], [2, -12]]
    const part: SdkPart = { id: 'b', type: 'part', packageId: 'test.belt', position: [0, 0, 0], rotationY: 0, params: { segments, width: 0.6, height: 0.5, speed: 1 } }
    const group = new Group()
    refreshCollisionProxy(group, part)
    const ray = new Raycaster()
    const down = new Vector3(0, -1, 0)
    const dropY = (x: number): number => {
      ray.set(new Vector3(x, 5, 0), down)
      const hit = ray.intersectObject(group, true)[0]
      expect(hit, `x=${x}`).toBeTruthy()
      return hit!.point.y
    }
    for (const x of [0.5, 1.5, 3.5, 5.5, 6.5]) {
      expect(dropY(x), `x=${x}`).toBeCloseTo(conveyingSurfaceAt(part, x, 0)!.y, 2)
    }
    expect(dropY(6.5) - dropY(0.5)).toBeGreaterThan(0.5) // the high run really is higher
  })
})
