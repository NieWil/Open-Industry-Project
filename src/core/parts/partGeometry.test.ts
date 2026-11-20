import { describe, expect, it } from 'vitest'
import type { ParamValue, PartInstance, PartType } from '../types'
import type { PartPackage } from './partPackage'
import { registerPackage } from './partRegistry'
import { beltSegmentFrames } from '../conveyor/beltPath'
import {
  DEG,
  RACK_FRAME_THICKNESS,
  RACK_SHELF_THICKNESS,
  conveyorEndsOf,
  partFootprint,
  rackBoxes,
  restOnSurface,
} from './partGeometry'
import type { RackGeometryParams } from './partGeometry'
import { createPart } from '../scene/scene'
import { PACKAGE_FORMAT } from './partPackage'

// conveyorEndsOf / partFootprint / resizePart and the belt-path handles are tested on SDK conveyor parts in
// partGizmos.test.ts (declared face/path/arc handles). This file covers the shape-agnostic pieces: non-conveyor
// ends, building/box footprint, restOnSurface, the pure belt-path frame math, and the SDK-rack parity reference
// (rackBoxes).

// Cargo (box) is the C-cargo SDK part: a `custom` part whose package declares geometry.kind:'cargo'
// (docs/architecture.md). partFootprint/restOnSurface read its centre-origin size through cargoView, so register
// the package and build the fixtures as custom `oip.box` instances.
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

function make(
  type: PartType,
  over: Record<string, ParamValue> = {},
  position: [number, number, number] = [0, 0, 0],
  rotationY = 0,
): PartInstance {
  const p = createPart(type, `${type}_t`, position, rotationY)
  Object.assign(p.params as unknown as Record<string, ParamValue>, over)
  return p
}

/** a cargo `oip.box` custom instance (centre-origin box footprint) */
function boxPart(
  over: Record<string, ParamValue> = {},
  position: [number, number, number] = [0, 0, 0],
  rotationY = 0,
): PartInstance {
  return { id: 'box_t', type: 'part', packageId: 'oip.box', position: [position[0], position[1], position[2]], rotationY, params: { ...over } } as unknown as PartInstance
}

describe('conveyorEndsOf non-conveyors', () => {
  it('returns no ends for parts that are not conveyors', () => {
    expect(conveyorEndsOf(boxPart())).toEqual([])
    expect(conveyorEndsOf(make('building'))).toEqual([])
  })
})

describe('belt path segment frames', () => {
  const threeSeg = () => [
    { length: 2, tiltDeg: 0 },
    { length: 3, tiltDeg: 12 },
    { length: 2, tiltDeg: -12 },
  ]

  it('places segment-end frames on the tilted corner chain (tail at origin)', () => {
    const { corners, tangents } = beltSegmentFrames(threeSeg())
    expect(corners[0]).toEqual({ x: 0, y: 0 })
    expect(corners[1]!.x).toBeCloseTo(2, 10) // flat seg 0 end
    expect(corners[1]!.y).toBeCloseTo(0, 10)
    // seg 1 climbs at +12deg over length 3
    expect(corners[2]!.x).toBeCloseTo(2 + 3 * Math.cos(12 * DEG), 10)
    expect(corners[2]!.y).toBeCloseTo(3 * Math.sin(12 * DEG), 10)
    expect(tangents[1]!.y).toBeCloseTo(Math.sin(12 * DEG), 10) // cumulative tilt = +12deg
    expect(tangents[2]!.y).toBeCloseTo(0, 10) // +12 then -12 -> flat again
  })
})

describe('partFootprint', () => {
  it('building spans its footprint up to eave height', () => {
    const f = partFootprint(make('building', { lengthSections: 3, widthSections: 2, heightSections: 2 }))
    expect(f).toEqual({ hx: 15, hz: 10, y0: 0, y1: 24 })
  })

  it('box spans half its length/width/height, centred on the origin', () => {
    const f = partFootprint(boxPart({ length: 2, width: 0.8, height: 0.4 }))
    expect(f).toEqual({ hx: 1, hz: 0.4, y0: -0.2, y1: 0.2 })
  })
})

describe('restOnSurface', () => {
  it('rests the footprint bottom on a horizontal surface, keeping x/z', () => {
    // box footprint y0 = -height/2 = -0.2; on a conveyor top at y=0.75 the
    // origin ends up at 0.95 so the bottom face touches the surface
    const box = boxPart({ height: 0.4 })
    const pos = restOnSurface(box, [1.2, 0.75, -3.4], [0, 1, 0])
    expect(pos[0]).toBeCloseTo(1.2, 10)
    expect(pos[1]).toBeCloseTo(0.95, 10)
    expect(pos[2]).toBeCloseTo(-3.4, 10)
  })

  it('pushes the part out by its half-extent along a vertical face', () => {
    const box = boxPart({ length: 0.6 })
    const pos = restOnSurface(box, [2, 1, 0], [1, 0, 0])
    expect(pos[0]).toBeCloseTo(2.3, 10) // origin sits half a length off the wall
    expect(pos[1]).toBeCloseTo(1, 10)
    expect(pos[2]).toBeCloseTo(0, 10)
  })

  it('uses the yaw-rotated extent for the offset', () => {
    // rotated 90deg, the length axis now aligns with world Z, so a +X wall
    // clears by half the width instead of half the length
    const box = boxPart({ length: 0.6, width: 0.4 }, [0, 0, 0], Math.PI / 2)
    const pos = restOnSurface(box, [2, 1, 0], [1, 0, 0])
    expect(pos[0]).toBeCloseTo(2.2, 10)
  })
})

function rackParams(over: Partial<RackGeometryParams> = {}): RackGeometryParams {
  // the retired built-in Rack's defaults. rackBoxes is the parity reference for the SDK rack.
  return { length: 2.8, width: 1.4, numShelves: 4, shelfSpacing: 1.6, enableAutoPoles: true, poleInterval: 1.4, ...over }
}

describe('rackBoxes', () => {
  it('builds an end frame every poleInterval along X with auto-poles on', () => {
    // length 2.8 / interval 1.4 -> x at {-1.4, 0, 1.4}; depth 1.4 -> z at {-0.7, 0.7}
    const g = rackBoxes(rackParams({ length: 2.8, width: 1.4, numShelves: 4, shelfSpacing: 1.6, poleInterval: 1.4 }))
    expect(g.posts).toHaveLength(6)
    expect(new Set(g.posts.map((p) => p.x))).toEqual(new Set([-1.4, 0, 1.4]))
    expect(new Set(g.posts.map((p) => p.z))).toEqual(new Set([-0.7, 0.7]))
    const post = g.posts[0]!
    expect([post.sx, post.sy, post.sz]).toEqual([RACK_FRAME_THICKNESS, 6.4, RACK_FRAME_THICKNESS])
    expect(post.y).toBeCloseTo(3.2, 10) // half of height
  })

  it('keeps a frame to its front and back uprights however deep it is, and the bay to X alone', () => {
    // poleInterval pitches the bays along X only: a frame deeper than one bay gets no middle row of uprights
    const deep = rackBoxes(rackParams({ length: 1.4, width: 3, poleInterval: 1.4 }))
    expect(new Set(deep.posts.map((p) => p.z))).toEqual(new Set([-1.5, 1.5]))
    // ...and a bay wider than the frame is deep (2.7 m bays on a 1.1 m frame) still gets both rows
    const wide = rackBoxes(rackParams({ length: 5.4, width: 1.1, poleInterval: 2.7 }))
    expect(new Set(wide.posts.map((p) => p.x))).toEqual(new Set([-2.7, 0, 2.7]))
    expect(new Set(wide.posts.map((p) => p.z))).toEqual(new Set([-0.55, 0.55]))
  })

  it('falls back to four corner posts and no load beams when auto-poles is off', () => {
    const g = rackBoxes(rackParams({ length: 2.8, width: 1.4, enableAutoPoles: false }))
    expect(g.posts).toHaveLength(4)
    expect(g.loadBeams).toHaveLength(0)
    expect(new Set(g.posts.map((p) => `${p.x},${p.z}`))).toEqual(
      new Set(['-1.4,-0.7', '-1.4,0.7', '1.4,-0.7', '1.4,0.7']),
    )
  })

  it('centers a shelf slab per level above the open floor', () => {
    const g = rackBoxes(rackParams({ numShelves: 3, shelfSpacing: 1.6 }))
    const ys = g.shelves.map((s) => s.y) // bottom (y=0) left open
    expect(ys).toHaveLength(3)
    ;[1.6, 3.2, 4.8].forEach((y, i) => expect(ys[i]!).toBeCloseTo(y, 9))
    expect([g.shelves[0]!.sx, g.shelves[0]!.sy, g.shelves[0]!.sz]).toEqual([2.8, RACK_SHELF_THICKNESS, 1.4])
  })

  it('runs front/back support beams at every level including the floor', () => {
    const g = rackBoxes(rackParams({ numShelves: 4, shelfSpacing: 1.6, width: 1.4 }))
    expect(g.supports).toHaveLength(10) // (numShelves + 1) levels x 2 faces
    const ys = [...new Set(g.supports.map((s) => Number(s.y.toFixed(6))))].sort((a, b) => a - b)
    expect(ys).toEqual([0, 1.6, 3.2, 4.8, 6.4])
    expect(new Set(g.supports.map((s) => s.z))).toEqual(new Set([-0.7, 0.7]))
    expect(g.supports[0]!.sx).toBeCloseTo(2.8 - RACK_FRAME_THICKNESS, 10)
  })
})

// A rig whose bounds are off-centre along Z and tied to its params (PartBounds.centerZ / params): a pusher whose
// origin sits on its push face, its length following its stroke and its underside its stand.
registerPackage({
  format: PACKAGE_FORMAT,
  id: 'test.offcentre',
  name: 'Off-centre',
  params: {
    stroke: { type: 'number', default: 1 },
    stand: { type: 'number', default: 0.5 },
  },
  behavior: 'definePart({ step(){} })',
  geometry: {
    kind: 'rig',
    links: [],
    joints: [],
    bounds: {
      length: 0.6, width: 2, top: 0.4, bottom: -0.5, centerZ: 1,
      params: [
        { field: 'width', param: 'stroke', scale: 2 },
        { field: 'centerZ', param: 'stroke' },
        { field: 'bottom', param: 'stand', scale: -1 },
      ],
    },
  },
} as unknown as PartPackage)

const offCentre = (params: Record<string, ParamValue>, rotationY = 0): PartInstance =>
  ({ id: 'oc_t', type: 'part', packageId: 'test.offcentre', position: [0, 0, 0], rotationY, params }) as unknown as PartInstance

describe('an off-centre, param-driven footprint (PartBounds.centerZ + params)', () => {
  it('reports the box centre as cz and follows the params', () => {
    expect(partFootprint(offCentre({ stroke: 1, stand: 0.5 }))).toEqual({ hx: 0.3, hz: 1, y0: -0.5, y1: 0.4, cz: 1 })
    expect(partFootprint(offCentre({ stroke: 1.5, stand: 0.8 }))).toEqual({ hx: 0.3, hz: 1.5, y0: -0.8, y1: 0.4, cz: 1.5 })
  })

  it('keeps the static field when a param would invert the box', () => {
    // a zero width and a bottom above the top fall back to the declared values
    expect(partFootprint(offCentre({ stroke: 0, stand: -1 }))).toMatchObject({ hz: 1, y0: -0.5 })
  })

  it('rests against a wall by the box face, not a face mirrored about the origin', () => {
    // the box spans z 0..3 (centre 1.5, half 1.5): resting against a wall facing -Z puts its +Z face on it
    const p = restOnSurface(offCentre({ stroke: 1.5, stand: 0.5 }), [0, 0, 5], [0, 0, -1])
    expect(p[2]).toBeCloseTo(5 - 3, 9)
    // ...and on the floor, its underside: the stand below the origin
    expect(restOnSurface(offCentre({ stroke: 1.5, stand: 0.8 }), [0, 0, 0], [0, 1, 0])[1]).toBeCloseTo(0.8, 9)
  })
})
