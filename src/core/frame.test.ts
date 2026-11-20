import { describe, expect, it } from 'vitest'
import type { ParamValue, PartInstance } from './types'
import { MAX_BOXES, PALLET_SIZE } from './types'
import type { PartPackage } from './parts/partPackage'
import { registerPackage } from './parts/partRegistry'
import { createPart } from './scene/scene'
import { CARGO_KIND_BOX, CARGO_KIND_PALLET, buildAuthoredCargoFrame, memoizeAuthoredCargoFrame } from './frame'
import { hexToRgb } from './math'
import { PACKAGE_FORMAT } from './parts/partPackage'

// Cargo (box/pallet) is the C-cargo SDK part (a `custom` part whose package declares geometry.kind:'cargo';
// docs/architecture.md). cargoView / the SDK footprint are pinned in render/parts/cargoPartsParity.test.ts;
// this file covers buildAuthoredCargoFrame's own mechanics
// (scene-order filtering, param/size, sRGB colour, YXZ quaternion, stable ids, MAX_BOXES clamp) on the cargo
// parts, so we register the two cargo packages here and build the fixtures as their custom instances.

function cargoPkg(id: string, name: string, cargoKind: 'box' | 'pallet', params: PartPackage['params']): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name,
    params,
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'cargo', cargoKind, size: { length: 0.6, width: 0.4, height: 0.4 } },
  } as unknown as PartPackage
}
registerPackage(cargoPkg('oip.box', 'Box', 'box', {
  length: { type: 'number', default: 0.6 },
  height: { type: 'number', default: 0.4 },
  width: { type: 'number', default: 0.4 },
  mass: { type: 'number', default: 10 },
  color: { type: 'color', default: '#ffffff' },
} as unknown as PartPackage['params']))
registerPackage(cargoPkg('oip.pallet', 'Pallet', 'pallet', {
  mass: { type: 'number', default: 20 },
  color: { type: 'color', default: '#ffffff' },
} as unknown as PartPackage['params']))

function box(id: string, over: Record<string, ParamValue> = {}, position: [number, number, number] = [0, 0, 0], rotationY = 0): PartInstance {
  return { id, type: 'part', packageId: 'oip.box', position: [position[0], position[1], position[2]], rotationY, params: { ...over } } as unknown as PartInstance
}
function pallet(id: string, over: Record<string, ParamValue> = {}, position: [number, number, number] = [0, 0, 0], rotationY = 0): PartInstance {
  return { id, type: 'part', packageId: 'oip.pallet', position: [position[0], position[1], position[2]], rotationY, params: { ...over } } as unknown as PartInstance
}

describe('buildAuthoredCargoFrame', () => {
  it('keeps only box/pallet parts, in scene order', () => {
    const parts = [
      createPart('building', 'bld_0', [0, 0.75, 0], 0),
      box('bx_1'),
      createPart('building', 'bld_1', [0, 0, 0], 0),
      pallet('pl_1'),
    ]
    const f = buildAuthoredCargoFrame(parts)
    expect(f.count).toBe(2)
    expect(f.partIds).toEqual(['bx_1', 'pl_1'])
    expect(f.kinds[0]).toBe(CARGO_KIND_BOX)
    expect(f.kinds[1]).toBe(CARGO_KIND_PALLET)
    expect(f.simTime).toBe(0)
  })

  it('uses param dimensions for a box and PALLET_SIZE for a pallet', () => {
    const f = buildAuthoredCargoFrame([
      box('bx_1', { length: 0.8, height: 0.5, width: 0.4 }),
      pallet('pl_1'),
    ])
    expect([f.halfExtents[0], f.halfExtents[1], f.halfExtents[2]]).toEqual([Math.fround(0.4), 0.25, Math.fround(0.2)])
    expect([f.halfExtents[3], f.halfExtents[4], f.halfExtents[5]]).toEqual([
      Math.fround(PALLET_SIZE[0] / 2), Math.fround(PALLET_SIZE[1] / 2), Math.fround(PALLET_SIZE[2] / 2),
    ])
  })

  it('copies position and writes the authored color as sRGB 0..1', () => {
    const f = buildAuthoredCargoFrame([box('bx_1', { color: '#3366ff' }, [1, 2, 3])])
    expect([f.positions[0], f.positions[1], f.positions[2]]).toEqual([1, 2, 3])
    const [r, g, b] = hexToRgb('#3366ff')
    expect([f.colors[0], f.colors[1], f.colors[2]]).toEqual([Math.fround(r), Math.fround(g), Math.fround(b)])
  })

  it('writes a yaw-only quaternion for a flat box', () => {
    const f = buildAuthoredCargoFrame([box('bx_1', {}, [0, 0, 0], 0.7)])
    expect(f.quats[0]).toBeCloseTo(0, 6)
    expect(f.quats[1]).toBeCloseTo(Math.sin(0.35), 6)
    expect(f.quats[2]).toBeCloseTo(0, 6)
    expect(f.quats[3]).toBeCloseTo(Math.cos(0.35), 6)
  })

  it('writes a full YXZ quaternion for a tilted box', () => {
    const p = box('bx_1', {}, [0, 0, 0], 0.5)
    p.rotationX = 0.3
    p.rotationZ = -0.2
    const f = buildAuthoredCargoFrame([p])
    // reference values from three's Quaternion().setFromEuler(new Euler(0.3, 0.5, -0.2, 'YXZ')),
    // the order render/parts/common.ts applyPartRotation uses - kept three-free (core is headless)
    expect(f.quats[0]).toBeCloseTo(0.11964726626912241, 6)
    expect(f.quats[1]).toBeCloseTo(0.25785889528426964, 6)
    expect(f.quats[2]).toBeCloseTo(-0.13243054739079688, 6)
    expect(f.quats[3]).toBeCloseTo(0.9495554075012554, 6)
  })

  it('gives a part a stable id across rebuilds', () => {
    const parts = [box('bx_stable')]
    const a = buildAuthoredCargoFrame(parts)
    const b = buildAuthoredCargoFrame(parts)
    expect(a.ids[0]).toBe(b.ids[0])
  })

  it('carries every authored cargo part past MAX_BOXES (the render batch grows; no idle clamp)', () => {
    const parts = Array.from({ length: MAX_BOXES + 5 }, (_, i) => box(`bx_${i}`))
    const f = buildAuthoredCargoFrame(parts)
    expect(f.count).toBe(MAX_BOXES + 5)
    expect(f.partIds).toHaveLength(MAX_BOXES + 5)
    expect(f.ids).toHaveLength(MAX_BOXES + 5)
  })
})

describe('memoizeAuthoredCargoFrame', () => {
  // a non-cargo part (what a robot tool-size drag streams), registered so it resolves like a placed part
  registerPackage({ ...cargoPkg('test.robot', 'Robot', 'box', {}), geometry: { kind: 'rig', links: [], joints: [] } } as unknown as PartPackage)
  const robot = (size: number, parent?: string): PartInstance =>
    ({ id: 'r', type: 'part', packageId: 'test.robot', position: [0, 0, 0], rotationY: 0, params: { toolSizeX: size }, ...(parent ? { parent } : {}) }) as unknown as PartInstance

  it('reuses the frame across an edit of a non-cargo part', () => {
    const memo = memoizeAuthoredCargoFrame()
    const a = box('a', {}, [1, 0, 0])
    const first = memo([a, robot(0.5)])
    expect(memo([a, robot(1.2)])).toBe(first)
  })

  it('rebuilds on a cargo edit, a parent edge or a package change, and matches an uncached build', () => {
    const memo = memoizeAuthoredCargoFrame()
    const a = box('a', {}, [1, 0, 0])
    const first = memo([a, robot(0.5)])
    const moved = [box('a', {}, [2, 0, 0]), robot(0.5)]
    const second = memo(moved)
    expect(second).not.toBe(first)
    expect(second).toEqual(buildAuthoredCargoFrame(moved))
    const parented = [moved[0]!, robot(0.5, 'g')]
    expect(memo(parented)).not.toBe(second)
    const third = memo(parented)
    registerPackage(cargoPkg('test.extra', 'Extra', 'box', {}))
    expect(memo(parented)).not.toBe(third)
  })
})
