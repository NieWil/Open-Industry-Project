import { describe, expect, it } from 'vitest'
import type { ParamSchema, ParamValue } from '../parts/partApi'
import { compileRig, type RigSource } from './rigCompile'
import { resolvedBounds } from '../parts/partGeometry'
import { resolvedBoxSize, resolvedOffset, rigWorldPoses } from './rigPose'

const schema: ParamSchema = {
  width: { type: 'number', default: 1, min: 0.2, max: 2 },
  height: { type: 'number', default: 0.5, min: 0.1, max: 1 },
  on: { type: 'boolean', default: false },
  tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' },
}

const box = (size: [number, number, number], offset: [number, number, number] = [0, 0, 0]) => ({
  name: 'deck',
  shape: { kind: 'box' as const, size },
  offset,
})
const rigOf = (f: (p: Record<string, ParamValue>) => RigSource['links']) => (p: Record<string, ParamValue>): RigSource => ({ links: f(p), joints: [] })
const num = (p: Record<string, ParamValue>, k: string): number => p[k] as number

describe('compileRig', () => {
  it('turns numbers that follow a param into refs and keeps the rest', () => {
    const result = compileRig(rigOf((p) => [box([0.1, num(p, 'height') + 0.15, num(p, 'width')], [0, -num(p, 'height') / 2, 0.3])]), schema)
    expect(result.problems).toEqual([])
    const link = result.geometry!.links[0]!
    expect(link.shape).toEqual({
      kind: 'box',
      size: [0.1, 0.65, 1],
      sizeParams: [
        { axis: 1, param: 'height', scale: 1, add: 0.15 },
        { axis: 2, param: 'width', scale: 1 },
      ],
    })
    expect(link.offset).toEqual([0, -0.25, 0.3])
    expect(link.offsetParams).toEqual([{ axis: 1, param: 'height', scale: -0.5 }])
    // and the compiled refs reproduce rig() away from the defaults
    const params = { width: 1.7, height: 0.9 }
    expect(resolvedBoxSize(link.shape.kind === 'box' ? link.shape.size : [0, 0, 0], (link.shape as { sizeParams?: never }).sizeParams, params)).toEqual([0.1, 1.05, 1.7])
    expect(resolvedOffset(link.offset, link.offsetParams, params)[1]).toBeCloseTo(-0.45, 9)
  })

  it('emits a rig with no refs unchanged', () => {
    const result = compileRig(rigOf(() => [box([1, 2, 3])]), schema)
    expect(result.geometry).toEqual({ kind: 'rig', links: [box([1, 2, 3])], joints: [] })
  })

  it("rounds the numbers it works out and leaves the author's own as written", () => {
    const result = compileRig(
      (p) => ({ links: [box([1, 1, 1], [0, 0.1 + 0.2 + num(p, 'height'), 0])], joints: [{ name: 'spin', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI }] }),
      schema,
    )
    const link = result.geometry!.links[0]!
    // 0.1 + 0.2 + 0.5 is 0.8000000000000002 in floating point; the fitted base and add come out clean
    expect(link.offset[1]).toBe(0.8)
    expect(link.offsetParams).toEqual([{ axis: 1, param: 'height', scale: 1, add: 0.3 }])
    expect(result.geometry!.joints[0]!.max).toBe(Math.PI)
  })

  it("accepts a ref rig() writes itself, such as a clamp the fit can't make", () => {
    const clamped = { axis: 1 as const, param: 'height', scale: 2, max: 1.2 }
    const result = compileRig(rigOf(() => [{ ...box([1, 1, 1], [0, 0.4, 0]), offsetParams: [clamped] }]), schema)
    expect(result.problems).toEqual([])
    expect(result.geometry!.links[0]!.offsetParams).toEqual([clamped])
  })

  it('refuses a number that is not a straight line in its param', () => {
    const curve = compileRig(rigOf((p) => [box([num(p, 'width') ** 2, 1, 1])]), schema)
    expect(curve.problems).toEqual([expect.stringContaining('.links[0].shape.size[0] is not a straight line in width')])
    // a V is two lines, not a line between flats
    const vee = compileRig(rigOf((p) => [box([1, 1, 1], [Math.abs(num(p, 'width') - 1), 0, 0])]), schema)
    expect(vee.problems).toEqual([expect.stringContaining('.links[0].offset[0] is not a straight line in width')])
    // a step: two flats and no slope between them
    const step = compileRig(rigOf((p) => [box([1, 1, 1], [num(p, 'width') > 1.3 ? 1 : 0, 0, 0])]), schema)
    expect(step.problems).toEqual([expect.stringContaining('.links[0].offset[0] is not a straight line in width')])
  })

  it('fits a straight line between two flat ends as a clamped ref', () => {
    // a floor at 0.3 (knee at width 0.8), and offsets with both flats, one rising and one falling
    const result = compileRig(
      rigOf((p) => {
        const w = num(p, 'width')
        return [box([Math.max(w - 0.5, 0.3), 1, 1], [Math.min(Math.max(2 * w - 1, 0), 2), Math.min(Math.max(-w, -1.5), -0.5), 0])]
      }),
      schema,
    )
    expect(result.problems).toEqual([])
    const link = result.geometry!.links[0]!
    expect((link.shape as { sizeParams?: unknown }).sizeParams).toEqual([{ axis: 0, param: 'width', scale: 1, add: -0.5, min: 0.3 }])
    expect(link.offsetParams).toEqual([
      { axis: 0, param: 'width', scale: 2, add: -1, min: 0, max: 2 },
      { axis: 1, param: 'width', scale: -1, min: -1.5, max: -0.5 },
    ])
    expect(link.offset).toEqual([1, -1, 0])
  })

  it('takes the flats as rig() wrote them and finds a knee between two samples', () => {
    // the knee sits just past a sample point, so the first pass sees a one-point flat and samples more
    const floor = 0.1 + 0.2 // 0.30000000000000004, kept as written
    const result = compileRig(rigOf((p) => [box([1, 1, 1], [Math.max(10 * num(p, 'width') - 2.1, floor), 0, 0])]), schema)
    expect(result.problems).toEqual([])
    expect(result.geometry!.links[0]!.offsetParams).toEqual([{ axis: 0, param: 'width', scale: 10, add: -2.1, min: floor }])
  })

  it('fits a product of two params plus a constant as a mulParam ref', () => {
    const result = compileRig(
      rigOf((p) => [box([num(p, 'width') * num(p, 'height'), 2 * num(p, 'width') * num(p, 'height') + 0.1, 1], [0, num(p, 'height') * num(p, 'width') * 0.5, 0])]),
      schema,
    )
    expect(result.problems).toEqual([])
    const link = result.geometry!.links[0]!
    // param is the one the schema lists first; a scale of 1 on a product is left out
    expect((link.shape as { sizeParams?: unknown }).sizeParams).toEqual([
      { axis: 0, param: 'width', mulParam: 'height' },
      { axis: 1, param: 'width', mulParam: 'height', scale: 2, add: 0.1 },
    ])
    expect(link.offsetParams).toEqual([{ axis: 1, param: 'width', mulParam: 'height', scale: 0.5 }])
  })

  it('refuses a number that follows two params but is neither their product nor a sum of lines', () => {
    const curve = compileRig(rigOf((p) => [box([num(p, 'width') * num(p, 'width') + num(p, 'height'), 1, 1])]), schema)
    expect(curve.problems).toEqual([expect.stringContaining('follows both width and height')])
    const clamped = compileRig(rigOf((p) => [box([Math.min(num(p, 'width') * num(p, 'height'), 1), 1, 1])]), schema)
    expect(clamped.problems).toEqual([expect.stringContaining('follows both width and height')])
    const three = compileRig(rigOf((p) => [box([num(p, 'width') * num(p, 'height') * num(p, 'depth'), 1, 1])]), {
      ...schema,
      depth: { type: 'number', default: 1, min: 0.5, max: 2 },
    })
    expect(three.problems).toEqual([expect.stringContaining('follows width, height, depth')])
  })

  it("fits a cylinder's radius (axis 0) and height (axis 1)", () => {
    const result = compileRig(
      rigOf((p) => [{ name: 'drum', shape: { kind: 'cylinder', radius: num(p, 'width') / 2, height: Math.max(num(p, 'height') + 0.1, 0.3) }, offset: [0, 0, 0] }]),
      schema,
    )
    expect(result.problems).toEqual([])
    expect(result.geometry!.links[0]!.shape).toEqual({
      kind: 'cylinder',
      radius: 0.5,
      height: 0.6,
      sizeParams: [
        { axis: 0, param: 'width', scale: 0.5 },
        { axis: 1, param: 'height', add: 0.1, min: 0.3 },
      ],
    })
  })

  it("fits a grip zone's size and a leg row's frame depth", () => {
    const result = compileRig(
      rigOf((p) => [
        { ...box([1, 1, 1]), grip: { zone: { size: [num(p, 'width'), 2, 1], offset: [0, 1, 0] } } },
        { name: 'legs', shape: { kind: 'leg', spanParam: 'width', widthParam: 'width', standParam: 'height', frameDepth: num(p, 'height') - 0.05 }, offset: [0, 0, 0] },
      ]),
      schema,
    )
    expect(result.problems).toEqual([])
    const [deck, legs] = result.geometry!.links
    expect(deck!.grip).toEqual({ zone: { size: [1, 2, 1], sizeParams: [{ axis: 0, param: 'width', scale: 1 }], offset: [0, 1, 0] } })
    expect(legs!.shape).toEqual({ kind: 'leg', spanParam: 'width', widthParam: 'width', standParam: 'height', frameDepth: 0.45, frameDepthParam: { param: 'height', add: -0.05 } })
  })

  it("fits a joint limit that follows a param, its static limit the widest over the param's range", () => {
    const result = compileRig(
      (p) => ({
        links: [box([1, 1, 1])],
        joints: [{ name: 'x', link: 'deck', type: 'prismatic', axis: [1, 0, 0], min: -num(p, 'width') / 2 + 0.05, max: Math.max(num(p, 'height') - 0.2, 0) }],
      }),
      schema,
    )
    expect(result.problems).toEqual([])
    // width runs 0.2..2, so min reaches -0.95; height runs 0.1..1, so max reaches 0.8
    expect(result.geometry!.joints[0]).toEqual({
      name: 'x',
      link: 'deck',
      type: 'prismatic',
      axis: [1, 0, 0],
      min: -0.95,
      max: 0.8,
      minParam: { param: 'width', scale: -0.5, add: 0.05 },
      maxParam: { param: 'height', add: -0.2, min: 0 },
    })
  })

  it('refuses a joint limit that follows a param with no range', () => {
    const open: ParamSchema = { reach: { type: 'number', default: 1 } }
    const result = compileRig(
      (p) => ({ links: [box([1, 1, 1])], joints: [{ name: 'x', link: 'deck', type: 'prismatic', axis: [1, 0, 0], min: 0, max: num(p, 'reach') }] }),
      open,
    )
    expect(result.problems).toEqual([expect.stringContaining("follows reach, which has no min and max, so the joint's outer limit can't be set")])
  })

  it('fits bounds fields that follow a param', () => {
    const result = compileRig(
      (p) => ({ links: [box([1, 1, 1])], joints: [], bounds: { length: num(p, 'width') + 0.2, width: 0.5, top: num(p, 'height'), centerX: num(p, 'width') / 2 } }),
      schema,
    )
    expect(result.problems).toEqual([])
    expect(result.geometry!.bounds).toEqual({
      length: 1.2,
      width: 0.5,
      top: 0.5,
      centerX: 0.5,
      // each extent next to its centre
      params: [
        { field: 'length', param: 'width', add: 0.2 },
        { field: 'centerX', param: 'width', scale: 0.5 },
        { field: 'top', param: 'height' },
      ],
    })
  })

  it('refuses a size that stops being positive inside its range', () => {
    // a straight line, but below width 0.5 the host keeps the static size instead
    const result = compileRig(rigOf((p) => [box([num(p, 'width') - 0.5, 1, 1])]), schema)
    expect(result.problems).toEqual([expect.stringContaining('a size must stay positive')])
  })

  it('fits a sum of two params as a replacing ref and a plus ref', () => {
    const result = compileRig(rigOf((p) => [box([num(p, 'width') + num(p, 'height'), 1, 1], [num(p, 'width') / 2 + num(p, 'height') + 0.1, 0, 0])]), schema)
    expect(result.problems).toEqual([])
    const link = result.geometry!.links[0]!
    expect((link.shape as { sizeParams?: unknown }).sizeParams).toEqual([
      { axis: 0, param: 'width', scale: 1, add: 0.5 },
      { axis: 0, param: 'height', scale: 1, add: -0.5, plus: true },
    ])
    // the first ref is the line in width at the default height, the plus ref the line in height less the default's value
    expect(link.offsetParams).toEqual([
      { axis: 0, param: 'width', scale: 0.5, add: 0.6 },
      { axis: 0, param: 'height', scale: 1, add: -0.5, plus: true },
    ])
    const params = { width: 1.7, height: 0.2 }
    expect(resolvedOffset(link.offset, link.offsetParams, params)[0]).toBeCloseTo(1.15, 9)
  })

  it('fits a clamped line in each param of a sum, and a bounds field that sums two params', () => {
    const result = compileRig(
      (p) => ({ links: [box([1, 1, 1], [Math.max(num(p, 'width'), 0.5) + Math.min(num(p, 'height'), 0.8), 0, 0])], joints: [], bounds: { length: num(p, 'width') + 2 * num(p, 'height'), width: 1, top: 1 } }),
      schema,
    )
    expect(result.problems).toEqual([])
    const link = result.geometry!.links[0]!
    expect(link.offsetParams).toEqual([
      { axis: 0, param: 'width', scale: 1, add: 0.5, min: 1 },
      { axis: 0, param: 'height', scale: 1, add: -0.5, max: 0.3, plus: true },
    ])
    expect(result.geometry!.bounds!.params).toEqual([
      { field: 'length', param: 'width', add: 1 },
      { field: 'length', param: 'height', scale: 2, add: -1, plus: true },
    ])
    expect(resolvedBounds(result.geometry!.bounds!, { width: 0.4, height: 0.9 }).length).toBeCloseTo(2.2, 9)
  })

  it('refuses a sum on a joint limit, which holds one ref', () => {
    const result = compileRig(
      (p) => ({ links: [box([1, 1, 1])], joints: [{ name: 'x', link: 'deck', type: 'prismatic', axis: [1, 0, 0], min: 0, max: num(p, 'width') + num(p, 'height') }] }),
      schema,
    )
    expect(result.problems).toEqual([expect.stringContaining('this field holds one ref')])
  })

  it("fits a detection zone's size and a link rotation that follow a param", () => {
    const angled: ParamSchema = { ...schema, angle: { type: 'number', default: 30, min: 0, max: 45 } }
    const result = compileRig(
      rigOf((p) => [
        { ...box([1, 1, 1]), zone: { size: [num(p, 'width'), 0.5, 1] } },
        { ...box([1, 1, 1]), name: 'arm', rotation: [0, (num(p, 'angle') * Math.PI) / 180, 0] },
      ]),
      angled,
    )
    expect(result.problems).toEqual([])
    const [deck, arm] = result.geometry!.links
    expect(deck!.zone).toEqual({ size: [1, 0.5, 1], sizeParams: [{ axis: 0, param: 'width', scale: 1 }] })
    expect(arm!.rotation).toEqual([0, 0.52359878, 0])
    expect(arm!.rotationParams).toEqual([{ axis: 1, param: 'angle', scale: 0.017453292520 }])
    // the host turns the link by the param
    const q = rigWorldPoses(result.geometry!, {}, undefined, 1, { angle: 90 }).get('arm')!.quat
    expect(q[1]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('refuses a product of two params, which only the all-params-moved check sees', () => {
    // zero at either param's default, so moving one param alone never moves the axis
    const result = compileRig(rigOf((p) => [box([1 + (num(p, 'width') - 1) * (num(p, 'height') - 0.5), 1, 1])]), schema)
    expect(result.problems).toEqual([expect.stringContaining('depends on two params together')])
  })

  it('refuses a rig whose structure changes with a param', () => {
    const result = compileRig(rigOf((p) => (p.on ? [box([1, 1, 1]), { ...box([1, 1, 1]), name: 'extra' }] : [box([1, 1, 1])])), schema)
    expect(result.problems).toEqual([expect.stringContaining("the rig's structure changes with on")])
  })

  it('refuses a number in a field no ref can drive', () => {
    const result = compileRig(
      (p) => ({ links: [{ ...box([1, 1, 1]), color: [num(p, 'height'), 0, 0] }], joints: [] }),
      schema,
    )
    expect(result.problems).toEqual([expect.stringContaining(".links[0].color[0] changes with height, and that field can't follow a param")])
  })

  it('refuses a number that follows a boolean', () => {
    const result = compileRig(rigOf((p) => [box([p.on ? 2 : 1, 1, 1])]), schema)
    expect(result.problems).toEqual([expect.stringContaining('changes with on, which is not a number param')])
  })

  it('reports a throw from rig()', () => {
    const result = compileRig(() => {
      throw new Error('boom')
    }, schema)
    expect(result.problems).toEqual(['rig() threw: boom'])
  })
})
