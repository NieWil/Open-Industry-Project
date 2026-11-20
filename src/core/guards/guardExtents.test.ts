import { afterEach, describe, expect, it } from 'vitest'
import type { SdkPart } from '../types'
import type { PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import { toWorldXZ } from '../parts/partGeometry'
import { computeSceneExtents, deriveGuardExtents, extentsKey, withSnapExtents } from './guardExtents'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// The hosts and spurs guardExtents recognizes are SDK (`custom`) parts. A spur is a face-handle bed declaring
// angleFront/BackParam (its spur bed). A host is a belt-like or straight SDK conveyor (hostGeom). These tests
// cover an SDK spur butting an SDK straight host.

/** an SDK spur package: the length face handle declares the splay params (+ a guardExtents param to fold into) */
function sdkSpurPkg(id: string, withExtentsParam = true): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'SDK Spur', conveyor: { bed: 'spur', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 2, handle: { kind: 'face', axis: 'x', angleFrontParam: 'angleFrontDeg', angleBackParam: 'angleBackDeg' } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      angleFrontDeg: { type: 'number', default: 0 },
      angleBackDeg: { type: 'number', default: 0 },
      speed: { type: 'number', default: 1 },
      ...(withExtentsParam ? { guardExtents: { type: 'numberList', arity: 3, default: [] } } : {}),
    },
    behavior: 'definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: 0, y: 0, z: 0 }) } })',
    geometry: { kind: 'drawn', bounds: { length: 2, width: 0.6, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}

/** an SDK straight conveyor package (face handles, no splay params) - a centre-origin host */
function sdkStraightPkg(id: string): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'SDK Straight', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 4, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: 0, y: 0, z: 0 }) } })',
    geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}

function sdkSpur(id: string, packageId: string, x: number, z: number, rot = 0, angleFront = 0, angleBack = 0): SdkPart {
  return {
    id,
    type: 'part',
    packageId,
    position: [x, 0.75, z],
    rotationY: rot,
    params: { length: 2, width: 0.6, angleFrontDeg: angleFront, angleBackDeg: angleBack },
  } as unknown as SdkPart
}

// an SDK straight host instance (centre-origin: bed x ∈ [−length/2, +length/2], +Z outer wall at width/2 + wall)
function sdkStraight(id: string, x = 0, z = 0, rot = 0, length = 4): SdkPart {
  return { id, type: 'part', packageId: 'test.sdkstraight', position: [x, 0.75, z], rotationY: rot, params: { length, width: 0.6 } } as unknown as SdkPart
}

describe('deriveGuardExtents (SDK spur ↔ SDK straight host)', () => {
  const setup = (): void => {
    clearPackages()
    registerPackage(sdkSpurPkg('test.sdkspur'))
    registerPackage(sdkSpurPkg('test.sdkspur-noext', false))
    registerPackage(sdkStraightPkg('test.sdkstraight'))
  }
  afterEach(() => clearPackages())

  it('extends only the leading (front) end of a spur out to the host wall it butts', () => {
    setup()
    // host along X at origin, +Z outer wall at z = 0.31; the SDK spur is centre-origin (front face at local
    // x = +1), rotated +90° so its front points along world −Z, placed just short of the wall.
    const host = sdkStraight('host')
    const sp = sdkSpur('sp', 'test.sdkspur', 1, 1.41, Math.PI / 2)
    const e = deriveGuardExtents(sp, [host, sp])

    // only the front (leading) end extends; the back is untouched
    expect(e.leftBack).toBeUndefined()
    expect(e.rightBack).toBeUndefined()
    expect(e.leftFront).toBeCloseTo(1.1, 3)
    expect(e.rightFront).toBeCloseTo(1.1, 3)

    // the extended front guard end lands exactly on the host wall plane (world z = 0.31)
    expect(toWorldXZ(sp, e.leftFront!, -0.31).z).toBeCloseTo(0.31, 3)
    expect(toWorldXZ(sp, e.rightFront!, 0.31).z).toBeCloseTo(0.31, 3)

    // and computeSceneExtents picks the SDK spur up
    expect([...computeSceneExtents([host, sp]).keys()]).toEqual(['sp'])
  })

  it('returns nothing when the spur is nowhere near a host', () => {
    setup()
    const host = sdkStraight('host')
    const sp = sdkSpur('sp', 'test.sdkspur', 20, 20, Math.PI / 2)
    expect(deriveGuardExtents(sp, [host, sp])).toEqual({})
  })

  it('retracts a flush straight mover\'s leading end back to the host wall plane', () => {
    setup()
    // straight mover (length 2, centre-origin), rotated +90° so its front points along world −Z, mated
    // flush on the host's +Z bed edge (z = 0.3): front face at z = 0.3 → centre at z = 1.3. Its rails
    // overshoot the host's outer wall plane (z = 0.31) by the wall thickness → both leading rail ends
    // retract from local x = +1 to x = +0.99 (the wall plane), backs untouched.
    const host = sdkStraight('host')
    const mover = sdkStraight('mover', 1, 1.3, Math.PI / 2, 2)
    const e = deriveGuardExtents(mover, [host, mover])
    expect(e.leftBack).toBeUndefined()
    expect(e.rightBack).toBeUndefined()
    expect(e.leftFront).toBeCloseTo(0.99, 3)
    expect(e.rightFront).toBeCloseTo(0.99, 3)
    // the retracted ends land exactly on the host wall plane (world z = 0.31)
    expect(toWorldXZ(mover, e.leftFront!, -0.31).z).toBeCloseTo(0.31, 3)
    expect(toWorldXZ(mover, e.rightFront!, 0.31).z).toBeCloseTo(0.31, 3)
    expect([...computeSceneExtents([host, mover]).keys()]).toEqual(['mover'])
  })

  it('never extends a straight mover - a deliberately-gapped straight keeps its own ends', () => {
    setup()
    // same mover parked 0.1 m short of the wall plane: within contact tolerance (a spur here would
    // extend to close the gap), but a straight only retracts, so no extents derive.
    const host = sdkStraight('host')
    const other = sdkStraight('other', 0, 1.41, Math.PI / 2, 2)
    expect(deriveGuardExtents(other, [host, other])).toEqual({})
  })

  it('retracts a flush belt mover\'s leading end back to the host wall plane', () => {
    setup()
    // a belt-like mover (tail-origin, one flat 4 m segment, height 0.5 → drum-overhang front face at
    // local x = 4.25), rotated +90° so its front points along world −Z, mated flush on the host's +Z
    // bed edge (z = 0.3): origin z = 0.3 + 4.25. Its steel overshoots the host's outer wall plane
    // (z = 0.31) by the wall thickness → both leading ends retract to local x = 4.24.
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'test.sdkbelt',
      name: 'SDK Belt', conveyor: { bed: 'path', surface: 'belt' },
      params: {
        segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
        width: { type: 'number', default: 0.6 },
        height: { type: 'number', default: 0.5 },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
    } as unknown as PartPackage)
    const host = sdkStraight('host')
    const belt = {
      id: 'belt', type: 'part', packageId: 'test.sdkbelt', position: [1, 0.75, 0.3 + 4.25], rotationY: Math.PI / 2,
      params: { segments: [[4, 0]], width: 0.6, height: 0.5 },
    } as unknown as SdkPart
    const e = deriveGuardExtents(belt, [host, belt])
    expect(e.leftBack).toBeUndefined()
    expect(e.rightBack).toBeUndefined()
    expect(e.leftFront).toBeCloseTo(4.24, 3)
    expect(e.rightFront).toBeCloseTo(4.24, 3)
    expect([...computeSceneExtents([host, belt]).keys()]).toEqual(['belt'])
  })
})

describe('computeSceneExtents', () => {
  const setup = (): void => {
    clearPackages()
    registerPackage(sdkSpurPkg('test.sdkspur'))
    registerPackage(sdkStraightPkg('test.sdkstraight'))
  }
  afterEach(() => clearPackages())

  it('maps only spurs that actually butt a host', () => {
    setup()
    const host = sdkStraight('host')
    const sp = sdkSpur('sp', 'test.sdkspur', 1, 1.41, Math.PI / 2)
    const lonely = sdkSpur('lonely', 'test.sdkspur', 30, 30, Math.PI / 2)
    const map = computeSceneExtents([host, sp, lonely])
    expect([...map.keys()]).toEqual(['sp'])
  })
})

describe('withSnapExtents', () => {
  const setup = (): void => {
    clearPackages()
    registerPackage(sdkSpurPkg('test.sdkspur'))
    registerPackage(sdkSpurPkg('test.sdkspur-noext', false))
  }
  afterEach(() => clearPackages())

  it('folds the extents into guardExtents rows [side, backX, frontX]', () => {
    setup()
    const sp = sdkSpur('sp', 'test.sdkspur', 2, 1.41, Math.PI / 2)
    const params = withSnapExtents(sp, { length: 2, width: 0.6 }, { leftFront: 1.1, rightFront: 1.15 })
    // back keeps the part's own face (centre-origin: −length/2 = −1); front takes the override per side
    expect(params.guardExtents).toEqual([
      [-1, -1, 1.1],
      [1, -1, 1.15],
    ])
  })

  it('is a no-op without extents, or when the package declares no guardExtents param', () => {
    setup()
    const sp = sdkSpur('sp', 'test.sdkspur', 2, 1.41, Math.PI / 2)
    const base = { length: 2, width: 0.6 }
    expect(withSnapExtents(sp, base, undefined)).toBe(base)
    expect(withSnapExtents(sp, base, {})).toBe(base)
    const noExt = sdkSpur('sp2', 'test.sdkspur-noext', 2, 1.41, Math.PI / 2)
    expect(withSnapExtents(noExt, base, { leftFront: 1.1 })).toBe(base)
  })

  it('folds for a belt mover declaring guardExtents, defaulting the untouched end to its drum-overhang face', () => {
    clearPackages()
    // a belt-like package (path handle) with the guardExtents opt-in param - the straight belt's shape
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'test.sdkbelt-ext',
      name: 'SDK Belt', conveyor: { bed: 'path', surface: 'belt' },
      params: {
        segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
        width: { type: 'number', default: 0.6 },
        height: { type: 'number', default: 0.5 },
        guardExtents: { type: 'numberList', arity: 3, default: [] },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
    } as unknown as PartPackage)
    const belt = {
      id: 'b', type: 'part', packageId: 'test.sdkbelt-ext', position: [0, 0.75, 0], rotationY: 0,
      params: { segments: [[4, 0]], width: 0.6, height: 0.5 },
    } as unknown as SdkPart
    const params = withSnapExtents(belt, { width: 0.6 }, { leftFront: 4.24, rightFront: 4.24 })
    // tail-origin flat belt, height 0.5 → pulley 0.25: own faces at −0.25 (back) and 4.25 (front)
    expect(params.guardExtents).toEqual([
      [-1, -0.25, 4.24],
      [1, -0.25, 4.24],
    ])
  })
})

describe('extentsKey', () => {
  it('is stable and distinguishes a changed front extent', () => {
    expect(extentsKey(undefined)).toBe('')
    const a = extentsKey({ leftFront: 1.1, rightFront: 1.1 })
    const b = extentsKey({ leftFront: 1.2, rightFront: 1.1 })
    expect(a).toBe(extentsKey({ rightFront: 1.1, leftFront: 1.1 }))
    expect(a).not.toBe(b)
  })
})
