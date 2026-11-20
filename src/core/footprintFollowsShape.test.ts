import { afterEach, describe, expect, it } from 'vitest'
import { flexStations } from './conveyor/flexPath'
import { partFootprint } from './parts/partGeometry'
import { PACKAGE_FORMAT } from './parts/partPackage'
import type { PartPackage } from './parts/partPackage'
import { clearPackages, registerPackage } from './parts/partRegistry'
import type { PartInstance } from './types'
import flexRig from '../../examples/parts/flex-conveyor/rig.json'
import stairsRig from '../../examples/parts/stairs/rig.json'

// The footprint the editor selects, overlaps and rests a part by must sit where the part is drawn. Two shipped parts
// run forward from their origin rather than around it, so bounds centred on the origin leave half of each part
// outside its own box: the stairs (a flight from its foot) and the flex conveyor (a bed from its infeed, along a path
// that can bend). `npm run check-part` measures what each draws; these pin the box to the same shape as params move.

const N = 16 // the flex conveyor's sections

const pkg = (id: string, geometry: unknown, params: PartPackage['params']): PartPackage =>
  ({ format: PACKAGE_FORMAT, id, name: id, params, behavior: 'definePart({ step() {} })', geometry }) as unknown as PartPackage

const place = (packageId: string, params: Record<string, unknown>): PartInstance =>
  ({ id: 'p', type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params }) as unknown as PartInstance

const box = (part: PartInstance): { x: [number, number]; z: [number, number]; y: [number, number] } => {
  const f = partFootprint(part)
  const cx = f.cx ?? 0
  const cz = f.cz ?? 0
  return { x: [cx - f.hx, cx + f.hx], z: [cz - f.hz, cz + f.hz], y: [f.y0, f.y1] }
}

afterEach(() => clearPackages())

describe('the flex conveyor footprint lies along its bed', () => {
  const register = (): void => {
    registerPackage(
      pkg('acme.flex', flexRig.geometry, {
        points: { type: 'numberList', arity: 2, default: [[3, 0], [6, 0], [8, 0]], handle: { kind: 'flexPath', lengthParam: 'length', sections: N, maxHingeDeg: 40 } },
        length: { type: 'number', default: 8 },
        width: { type: 'number', default: 0.6 },
        standHeight: { type: 'number', default: 0.8 },
      } as PartPackage['params']),
    )
  }
  const flex = (points: [number, number][], over: Record<string, number> = {}): PartInstance =>
    place('acme.flex', { points, length: flexStations(points, N).pitch * N, width: 0.6, standHeight: 0.8, ...over })

  it('straight, at its defaults: from the infeed to the discharge, the casters past each end, the frame each side', () => {
    register()
    const b = box(flex([[3, 0], [6, 0], [8, 0]]))
    expect(b.x[0]).toBeCloseTo(-0.075, 6)
    expect(b.x[1]).toBeCloseTo(8.075, 6)
    expect(b.z[0]).toBeCloseTo(-0.41, 6)
    expect(b.z[1]).toBeCloseTo(0.41, 6)
    expect(b.y).toEqual([-0.8, 0.12])
  })

  it('follows a bend: a U-turn is as deep as the turn and no longer than the legs', () => {
    register()
    const points: [number, number][] = [[3, 0], [4.5, 1.5], [3, 3], [0, 3]]
    const b = box(flex(points))
    // every section's frame, 0.41 m either side of it across its own heading, is inside the box
    const st = flexStations(points, N).stations
    for (let i = 0; i + 1 < st.length; i++) {
      const [ax, az] = st[i]!
      const [bx, bz] = st[i + 1]!
      const len = Math.hypot(bx - ax, bz - az)
      const nx = (-(bz - az) / len) * 0.41
      const nz = ((bx - ax) / len) * 0.41
      for (const [x, z] of [[ax + nx, az + nz], [ax - nx, az - nz], [bx + nx, bz + nz], [bx - nx, bz - nz]]) {
        expect(x!).toBeGreaterThanOrEqual(b.x[0] - 1e-9)
        expect(x!).toBeLessThanOrEqual(b.x[1] + 1e-9)
        expect(z!).toBeGreaterThanOrEqual(b.z[0] - 1e-9)
        expect(z!).toBeLessThanOrEqual(b.z[1] + 1e-9)
      }
    }
    expect(b.z[1]).toBeGreaterThan(3)
    expect(b.x[1]).toBeLessThan(5.5)
  })

  it('grows with its width and stands on its legs', () => {
    register()
    const b = box(flex([[3, 0], [6, 0], [8, 0]], { width: 1.2, standHeight: 1.2 }))
    expect(b.z[1]).toBeCloseTo(0.71, 6)
    expect(b.y[0]).toBeCloseTo(-1.2, 6)
  })
})

describe('the stairs footprint lies along the flight', () => {
  it.each([5, 11, 20])('%s steps: from the foot to the far landing post, as high as the landing posts', (n) => {
    registerPackage(pkg('acme.stairs', stairsRig.geometry, { numSteps: { type: 'number', default: 11 }, width: { type: 'number', default: 1.2 } } as PartPackage['params']))
    const b = box(place('acme.stairs', { numSteps: n, width: 1.2 }))
    expect(b.x[0]).toBeCloseTo(-0.028, 6)
    expect(b.x[1]).toBeCloseTo(n * 0.28 + 0.76 + 0.02, 6) // the run, the landing, half the far post
    expect(b.z[1]).toBeCloseTo(0.62, 6)
    expect(b.y[1]).toBeCloseTo(n * 0.178 + 1.07 + 0.016 + 0.005, 6) // the rise, the handrail, half a rail, a cap
  })
})

describe('a rig that declares no bounds: the footprint is the box its links fill', () => {
  // what "+ New part" makes: one 0.6 m box on the floor, and no bounds
  const blank = { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.6, 0.6, 0.6] }, offset: [0, 0.3, 0] }], joints: [] }

  it('the new part\'s box, not a 1 m default', () => {
    registerPackage(pkg('user.part-1', blank, {}))
    const b = box(place('user.part-1', {}))
    expect(b.x[0]).toBeCloseTo(-0.3, 9)
    expect(b.x[1]).toBeCloseTo(0.3, 9)
    expect(b.z[1]).toBeCloseTo(0.3, 9)
    expect(b.y[0]).toBeCloseTo(0, 9)
    expect(b.y[1]).toBeCloseTo(0.6, 9)
  })

  it('takes a child node at its rotated rest pose, off-centre', () => {
    // an arm 1 m long along X, turned 90 degrees about Y so it runs along -Z, hanging off the body's +X side
    const geo = { ...blank, links: [...blank.links, { name: 'arm', parent: 'body', shape: { kind: 'box', size: [1, 0.1, 0.1] }, offset: [0.8, 0, 0], rotation: [0, Math.PI / 2, 0] }] }
    registerPackage(pkg('user.arm', geo, {}))
    const b = box(place('user.arm', {}))
    expect(b.x[0]).toBeCloseTo(-0.3, 9)
    expect(b.x[1]).toBeCloseTo(0.85, 9) // the arm's 0.1 m width, about x = 0.8
    expect(b.z[0]).toBeCloseTo(-0.5, 9) // its 1 m length now along Z
    expect(b.z[1]).toBeCloseTo(0.5, 9)
  })

  it('follows a size a param sets, and leaves out a node a param turns off', () => {
    const geo = {
      kind: 'rig',
      joints: [],
      links: [
        { name: 'body', shape: { kind: 'box', size: [0.6, 0.6, 0.6], sizeParams: [{ axis: 1, param: 'h' }] }, offset: [0, 0, 0] },
        { name: 'flag', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 2, 0], showParam: 'showFlag' },
      ],
    }
    registerPackage(pkg('user.sized', geo, { h: { type: 'number', default: 0.6 }, showFlag: { type: 'boolean', default: true } }))
    expect(box(place('user.sized', { h: 1.2, showFlag: false })).y).toEqual([-0.6, 0.6])
    expect(box(place('user.sized', { h: 1.2, showFlag: true })).y[1]).toBeCloseTo(2.05, 9)
  })

  it('keeps the default box when core can\'t measure a link (a model)', () => {
    const geo = { kind: 'rig', joints: [], links: [{ name: 'm', shape: { kind: 'mesh', asset: 'a' }, offset: [0, 0, 0] }] }
    registerPackage(pkg('user.model', geo, {}))
    expect(box(place('user.model', {}))).toEqual({ x: [-0.5, 0.5], z: [-0.5, 0.5], y: [0, 1] })
  })
})
