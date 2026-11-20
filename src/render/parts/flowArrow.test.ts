import { afterEach, describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { createPart } from '../../core/scene/scene'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart, PartInstance } from '../../core/types'
import { buildFlowArrow, flowArrowSignature } from './flowArrow'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// Every conveyor is an SDK (`custom`) part, and the flow arrow routes through the core recognizers. The SDK
// block below covers the conveyor families (belt/roller/curved/turntable), including the tail-origin centring +
// raycast-inert regressions on the SDK belt.

describe('buildFlowArrow (non-conveyors)', () => {
  afterEach(() => clearPackages())
  it('returns null for structural + cargo parts that do not convey', () => {
    registerPackage(CARGO_BOX_PKG)
    const parts: PartInstance[] = [
      createPart('building', 'building_1', [0, 0, 0], 0),
      createPart('group', 'group_1', [0, 0, 0], 0),
      custom('oip.box', {}), // C-cargo custom part - payload, not a conveyor
    ]
    for (const part of parts) expect(buildFlowArrow(part), part.type).toBeNull()
  })
})

// ---- SDK (custom) conveyors: the arrow routes through the core recognizers, so a canonicalized SDK
//      belt/roller/curved/turntable shows the same flow arrow as the built-in it replaces. -------------
function pkg(over: Partial<PartPackage> & Pick<PartPackage, 'id'>): PartPackage {
  return { format: PACKAGE_FORMAT, name: over.id, params: {}, behavior: 'definePart({ step(){} })', geometry: { kind: 'drawn', bounds: { length: 2, width: 0.6, top: 0.1 }, conveys: true }, ...over } as PartPackage
}
function custom(packageId: string, params: Record<string, unknown>): SdkPart {
  return { id: `${packageId}_1`, type: 'part', packageId, position: [0, 2, 0], rotationY: 0, params } as unknown as SdkPart
}
// Cargo (box) is the C-cargo SDK part, a `custom` part whose package declares geometry.kind:'cargo' (there are
// no built-in box/pallet types; docs/architecture.md). Cargo doesn't convey, so it's a
// non-conveyor fixture for the flow-arrow recognizers below.
const CARGO_BOX_PKG: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'oip.box',
  name: 'Box',
  params: {
    length: { type: 'number', default: 0.6 }, height: { type: 'number', default: 0.4 },
    width: { type: 'number', default: 0.4 }, mass: { type: 'number', default: 10 },
    color: { type: 'color', default: '#ffffff' },
  } as PartPackage['params'],
  behavior: 'definePart({ step(){} })',
  geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } } as PartPackage['geometry'],
} as PartPackage
const SDK_BELT = pkg({
  id: 'acme.belt',
  conveyor: { bed: 'path', surface: 'belt', speedParam: 'speed' },
  params: { segments: { type: 'numberList', arity: 2, default: [[3, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } }, width: { type: 'number', default: 0.6 }, height: { type: 'number', default: 0.5 }, speed: { type: 'number', default: 2 } } as PartPackage['params'],
})
const SDK_ROLLER = pkg({
  id: 'acme.roller',
  conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
  params: { length: { type: 'number', default: 2, handle: { kind: 'face', axis: 'x' } }, width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } }, speed: { type: 'number', default: 1 } } as PartPackage['params'],
})
const SDK_CURVE = pkg({
  id: 'acme.curve',
  conveyor: { bed: 'arc', surface: 'roller', speedParam: 'speed' },
  params: { innerRadius: { type: 'number', default: 0.5 }, width: { type: 'number', default: 1.524 }, sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width' } }, speed: { type: 'number', default: 2 } } as PartPackage['params'],
})
const SDK_TURNTABLE = pkg({
  id: 'acme.turntable',
  conveyor: { bed: 'turntable', surface: 'roller' },
  params: { width: { type: 'number', default: 1.6 }, rotationSpeedDeg: { type: 'number', default: 45 } } as PartPackage['params'],
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'cylinder', radius: 0.8, height: 0.1 }, conveys: true }], joints: [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -7, max: 7 }], bounds: { length: 1.6, width: 1.6, top: 0.6 } } as unknown as PartPackage['geometry'],
})

describe('buildFlowArrow (SDK/custom conveyors)', () => {
  afterEach(() => clearPackages())

  const cases = [
    { name: 'belt-like (path handle)', pkg: SDK_BELT, part: () => custom('acme.belt', { segments: [[3, 0]], width: 0.6, height: 0.5, speed: 2 }) },
    { name: 'straight roller (face handles)', pkg: SDK_ROLLER, part: () => custom('acme.roller', { length: 2, width: 0.6, speed: 1 }) },
    { name: 'curved (arc handle)', pkg: SDK_CURVE, part: () => custom('acme.curve', { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 }) },
    { name: 'turntable (rotating deck)', pkg: SDK_TURNTABLE, part: () => custom('acme.turntable', { width: 1.6 }) },
  ] as const

  it('builds a shaft + head for every SDK conveyor family + a stable non-empty signature', () => {
    for (const c of cases) {
      registerPackage(c.pkg)
      const part = c.part()
      const arrow = buildFlowArrow(part)
      expect(arrow, c.name).not.toBeNull()
      expect(arrow!.children.length, c.name).toBeGreaterThanOrEqual(2)
      expect(flowArrowSignature(part), c.name).not.toBe('')
      clearPackages()
    }
  })

  it('returns null for a custom part that does not convey (no arrow, empty signature)', () => {
    registerPackage(pkg({ id: 'acme.widget', params: { range: { type: 'number', default: 1 } } as PartPackage['params'], geometry: { kind: 'drawn', bounds: { length: 1, width: 1, top: 1 }, conveys: false } as PartPackage['geometry'] }))
    const part = custom('acme.widget', {})
    expect(buildFlowArrow(part)).toBeNull()
    expect(flowArrowSignature(part)).toBe('')
  })

  it('flips an SDK conveyor arrow with the speed sign', () => {
    registerPackage(SDK_ROLLER)
    const head = (speed: number): Vector3 => {
      const arrow = buildFlowArrow(custom('acme.roller', { length: 2, width: 0.6, speed }))!
      return new Vector3(0, 1, 0).applyQuaternion(arrow.children[arrow.children.length - 1]!.quaternion)
    }
    expect(head(1).x).toBeGreaterThan(0.9)
    expect(head(-1).x).toBeLessThan(-0.9)
  })

  it('centres the straight arrow on the deck of a centre-origin conveyor', () => {
    // a straight (roller-family) bed is centre-origin, so its single-span arrow sits at the deck centre (x=0),
    // not hung off an end face (the built-in-era "arrow off the back face" regression).
    registerPackage(SDK_ROLLER)
    const arrow = buildFlowArrow(custom('acme.roller', { length: 2, width: 0.6, speed: 1 }))!
    // single straight span: children[0] is the shaft, centred on its midpoint
    const shaft = arrow.children[0]!
    expect(shaft.position.x).toBeCloseTo(0, 5)
  })

  it('tilts the straight arrow with an inclined bed (rig inclineParam) and re-keys on the tilt', () => {
    // an inclined straight bed pivots about its centre (rigWorldPoses' inclineRad); the arrow must climb the
    // same grade and float along the tilted normal, not hang flat over it
    registerPackage(pkg({
      id: 'acme.incline',
      conveyor: { bed: 'straight', surface: 'roller' },
      params: { ...SDK_ROLLER.params, tiltDeg: { type: 'number', default: 0 } } as PartPackage['params'],
      geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 0.6] }, conveys: true }], joints: [], inclineParam: 'tiltDeg', bounds: { length: 2, width: 0.6, top: 0.1 } } as unknown as PartPackage['geometry'],
    }))
    const part = (tiltDeg: number): SdkPart => custom('acme.incline', { length: 2, width: 0.6, speed: 1, tiltDeg })
    const arrow = buildFlowArrow(part(20))!
    const shaftDir = new Vector3(0, 1, 0).applyQuaternion(arrow.children[0]!.quaternion)
    const th = (20 * Math.PI) / 180
    expect(shaftDir.x).toBeCloseTo(Math.cos(th), 5)
    expect(shaftDir.y).toBeCloseTo(Math.sin(th), 5)
    // centred on the deck, lifted along the tilted normal
    expect(arrow.children[0]!.position.x).toBeCloseTo(-0.3 * Math.sin(th), 5)
    expect(arrow.children[0]!.position.y).toBeCloseTo(0.3 * Math.cos(th), 5)
    expect(flowArrowSignature(part(20))).not.toBe(flowArrowSignature(part(0)))
  })

  it('arrow meshes never steal raycasts', () => {
    registerPackage(SDK_ROLLER)
    const arrow = buildFlowArrow(custom('acme.roller', { length: 2, width: 0.6, speed: 1 }))!
    const hits: unknown[] = []
    for (const child of arrow.children) {
      child.raycast(null as never, hits as never)
    }
    expect(hits).toHaveLength(0)
  })

  it('changes the SDK signature with geometry + speed sign, ignores pose', () => {
    registerPackage(SDK_ROLLER)
    const a = custom('acme.roller', { length: 2, width: 0.6, speed: 1 })
    const longer = custom('acme.roller', { length: 3, width: 0.6, speed: 1 })
    const reversed = custom('acme.roller', { length: 2, width: 0.6, speed: -1 })
    expect(flowArrowSignature(longer)).not.toBe(flowArrowSignature(a))
    expect(flowArrowSignature(reversed)).not.toBe(flowArrowSignature(a))
    const moved = { ...a, position: [5, 2, 3] as [number, number, number], rotationY: 1 } as PartInstance
    expect(flowArrowSignature(moved)).toBe(flowArrowSignature(a))
  })
})

describe('flowArrowSignature', () => {
  it('is empty for non-conveyors', () => {
    expect(flowArrowSignature(createPart('group', 'b', [0, 0, 0], 0))).toBe('')
  })
})

// ---- the flex conveyor (a `flexPath` handle): its arrow follows whatever shape the bed is pulled into -----------
const SDK_FLEX = pkg({
  id: 'acme.flex',
  conveyor: { surface: 'roller', speedParam: 'speed' } as PartPackage['conveyor'],
  params: {
    points: { type: 'numberList', arity: 2, default: [[3, 0], [6, 0], [8, 0]], handle: { kind: 'flexPath', lengthParam: 'length', sections: 16 } },
    length: { type: 'number', default: 8 },
    speed: { type: 'number', default: 1 },
  } as PartPackage['params'],
})

describe('flex conveyor flow arrow', () => {
  afterEach(() => clearPackages())
  /** the arrow's shaft ends, part-local, from the meshes buildFlowArrow makes */
  const ends = (part: PartInstance): Vector3[] => {
    const arrow = buildFlowArrow(part)!
    return arrow.children.map((c) => c.position.clone())
  }

  it('runs along a straight bed over its middle, pointing with the flow', () => {
    registerPackage(SDK_FLEX)
    const pos = ends(custom('acme.flex', { points: [[3, 0], [6, 0], [8, 0]], length: 8, speed: 1 }))
    const shafts = pos.slice(0, -1)
    expect(Math.min(...shafts.map((p) => p.x))).toBeGreaterThan(1.5)
    expect(Math.max(...shafts.map((p) => p.x))).toBeLessThan(6.5)
    for (const p of pos) expect(Math.abs(p.z)).toBeLessThan(1e-6)
    expect(pos[pos.length - 1]!.x).toBeGreaterThan(6) // the head leads, toward the discharge end
    const back = ends(custom('acme.flex', { points: [[3, 0], [6, 0], [8, 0]], length: 8, speed: -1 }))
    expect(back[back.length - 1]!.x).toBeLessThan(2) // reversed: it heads back toward the infeed
  })

  it('bends round with the bed, and re-keys when the bed is pulled', () => {
    registerPackage(SDK_FLEX)
    const curved = custom('acme.flex', { points: [[4, 0], [8, -3], [9, -7]], length: 12, speed: 1 })
    const pos = ends(curved)
    expect(pos[pos.length - 1]!.z).toBeLessThan(-2) // the head has come round with the bend
    expect(pos[0]!.z).toBeGreaterThan(-1)
    const straight = custom('acme.flex', { points: [[3, 0], [6, 0], [8, 0]], length: 8, speed: 1 })
    expect(flowArrowSignature(curved)).not.toBe(flowArrowSignature(straight))
  })
})
