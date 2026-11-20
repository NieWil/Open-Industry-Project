import { afterEach, describe, expect, it } from 'vitest'
import type { SdkPart } from '../types'
import type { PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import { partFootprint } from '../parts/partGeometry'
import { collisionVerticesLocal } from './collisionGeometry'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// The editor collision proxy is a uniform footprint box for every part (collisionShapes.collisionProxy →
// footprintHull), so collisionVerticesLocal emits the 8 footprint-box corners. Covered here: a plain box, and a
// straight SDK conveyor whose footprint reflows with its params.

// Cargo (box) is the C-cargo SDK part: a `custom` part whose package declares geometry.kind:'cargo'
// (docs/architecture.md). Its centre-origin box footprint is read through cargoView, so the fixture registers the
// package and builds an `oip.box` custom instance.
function boxPkg(): PartPackage {
  return {
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
  } as unknown as PartPackage
}
function box(length: number, height: number, width: number): SdkPart {
  return {
    id: 'b',
    type: 'part',
    packageId: 'oip.box',
    position: [0, height / 2, 0],
    rotationY: 0,
    params: { length, height, width, mass: 1, color: '#ccc' },
  }
}

// a straight SDK roller conveyor: a `conveys` rig with length (X) + width (Z) `face` handles - centre-origin,
// its footprint reflows with the params (its straight bed's footprint), exactly the surviving conveyor proxy path.
function sdkRollerPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.roller',
    name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 4, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 1, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 0.5 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: {
      kind: 'rig',
      links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.04, 1] }, conveys: true }],
      joints: [],
      bounds: { length: 4, width: 1, top: 0.9 },
    },
  } as unknown as PartPackage
}
function sdkRoller(length = 4, width = 1): SdkPart {
  return { id: 'r', type: 'part', packageId: 'acme.roller', position: [0, 0.75, 0], rotationY: 0, params: { length, width, speed: 0.5 } } as unknown as SdkPart
}

describe('collisionVerticesLocal', () => {
  afterEach(() => clearPackages())

  it('emits the eight footprint-box corners for a box-like part', () => {
    registerPackage(boxPkg())
    const part = box(2, 1, 0.8)
    const fp = partFootprint(part)
    const v = collisionVerticesLocal(part)
    expect(v).toHaveLength(8)
    // every corner sits on the footprint box surface (|x|=hx, |z|=hz, y in {y0,y1})
    for (const p of v) {
      expect(Math.abs(p.x)).toBeCloseTo(fp.hx, 6)
      expect(Math.abs(p.z)).toBeCloseTo(fp.hz, 6)
      expect(p.y === fp.y0 || p.y === fp.y1).toBe(true)
    }
    // all eight are distinct
    const keys = new Set(v.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`))
    expect(keys.size).toBe(8)
  })

  describe('SDK straight conveyor', () => {
    afterEach(() => clearPackages())

    it('uses the reflowed footprint box for a straight SDK roller (length x width slab)', () => {
      registerPackage(sdkRollerPkg())
      const part = sdkRoller(4, 1)
      const fp = partFootprint(part)
      const cx = fp.cx ?? 0
      const v = collisionVerticesLocal(part)
      expect(v).toHaveLength(8)
      // centre-origin bed: slab runs local x cx-hx .. cx+hx, z ±width/2
      expect(Math.min(...v.map((p) => p.x))).toBeCloseTo(cx - fp.hx, 6)
      expect(Math.max(...v.map((p) => p.x))).toBeCloseTo(cx + fp.hx, 6)
      expect(Math.max(...v.map((p) => p.z))).toBeCloseTo(fp.hz, 6) // width/2
    })
  })
})
