import { beforeEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from './partRegistry'
import type { PartPackage } from './partPackage'
import {
  bedView,
  constrainResizeExtent,
  conveyorLocalEnds,
  curvedGizmoOf,
  curvedHandleLocal,
  curvedHandleValue,
  effectiveResize,
  isBeltLike,
  isConveyorLike,
  isTailOriginConveyor,
  partFootprint,
  partNumberRange,
  resizeBeltSegmentLength,
  resizeParamKey,
  resizePart,
} from './partGeometry'
import type { SdkPart } from '../types'
import { PACKAGE_FORMAT } from './partPackage'

// A custom part authored like the SDK belt: procedural `function` geometry that conveys, a `segments`
// numberList ([length, tilt] rows) carrying a `path` handle, and a `width` number carrying a `face` handle.
// This is the declared-gizmo contract from docs/part-gizmos.md. The engine should give it the built-in
// belt's resize handles without any per-type special-casing.
function beltPkg(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.belt',
    name: 'Acme Belt', conveyor: { bed: 'path', surface: 'belt' },
    params: {
      segments: { type: 'numberList', arity: 2, default: [[3, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
      width: { type: 'number', default: 1, min: 0.2, max: 3, handle: { kind: 'face', axis: 'z' } },
      height: { type: 'number', default: 0.28, min: 0.1, max: 0.6 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 3, width: 1, top: 0.28 }, conveys: true },
    ...over,
  } as PartPackage
}

function beltPart(segments: number[][], width = 1): SdkPart {
  return {
    id: 'cp_1',
    type: 'part',
    packageId: 'acme.belt',
    position: [0, 0, 0],
    rotationY: 0,
    params: { segments, width, height: 0.28 },
  } as unknown as SdkPart
}

beforeEach(() => clearPackages())

describe('declared part gizmos (docs/part-gizmos.md)', () => {
  it('a `path` + `face` handle makes a function/conveys custom part belt-like and resizable', () => {
    registerPackage(beltPkg())
    const part = beltPart([[3, 0]])
    expect(isBeltLike(part)).toBe(true)
    // length (path handle) along X, width (face handle on z) along Z
    expect(effectiveResize(part)).toEqual({ x: true, z: true })
  })

  it('a path bed view normalizes numberList rows to {length, tiltDeg} and writes them back as rows', () => {
    registerPackage(beltPkg())
    const view = bedView(beltPart([[3, 0], [2, 15]]), 'path')
    expect(view).not.toBeNull()
    expect(view!.segments).toEqual([{ length: 3, tiltDeg: 0 }, { length: 2, tiltDeg: 15 }])
    expect(view!.width).toBe(1)
    // writeback returns the part's native numberList shape, not {length,tiltDeg} objects
    expect(view!.writeSegments([{ length: 4, tiltDeg: 0 }, { length: 2, tiltDeg: 15 }])).toEqual({
      segments: [[4, 0], [2, 15]],
    })
  })

  it('a missing/declared `path` handle is required - a plain custom part is not belt-like', () => {
    registerPackage(beltPkg({ id: 'acme.plain', params: { width: { type: 'number', default: 1 } } }))
    const plain = { ...beltPart([[3, 0]]), packageId: 'acme.plain' } as SdkPart
    expect(isBeltLike(plain)).toBe(false)
    expect(bedView(plain, 'path')).toBeNull()
  })

  it('belt-like parts are tail-origin, so width handles centre at mid-length (like the built-in)', () => {
    registerPackage(beltPkg())
    // tail-origin → paramCenterX is half-length (mid), not 0 (the tail); the render layer reads this for the
    // width-handle X. A non-belt custom part stays origin-centred.
    expect(isTailOriginConveyor(beltPart([[3, 0]]))).toBe(true)
    registerPackage(beltPkg({ id: 'acme.plain', params: { width: { type: 'number', default: 1 } } }))
    const plain = { ...beltPart([[3, 0]]), packageId: 'acme.plain' } as SdkPart
    expect(isTailOriginConveyor(plain)).toBe(false)
  })

  it('the belt footprint reflows with the segments (not the stale baked bounds)', () => {
    registerPackage(beltPkg())
    const short = partFootprint(beltPart([[3, 0]]))
    const long = partFootprint(beltPart([[6, 0]]))
    expect(long.hx).toBeGreaterThan(short.hx) // longer belt → wider X footprint
    expect(short.hz).toBeCloseTo(0.5, 6) // width 1 → ±0.5
    expect(short.hx).toBeGreaterThan(0) // not the zero footprint of the function-geometry fallthrough
  })

  it('a belt segment-end drag writes the new length back in numberList rows', () => {
    registerPackage(beltPkg())
    const r = resizeBeltSegmentLength(beltPart([[3, 0], [2, 0]]), 1, 5)
    expect((r.params as { segments: number[][] }).segments).toEqual([[3, 0], [5, 0]])
  })

  it('partNumberRange reads the custom part width clamp from the package schema', () => {
    registerPackage(beltPkg())
    expect(partNumberRange(beltPart([[3, 0]]), 'width')).toEqual({ min: 0.2, max: 3 })
    // a width (z-axis) resize stays a pure width-param change on the custom part
    const r = resizePart(beltPart([[3, 0]]), 'z', 1, 2)
    expect((r.params as { width: number }).width).toBe(2)
  })
})

// A straight SDK conveyor authored like the roller family: a rig part with a `conveys` deck link and `face`
// handles on a length (X) + width (Z) param. The engine should give it the built-in roller's resize handles,
// a footprint that reflows with the params, and straight end-to-end snap ends, without any per-type casing.
function rollerPkg(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.roller',
    name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 3, min: 0.5, max: 20, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 1, min: 0.2, max: 3, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 1, min: -3, max: 3 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: {
      kind: 'rig',
      links: [{ name: 'deck', shape: { kind: 'box', size: [3, 0.04, 1] }, conveys: true }],
      joints: [],
      bounds: { length: 3, width: 1, top: 0.9 },
    },
    ...over,
  } as PartPackage
}

function rollerPart(length = 3, width = 1): SdkPart {
  return {
    id: 'cp_r',
    type: 'part',
    packageId: 'acme.roller',
    position: [0, 0, 0],
    rotationY: 0,
    params: { length, width, speed: 1 },
  } as unknown as SdkPart
}

describe('straight SDK conveyors (roller family, declared face handles)', () => {
  it('a `conveys` rig + length/width `face` handles is a straight, resizable, snapping conveyor', () => {
    registerPackage(rollerPkg())
    const part = rollerPart()
    expect(bedView(part, 'straight')).toEqual({ length: 3, width: 1, height: 0.9 })
    expect(effectiveResize(part)).toEqual({ x: true, z: true })
    expect(isConveyorLike(part)).toBe(true)
    expect(isBeltLike(part)).toBe(false) // not belt-like (no path handle): it's the straight family
  })

  it('is centre-origin (not tail-origin) with ends at ±length/2 along local X', () => {
    registerPackage(rollerPkg())
    expect(isTailOriginConveyor(rollerPart(4))).toBe(false)
    // copy before sorting: conveyorLocalEnds returns a shared memoized array (treat as immutable)
    const ends = [...conveyorLocalEnds(rollerPart(4))].sort((a, b) => a.x - b.x)
    expect(ends.map((e) => e.x)).toEqual([-2, 2])
    expect(ends.map((e) => e.outX)).toEqual([-1, 1])
  })

  it('the footprint reflows with the length/width params (not the stale baked bounds)', () => {
    registerPackage(rollerPkg())
    const short = partFootprint(rollerPart(3, 1))
    const long = partFootprint(rollerPart(8, 2))
    expect(short.hx).toBeCloseTo(1.5, 6)
    expect(short.hz).toBeCloseTo(0.5, 6)
    expect(long.hx).toBeCloseTo(4, 6)
    expect(long.hz).toBeCloseTo(1, 6)
    expect(short.cx ?? 0).toBe(0) // centre-origin, unlike the tail-origin belt
  })

  // a roller package declaring the incline marker + a tiltDeg param
  const inclinedRollerPkg = (): PartPackage =>
    rollerPkg({
      params: {
        length: { type: 'number', default: 3, min: 0.5, max: 20, handle: { kind: 'face', axis: 'x' } },
        width: { type: 'number', default: 1, min: 0.2, max: 3, handle: { kind: 'face', axis: 'z' } },
        speed: { type: 'number', default: 1, min: -3, max: 3 },
        tiltDeg: { type: 'number', default: 0, min: -30, max: 30 },
      },
      geometry: {
        kind: 'rig',
        inclineParam: 'tiltDeg',
        maxInclineDeg: 30,
        links: [{ name: 'deck', shape: { kind: 'box', size: [3, 0.04, 1] }, offset: [0, 0, 0], conveys: true }],
        joints: [],
        bounds: { length: 3, width: 1, top: 0.9 },
      },
    })

  it('an inclined bed (inclineParam) grows the footprint vertically - raised head + lowered tail', () => {
    registerPackage(inclinedRollerPkg())
    const at = (tiltDeg: number) => partFootprint({ ...rollerPart(4), params: { length: 4, width: 1, speed: 1, tiltDeg } } as never)
    const flat = at(0)
    const tilted = at(20)
    const rise = 2 * Math.sin((20 * Math.PI) / 180) // hx = length/2 = 2; the ends move ±hx·sin
    expect(tilted.y1).toBeCloseTo(flat.y1 + rise, 6)
    expect(tilted.y0).toBeCloseTo(flat.y0 - rise, 6)
    // and narrows in plan to (L/2)·cos, where the ends are. Covering (L/2)(1 - cos) past each end would make a
    // neighbour butted on the head read as overlapping.
    expect(tilted.hx).toBeCloseTo(flat.hx * Math.cos((20 * Math.PI) / 180), 6)
    expect(at(-20).y1).toBeCloseTo(tilted.y1, 6) // decline grows it the same (|sin|)
  })

  it('an inclined bed length-resize holds the opposite end fixed along the slope (cos plan shift + sin rise)', () => {
    registerPackage(inclinedRollerPkg())
    const part = { ...rollerPart(4), params: { length: 4, width: 1, speed: 1, tiltDeg: 20 } } as unknown as SdkPart
    const th = (20 * Math.PI) / 180
    // drag the +X (head) handle from 4 → 6: the origin slides Δ/2 = 1 up the slope (cos in plan, sin up)…
    const r = resizePart(part, 'x', 1, 6)
    expect(r.position[0]).toBeCloseTo(Math.cos(th), 10)
    expect(r.position[1]).toBeCloseTo(Math.sin(th), 10)
    // …so the tail end (local −L′/2 through Rz(tilt) from the new origin) is exactly the old tail end
    expect(r.position[0] - 3 * Math.cos(th)).toBeCloseTo(-2 * Math.cos(th), 10)
    expect(r.position[1] - 3 * Math.sin(th)).toBeCloseTo(-2 * Math.sin(th), 10)
    // a flat bed keeps the pure plan shift - no rise
    const flat = resizePart(rollerPart(4), 'x', 1, 6)
    expect(flat.position).toEqual([1, 0, 0])
  })

  it("an inclined length-resize carries the origin rise into the rest:'surfaceBelow' param (feet stay planted)", () => {
    const pkg = inclinedRollerPkg()
    ;(pkg.params as Record<string, unknown>).standHeight = { type: 'number', default: 2, min: 0.1, max: 3, rest: 'surfaceBelow' }
    registerPackage(pkg)
    const th = (20 * Math.PI) / 180
    const part = { ...rollerPart(4), params: { length: 4, width: 1, speed: 1, tiltDeg: 20, standHeight: 2 } } as unknown as SdkPart
    const standOf = (r: ReturnType<typeof resizePart>) => (r.params as { standHeight: number }).standHeight
    // +X (head) drag 4 → 6: the origin rises by sin(tilt), and standHeight grows by the same amount. The trestle
    // feet plane (origin.y − standHeight) stays where it was, so the legs stay on the floor.
    const r = resizePart(part, 'x', 1, 6)
    expect(r.position[1]).toBeCloseTo(Math.sin(th), 10)
    expect(standOf(r)).toBeCloseTo(2 + Math.sin(th), 10)
    expect(r.position[1] - standOf(r)).toBeCloseTo(part.position[1] - 2, 10)
    // −X (tail) drag lengthening drops the origin down the slope, and the legs shorten by the same sin part
    const r2 = resizePart(part, 'x', -1, 6)
    expect(standOf(r2)).toBeCloseTo(2 - Math.sin(th), 10)
    expect(r2.position[1] - standOf(r2)).toBeCloseTo(part.position[1] - 2, 10)
    // flat bed: no vertical shift, the rest param is untouched
    const flat = resizePart({ ...part, params: { ...part.params, tiltDeg: 0 } } as unknown as SdkPart, 'x', 1, 6)
    expect(standOf(flat)).toBe(2)
    // a width (Z) resize never raises the origin, so the rest param is untouched there too
    const rz = resizePart(part, 'z', 1, 2)
    expect(standOf(rz)).toBe(2)
  })

  it('a face-handle resize is a pure length/width param change (centre held)', () => {
    registerPackage(rollerPkg())
    const rx = resizePart(rollerPart(3, 1), 'x', 1, 5)
    expect((rx.params as { length: number }).length).toBe(5)
    const rz = resizePart(rollerPart(3, 1), 'z', 1, 2)
    expect((rz.params as { width: number }).width).toBe(2)
    expect(partNumberRange(rollerPart(), 'length')).toEqual({ min: 0.5, max: 20 })
  })

  it('a rotating-deck rig (revolute joint on a cylinder deck) is a turntable-like conveyor with rim ends', () => {
    registerPackage(
      rollerPkg({
        conveyor: { bed: 'turntable', surface: 'roller' },
        id: 'acme.turntable',
        params: { width: { type: 'number', default: 1, min: 0.3, max: 3 } } as PartPackage['params'],
        geometry: {
          kind: 'rig',
          links: [{ name: 'deck', shape: { kind: 'cylinder', radius: 0.75, height: 0.1, sizeParams: [{ axis: 0, param: 'width', scale: 0.75 }] }, offset: [0, 0, 0] }],
          joints: [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -7, max: 7 }],
          bounds: { length: 1.6, width: 1.6, top: 0.6 },
        } as PartPackage['geometry'],
      }),
    )
    const part = { id: 'cp_t', type: 'part', packageId: 'acme.turntable', position: [0, 0, 0], rotationY: 0, params: { width: 2 } } as unknown as SdkPart
    // radius = width(2) * scale(0.75) = 1.5 → rim ends at ±1.5
    expect(isConveyorLike(part)).toBe(true)
    // copy before sorting: conveyorLocalEnds returns a shared memoized array (treat as immutable)
    const ends = [...conveyorLocalEnds(part)].sort((a, b) => a.x - b.x)
    expect(ends.map((e) => e.x)).toEqual([-1.5, 1.5])
    const fp = partFootprint(part)
    expect(fp.hx).toBeCloseTo(1.5, 6)
    expect(fp.hz).toBeCloseTo(1.5, 6)
  })

  it('a part that declares no conveyor is not one, whatever handles it has (format 4: identity is declared)', () => {
    registerPackage(
      rollerPkg({
        id: 'acme.notconv',
        conveyor: undefined,
        geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [3, 1, 1] }, offset: [0, 0, 0] }], joints: [], bounds: { length: 3, width: 1, top: 1 } } as PartPackage['geometry'],
      }),
    )
    const part = { ...rollerPart(), packageId: 'acme.notconv' } as SdkPart
    expect(bedView(part, 'straight')).toBeNull()
    expect(conveyorLocalEnds(part)).toEqual([])
  })
})

// A curved SDK conveyor authored like the built-in curved belt: procedural `function` geometry that conveys,
// with an `arc` handle on its sweep-degrees param naming the innerRadius + width siblings. The engine should
// give it the built-in curved belt's arc resize gizmo (an 'angle' + a 'width' dot) in the SDK arc convention
// (entry local +X, sweeping toward −Z), the mirror of the built-in curve.
function curvePkg(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.curve',
    name: 'Acme Curve', conveyor: { bed: 'arc', surface: 'roller', speedParam: 'speed' },
    params: {
      innerRadius: { type: 'number', default: 0.5, min: 0.2, max: 4 },
      width: { type: 'number', default: 1.524, min: 0.2, max: 3 },
      sweepDeg: { type: 'number', default: 90, min: 15, max: 180, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width' } },
      speed: { type: 'number', default: 2 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 2.274, width: 2.274, top: 0.5 }, conveys: true },
    ...over,
  } as PartPackage
}
function curvePart(innerRadius = 0.5, width = 1.524, sweepDeg = 90): SdkPart {
  return { id: 'cp_c', type: 'part', packageId: 'acme.curve', position: [0, 0, 0], rotationY: 0, params: { innerRadius, width, sweepDeg, speed: 2 } } as unknown as SdkPart
}

describe('curved SDK conveyor arc resize gizmo (arc handle)', () => {
  it('curvedGizmoOf resolves the SDK arc params + the handle-named param keys', () => {
    registerPackage(curvePkg())
    const g = curvedGizmoOf(curvePart())
    expect(g).not.toBeNull()
    expect(g!.sdk).toBe(true)
    expect({ innerRadius: g!.innerRadius, width: g!.width, sweepDeg: g!.sweepDeg }).toEqual({ innerRadius: 0.5, width: 1.524, sweepDeg: 90 })
    expect({ sweepKey: g!.sweepKey, innerRadiusKey: g!.innerRadiusKey, widthKey: g!.widthKey }).toEqual({ sweepKey: 'sweepDeg', innerRadiusKey: 'innerRadius', widthKey: 'width' })
  })

  it('the arc handles sit on the deck: the angle dot on the arc end, the width dot on the outer rim', () => {
    registerPackage(curvePkg())
    const g = curvedGizmoOf(curvePart())!
    const rc = 0.5 + 1.524 / 2 // centreline radius 1.262
    // SDK convention: angle dot at the exit (sweep=90°) on the centreline circle → (0, −rc)
    const angle = curvedHandleLocal(g, 'angle')
    expect(angle.x).toBeCloseTo(0, 6)
    expect(angle.z).toBeCloseTo(-rc, 6)
    // width dot at the arc midpoint (45°) on the outer rim (innerRadius+width = 2.024)
    const width = curvedHandleLocal(g, 'width')
    const ro = 0.5 + 1.524
    expect(Math.hypot(width.x, width.z)).toBeCloseTo(ro, 6)
    expect(width.x).toBeGreaterThan(0) // +X/−Z quadrant
    expect(width.z).toBeLessThan(0)
  })

  it('the drag inverse round-trips the handle position back to the param value', () => {
    registerPackage(curvePkg())
    const g = curvedGizmoOf(curvePart(0.5, 1.524, 120))!
    // place the pointer exactly on each handle, then read the param back
    const a = curvedHandleLocal(g, 'angle')
    expect(curvedHandleValue(g, 'angle', a.x, a.z)).toBeCloseTo(120, 4) // recovers sweepDeg
    const w = curvedHandleLocal(g, 'width')
    expect(curvedHandleValue(g, 'width', w.x, w.z)).toBeCloseTo(1.524, 4) // recovers width
  })

  // (curvedGizmoOf resolves only an SDK `arc`-handle custom part. See docs/architecture.md.)

  it('a plain (non-conveying) custom part with no arc handle has no curved gizmo', () => {
    registerPackage(curvePkg({ id: 'acme.plaincurve', params: { sweepDeg: { type: 'number', default: 90 } }, geometry: { kind: 'drawn', bounds: { length: 1, width: 1, top: 1 } } as PartPackage['geometry'] }))
    const part = { ...curvePart(), packageId: 'acme.plaincurve' } as SdkPart
    expect(curvedGizmoOf(part)).toBeNull()
  })
})

// A structural SDK part authored like the storage rack: a plain (non-conveying) rig with X/Z face handles that
// declare a bay snap (bayParam: 'poleInterval', gated by 'enableAutoPoles'). The Z face param is `depth`, not
// 'width'. This pins that the host resolves the real handle param (not the built-in length/width naming) for both
// the bay-snap range and the resize write, and that the snap grows the footprint a bay at a time.
function rackPkg(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.rack',
    name: 'Acme Rack',
    params: {
      length: { type: 'number', default: 2.8, min: 0.5, max: 20, handle: { kind: 'face', axis: 'x', bayParam: 'poleInterval', bayGateParam: 'enableAutoPoles' } },
      depth: { type: 'number', default: 1.4, min: 0.4, max: 4, handle: { kind: 'face', axis: 'z', bayParam: 'poleInterval', bayGateParam: 'enableAutoPoles' } },
      enableAutoPoles: { type: 'boolean', default: true },
      poleInterval: { type: 'number', default: 1.4, min: 0.5, max: 3 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'shelf', shape: { kind: 'box', size: [2.8, 0.04, 1.4], sizeParams: [{ axis: 0, param: 'length' }, { axis: 2, param: 'depth' }] }, offset: [0, 0, 0] }], joints: [], bounds: { length: 2.8, width: 1.4, top: 0.1 } } as PartPackage['geometry'],
    ...over,
  } as PartPackage
}
function rackPart(over: Record<string, unknown> = {}): SdkPart {
  return { id: 'cp_r', type: 'part', packageId: 'acme.rack', position: [0, 0, 0], rotationY: 0, params: { length: 2.8, depth: 1.4, enableAutoPoles: true, poleInterval: 1.4, ...over } } as unknown as SdkPart
}

describe('structural SDK part bay-snap resize (face handle bayParam)', () => {
  it('resolves the declared z face param (depth), not the built-in "width" name', () => {
    registerPackage(rackPkg())
    expect(effectiveResize(rackPart())).toEqual({ x: true, z: true })
    expect(resizeParamKey(rackPart(), 'x')).toBe('length')
    expect(resizeParamKey(rackPart(), 'z')).toBe('depth')
  })

  it('snaps both faces to whole poleInterval bays, clamped to each param range', () => {
    registerPackage(rackPkg())
    const rack = rackPart()
    expect(constrainResizeExtent(rack, 'x', 2.2)).toBeCloseTo(2.8, 10) // 2 bays
    expect(constrainResizeExtent(rack, 'x', 2.0)).toBeCloseTo(1.4, 10) // 1 bay
    expect(constrainResizeExtent(rack, 'x', 0.3)).toBeCloseTo(1.4, 10) // never below one bay
    // depth max is 4: round(3.5/1.4)=3 → 4.2 > 4, so step back a bay → 2.8
    expect(constrainResizeExtent(rack, 'z', 3.5)).toBeCloseTo(2.8, 10)
  })

  it('resizes freely when the bay gate is off, and a part with no bay snap is untouched', () => {
    registerPackage(rackPkg())
    expect(constrainResizeExtent(rackPart({ enableAutoPoles: false }), 'z', 3.5)).toBe(3.5)
    registerPackage(rollerPkg()) // roller: face handles but no bayParam → free resize
    expect(constrainResizeExtent(rollerPart(3, 1), 'z', 2.2)).toBe(2.2)
  })

  it('resizePart writes the snapped size to depth (not a stray width param), opposite face fixed', () => {
    registerPackage(rackPkg())
    const res = resizePart(rackPart(), 'z', 1, 2.5) // drag +Z depth out toward 2.5 → snaps to 2.8
    const p = res.params as unknown as Record<string, number>
    expect(p.depth).toBeCloseTo(2.8, 10)
    expect(p.width).toBeUndefined() // the bug this guards: never writes the built-in 'width' key
    // centred in Z → origin shifts by +half the size change (opposite face stays put)
    expect(res.position[2]).toBeCloseTo((2.8 - 1.4) / 2, 10)
  })
})

// A primitive-shape part (oip.shape): a non-conveying `function` part whose three size params each carry a
// `face` handle, including the vertical one. The Y axis is the interesting case. The vertical resize dot sits
// on the footprint's top (`y1`) and the drag writes back through resizeParamKey, so a baked `bounds.height`
// would put the dot at the wrong height and make its drag jump.
function shapePkg(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.shape',
    name: 'Acme Shape',
    params: {
      length: { type: 'number', default: 1, min: 0.02, max: 40, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 1, min: 0.02, max: 40, handle: { kind: 'face', axis: 'z' } },
      height: { type: 'number', default: 1, min: 0.02, max: 20, handle: { kind: 'face', axis: 'y' } },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 1, width: 1, top: 1 } },
    ...over,
  } as PartPackage
}
function shapePart(params: Record<string, unknown> = {}): SdkPart {
  return { id: 'cp_s', type: 'part', packageId: 'acme.shape', position: [0, 0, 0], rotationY: 0, params: { length: 1, width: 1, height: 1, ...params } } as unknown as SdkPart
}

describe('vertical (axis:y) face handle', () => {
  it('offers all three resize axes and resolves the height param key', () => {
    registerPackage(shapePkg())
    expect(effectiveResize(shapePart())).toEqual({ x: true, y: true, z: true })
    expect(resizeParamKey(shapePart(), 'y')).toBe('height')
  })

  it('reflows the footprint top from the height param (the baked bounds are only the default)', () => {
    registerPackage(shapePkg())
    // 3 m tall, 2 x 4 in plan: every extent comes from the instance params, none from bounds {1,1,1}
    const fp = partFootprint(shapePart({ length: 2, width: 4, height: 3 }))
    expect(fp.hx).toBeCloseTo(1, 10)
    expect(fp.hz).toBeCloseTo(2, 10)
    expect(fp.y0).toBeCloseTo(0, 10) // base-origin: the shape sits on local y=0
    expect(fp.y1).toBeCloseTo(3, 10) // the bug this guards: 1 (the baked default) under-covers a tall block
  })

  it('a part with no vertical handle keeps its baked bounds height', () => {
    const noY = shapePkg({ params: { ...shapePkg().params, height: { type: 'number', default: 1 } } as PartPackage['params'] })
    registerPackage(noY)
    expect(effectiveResize(shapePart())).toEqual({ x: true, z: true })
    expect(partFootprint(shapePart({ height: 3 })).y1).toBeCloseTo(1, 10)
  })

  it('resizePart grows a base-origin part upward from the +Y face and drops the origin from the -Y face', () => {
    registerPackage(shapePkg())
    const up = resizePart(shapePart({ height: 1 }), 'y', 1, 2.5)
    expect((up.params as unknown as Record<string, number>).height).toBeCloseTo(2.5, 10)
    expect(up.position[1]).toBeCloseTo(0, 10) // top dragged: the base stays put
    const down = resizePart(shapePart({ height: 1 }), 'y', -1, 2.5)
    expect(down.position[1]).toBeCloseTo(-1.5, 10) // bottom dragged: the top stays put in world
  })

  it('resizePart holds the opposite face of a centre-origin part (cargo box) on either Y face', () => {
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'acme.crate',
      name: 'Acme Crate',
      params: {
        length: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'x' } },
        height: { type: 'number', default: 0.4, handle: { kind: 'face', axis: 'y' } },
        width: { type: 'number', default: 0.4, handle: { kind: 'face', axis: 'z' } },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } },
    } as unknown as PartPackage)
    const crate = { id: 'cp_c', type: 'part', packageId: 'acme.crate', position: [0, 1, 0], rotationY: 0, params: { length: 0.6, height: 0.4, width: 0.4 } } as unknown as SdkPart
    expect(effectiveResize(crate)).toEqual({ x: true, y: true, z: true })
    // footprint 0.8..1.2 in world; growing to 1.0 tall must keep the undragged face where it was
    const up = resizePart(crate, 'y', 1, 1)
    expect(up.position[1] - 0.5).toBeCloseTo(0.8, 10) // bottom stays
    expect(up.position[1] + 0.5).toBeCloseTo(1.8, 10)
    const down = resizePart(crate, 'y', -1, 1)
    expect(down.position[1] + 0.5).toBeCloseTo(1.2, 10) // top stays
    // X is already centre-symmetric in resizePart: the -X face holds on a +X drag
    const x = resizePart(crate, 'x', 1, 1)
    expect(x.position[0] - 0.5).toBeCloseTo(-0.3, 10)
  })

  it('writes the declared height param, not the built-in "height" name', () => {
    const { height: _dropped, ...plan } = shapePkg().params
    const tall = shapePkg({
      params: { ...plan, tall: { type: 'number', default: 1, handle: { kind: 'face', axis: 'y' } } } as unknown as PartPackage['params'],
    })
    registerPackage(tall)
    const part = { id: 'cp_t', type: 'part', packageId: 'acme.shape', position: [0, 0, 0], rotationY: 0, params: { length: 1, width: 1, tall: 1 } } as unknown as SdkPart
    expect(resizeParamKey(part, 'y')).toBe('tall')
    const res = resizePart(part, 'y', 1, 2)
    const p = res.params as unknown as Record<string, number>
    expect(p.tall).toBeCloseTo(2, 10)
    expect(p.height).toBeUndefined()
    expect(partFootprint({ ...part, params: { length: 1, width: 1, tall: 2 } } as unknown as SdkPart).y1).toBeCloseTo(2, 10)
  })
})
