import { afterEach, describe, expect, it } from 'vitest'
import type { SdkPart } from '../types'
import type { PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import { createPart } from '../scene/scene'
import { conveyingSurfaceAt, conveyorSurfaceVelocity } from './conveyorSurface'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// conveyorSurfaceVelocity mirrors the pilot's conveyor carry. The function recognizes straight SDK conveyors
// (belt-like `path` handle, or roller-family `face` handles: a constant forward carry along +X × `speed`), curved
// SDK conveyors (`arc` handle: the rigid-rotation field omega × (p − centre) about the part origin,
// omega = speed / centreline-radius), and rotating-deck turntables
// (the settled carry along the deck's forward rotated by `deckAngleDeg`). This file exercises all three plus the
// non-conveyor null fall-through.

// an SDK straight roller: `conveys` rig + length/width `face` handles (centre-origin straight conveyor)
function rollerPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.roller',
    name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 3, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [3, 0.04, 0.6] }, conveys: true }], joints: [], bounds: { length: 3, width: 0.6, top: 0.9 } },
  } as unknown as PartPackage
}
// an SDK belt: `function` geometry that conveys + a `path`-handle segments numberList
function beltPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.belt',
    name: 'Acme Belt', conveyor: { bed: 'path', surface: 'belt', speedParam: 'speed' },
    params: {
      segments: { type: 'numberList', arity: 2, default: [[3, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
      width: { type: 'number', default: 0.6 },
      height: { type: 'number', default: 0.5 },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 3, width: 0.6, top: 0.5 }, conveys: true },
  } as PartPackage
}
// an SDK curved conveyor: an `arc` handle on its sweep param, no straight face handles, carried along the arc
function curvePkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.curve',
    name: 'Acme Curve', conveyor: { bed: 'arc', surface: 'roller', speedParam: 'speed' },
    params: {
      innerRadius: { type: 'number', default: 0.5 },
      width: { type: 'number', default: 0.6 },
      sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width' } },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 2, width: 2, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}

// an SDK turntable: a revolute joint drives a width-parametric cylinder deck (the turntable bed's view recognizes it)
function turntablePkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.turntable',
    name: 'Acme Turntable', conveyor: { bed: 'turntable', surface: 'roller', speedParam: 'speed' },
    params: {
      width: { type: 'number', default: 0.8 },
      deckAngleDeg: { type: 'number', default: 0 },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ joints:["rotate"], step(){} })',
    geometry: {
      kind: 'rig',
      links: [{ name: 'deck', shape: { kind: 'cylinder', radius: 0.6, height: 0.1 }, offset: [0, -0.122, 0], finish: 'frame' }],
      // `rest` declares the settled deck angle as a param binding - the pilot-carry mirror reads it
      joints: [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI, rest: { param: 'deckAngleDeg', scale: Math.PI / 180 } }],
      bounds: { length: 1.2, width: 1.2, top: 0.6 },
    },
  } as unknown as PartPackage
}

function curve(speed: number, position: [number, number, number] = [0, 0, 0], rotationY = 0): SdkPart {
  return { id: 'c', type: 'part', packageId: 'acme.curve', position, rotationY, params: { innerRadius: 0.5, width: 0.6, sweepDeg: 90, speed } } as unknown as SdkPart
}
function turntable(speed: number, deckAngleDeg = 0, rotationY = 0): SdkPart {
  return { id: 't', type: 'part', packageId: 'acme.turntable', position: [0, 0.75, 0], rotationY, params: { width: 0.8, deckAngleDeg, speed } } as unknown as SdkPart
}

function roller(speed: number, position: [number, number, number] = [0, 0, 0], rotationY = 0): SdkPart {
  return { id: 'r', type: 'part', packageId: 'acme.roller', position, rotationY, params: { length: 3, width: 0.6, speed } } as unknown as SdkPart
}
function belt(speed: number, position: [number, number, number] = [0, 0, 0], rotationY = 0): SdkPart {
  return { id: 'b', type: 'part', packageId: 'acme.belt', position, rotationY, params: { segments: [[3, 0]], width: 0.6, height: 0.5, speed } } as unknown as SdkPart
}

describe('conveyorSurfaceVelocity', () => {
  afterEach(() => clearPackages())

  it('carries a straight SDK roller along its +X at the belt speed', () => {
    registerPackage(rollerPkg())
    const v = conveyorSurfaceVelocity(roller(2), 0, 0)
    expect(v).not.toBeNull()
    expect(v!.vx).toBeCloseTo(2, 10)
    expect(v!.vz).toBeCloseTo(0, 10)
  })

  it('rotates the carry direction with the part yaw', () => {
    registerPackage(beltPkg())
    // yaw +90 deg turns local +X to world -Z
    const v = conveyorSurfaceVelocity(belt(3, [0, 0, 0], Math.PI / 2), 0, 0)
    expect(v!.vx).toBeCloseTo(0, 10)
    expect(v!.vz).toBeCloseTo(-3, 10)
  })

  it('reverses with a negative speed and stops at zero', () => {
    registerPackage(rollerPkg())
    registerPackage(beltPkg())
    expect(conveyorSurfaceVelocity(roller(-1.5), 0, 0)!.vx).toBeCloseTo(-1.5, 10)
    expect(conveyorSurfaceVelocity(belt(0), 0, 0)).toBeNull()
  })

  it('carries around a curved SDK conveyor tangent to the arc (omega × (p − centre))', () => {
    registerPackage(curvePkg())
    // rc = innerRadius + width/2 = 0.5 + 0.3 = 0.8, omega = speed / rc. At the arc entry (local +X, world
    // (0.8, 0) for a part at the origin) the flow is toward −Z at the belt speed; a quarter-turn later, at the
    // exit (0, −0.8), the tangent has rotated to −X. Speed 2 ⇒ centreline surface speed 2 at both.
    const entry = conveyorSurfaceVelocity(curve(2), 0.8, 0)
    expect(entry!.vx).toBeCloseTo(0, 10)
    expect(entry!.vz).toBeCloseTo(-2, 10)
    const exit = conveyorSurfaceVelocity(curve(2), 0, -0.8)
    expect(exit!.vx).toBeCloseTo(-2, 10)
    expect(exit!.vz).toBeCloseTo(0, 10)
    // stopped curve carries nothing
    expect(conveyorSurfaceVelocity(curve(0), 0.8, 0)).toBeNull()
  })

  it('carries a settled turntable along its deck forward, rotated by deckAngleDeg', () => {
    registerPackage(turntablePkg())
    // deck at 0°: carry along the part forward (+X) at speed
    const flat = conveyorSurfaceVelocity(turntable(1, 0), 0, 0)
    expect(flat!.vx).toBeCloseTo(1, 10)
    expect(flat!.vz).toBeCloseTo(0, 10)
    // deck slewed 90°: the lane forward turns to −Z
    const turned = conveyorSurfaceVelocity(turntable(1, 90), 0, 0)
    expect(turned!.vx).toBeCloseTo(0, 10)
    expect(turned!.vz).toBeCloseTo(-1, 10)
    // stopped turntable carries nothing
    expect(conveyorSurfaceVelocity(turntable(0, 0), 0, 0)).toBeNull()
  })

  it('returns null for non-conveying parts', () => {
    expect(conveyorSurfaceVelocity(createPart('building', 'b', [0, 0, 0], 0), 0, 0)).toBeNull()
  })
})

describe('conveyingSurfaceAt (the physics-true surface plane - what the Alt face snap seats on)', () => {
  afterEach(() => clearPackages())

  it('a flat roller bed: origin height, up normal; null off the bed', () => {
    registerPackage(rollerPkg())
    const part = { id: 'r', type: 'part', packageId: 'acme.roller', position: [0, 0.75, 0], rotationY: 0, params: { length: 3, width: 0.6, speed: 1 } } as unknown as SdkPart
    const s = conveyingSurfaceAt(part, 0.5, 0.1)
    expect(s).not.toBeNull()
    expect(s!.y).toBeCloseTo(0.75, 9) // the conveying surface sits at the origin height, not the padded proxy top
    expect(s!.normal[1]).toBeCloseTo(1, 9)
    expect(conveyingSurfaceAt(part, 0, 0.5)).toBeNull() // beside the bed
    expect(conveyingSurfaceAt(part, 2, 0)).toBeNull() // past the end
  })

  it('an inclined roller bed: height rises with local X, the normal leans back by the tilt', () => {
    const base = rollerPkg() as unknown as { geometry: object; params: object }
    registerPackage({
      ...base,
      id: 'acme.roller-inc',
      params: { ...base.params, tiltDeg: { type: 'number', default: 0 } },
      geometry: { ...base.geometry, inclineParam: 'tiltDeg' },
    } as unknown as PartPackage)
    const part = { id: 'r', type: 'part', packageId: 'acme.roller-inc', position: [0, 0.75, 0], rotationY: 0, params: { length: 3, width: 0.6, speed: 1, tiltDeg: 15 } } as unknown as SdkPart
    const th = (15 * Math.PI) / 180
    const s = conveyingSurfaceAt(part, 0.5, 0)
    expect(s).not.toBeNull()
    expect(s!.y).toBeCloseTo(0.75 + 0.5 * Math.tan(th), 6)
    expect(s!.normal[0]).toBeCloseTo(-Math.sin(th), 6)
    expect(s!.normal[1]).toBeCloseTo(Math.cos(th), 6)
    expect(s!.normal[2]).toBeCloseTo(0, 9)
    // the plan extent shrinks with the tilt: just past (L/2)·cosθ is off the bed
    expect(conveyingSurfaceAt(part, 1.5 * Math.cos(th) + 0.01, 0)).toBeNull()
  })

  it('a belt with an inclined segment follows the path profile; unresolved parts → null', () => {
    registerPackage(beltPkg())
    const part = { id: 'b', type: 'part', packageId: 'acme.belt', position: [0, 0.75, 0], rotationY: 0, params: { segments: [[3, 10]], width: 0.6, height: 0.5, speed: 1 } } as unknown as SdkPart
    const s = conveyingSurfaceAt(part, 1.5, 0) // mid-run of a single 10° climb (tail-origin)
    expect(s).not.toBeNull()
    expect(s!.y).toBeGreaterThan(0.75) // risen along the incline
    expect(s!.normal[0]).toBeLessThan(-0.1) // leaning back against the climb
    expect(s!.normal[1]).toBeGreaterThan(0.9)
    const ghost = { id: 'g', type: 'part', packageId: 'acme.missing', position: [0, 0, 0], rotationY: 0, params: {} } as unknown as SdkPart
    expect(conveyingSurfaceAt(ghost, 0, 0)).toBeNull()
  })
})
