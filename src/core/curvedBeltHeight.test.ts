import { afterEach, describe, expect, it } from 'vitest'
import { ARC_END_EXT, ROLLER_PITCH } from './types'
import type { SdkPart } from './types'
import { conveyorDeckSubs } from './geometry/collisionShapes'
import { bedView, partFootprint } from './parts/partGeometry'
import { checkParamSpecs } from './parts/partAuthoringChecks'
import type { ParamSchema } from './parts/partApi'
import { clearPackages, registerPackage } from './parts/partRegistry'
import type { PartPackage } from './parts/partPackage'
import { PACKAGE_FORMAT } from './parts/partPackage'
import { resolveRollerGrids } from './conveyor/rollerGrid'

// A curved belt's snap ends sit a drum radius past its arc, and its drums follow its Frame height: the arc handle's
// `endGapParam` ({ param: 'height', scale: 0.5 }) makes the host's endExt track it, the way a straight belt's ends
// sit height / 2 past its run. The default height gives exactly the ARC_END_EXT reach.

const BELT_CURVE = 'test.curve-belt-height'
const STRAIGHT = 'test.straight-roller'

const curvePkg = (): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: BELT_CURVE,
    name: 'Curve', conveyor: { bed: 'arc', surface: 'belt', speedParam: 'speed' },
    category: 'Equipment',
    params: {
      innerRadius: { type: 'number', default: 0.6 },
      width: { type: 'number', default: 0.6 },
      height: { type: 'number', default: 0.17 },
      sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width', endGapParam: { param: 'height', scale: 0.5 } } },
      speed: { type: 'number', default: 0.5 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 2, width: 2, top: 0.5 }, conveys: true },
  }) as unknown as PartPackage

const curve = (params: Record<string, number>): SdkPart =>
  ({ id: 'cv', type: 'part', packageId: BELT_CURVE, position: [0, 0.75, 0], rotationY: 0, params: { innerRadius: 0.6, width: 0.6, sweepDeg: 90, speed: 0.5, ...params } }) as unknown as SdkPart

afterEach(() => clearPackages())

describe('curved belt end gap follows its Frame height (arc handle endGapParam)', () => {
  it('endExt = height / 2, and the default height gives ARC_END_EXT', () => {
    registerPackage(curvePkg())
    expect(bedView(curve({ height: 0.17 }), 'arc')!.endExt).toBeCloseTo(ARC_END_EXT, 12)
    expect(bedView(curve({ height: 0.4 }), 'arc')!.endExt).toBeCloseTo(0.2, 12)
    expect(bedView(curve({ height: 0.1 }), 'arc')!.endExt).toBeCloseTo(0.05, 12)
    // a curve saved before the param falls back to the half-pulley
    expect(bedView(curve({}), 'arc')!.endExt).toBe(ARC_END_EXT)
  })

  it('a deep curve widens its footprint and lead-in stubs to reach its drums; a shallow one keeps ARC_END_EXT', () => {
    registerPackage(curvePkg())
    const outer = 0.6 + 0.6
    expect(partFootprint(curve({ height: 0.17 })).hx).toBeCloseTo(outer + ARC_END_EXT, 9)
    expect(partFootprint(curve({ height: 0.1 })).hx).toBeCloseTo(outer + ARC_END_EXT, 9)
    expect(partFootprint(curve({ height: 0.4 })).hx).toBeCloseTo(outer + 0.2, 9)
    // the two tangent stubs are the last two deck facets: their half-length along travel
    const stubs = (h: number): number[] => conveyorDeckSubs(curve({ height: h })).slice(-2).map((s) => s.box!.hx)
    expect(stubs(0.17)).toEqual([ARC_END_EXT / 2, ARC_END_EXT / 2])
    expect(stubs(0.1)).toEqual([ARC_END_EXT / 2, ARC_END_EXT / 2])
    expect(stubs(0.4)).toEqual([0.1, 0.1])
  })

  it('a shallow curved belt (endExt below the half-pulley) is still not a roller-grid anchor', () => {
    registerPackage(curvePkg())
    registerPackage({
      format: PACKAGE_FORMAT, id: STRAIGHT, name: 'Roller', conveyor: { bed: 'straight', surface: 'roller' }, category: 'Equipment',
      params: { length: { type: 'number', default: 3, handle: { kind: 'face', axis: 'x' } }, width: { type: 'number', default: 1, handle: { kind: 'face', axis: 'z' } } },
      behavior: 'definePart({ step(){} })',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'deck', shape: { kind: 'box', size: [3, 0.04, 1] }, offset: [0, -0.02, 0], conveys: true },
          { name: 'rollerGrid', shape: { kind: 'frame' }, offset: [0, -0.024, 0], array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: ROLLER_PITCH, worldPhase: true } } },
        ],
        joints: [],
        bounds: { length: 3, width: 1.1, top: 1.2 },
      },
    } as unknown as PartPackage)
    // the straight's back end on the shallow curve's real back end (0.9, 0.05): genuine contact, still no anchor
    const straight: SdkPart = { id: 's', type: 'part', packageId: STRAIGHT, position: [0.9, 0.75, 0.05 - 1.5], rotationY: Math.PI / 2, params: { length: 3, width: 1 } } as SdkPart
    expect(resolveRollerGrids([curve({ height: 0.1 }), straight]).get('s')!.anchor).toBeNull()
  })

  it('the authoring check resolves endGapParam against the schema', () => {
    const params = curvePkg().params as unknown as Record<string, { handle?: Record<string, unknown> }>
    expect(checkParamSpecs(params as unknown as ParamSchema).filter((p) => p.field.includes('endGapParam'))).toEqual([])
    params.sweepDeg!.handle!.endGapParam = { param: 'depth', scale: 0.5 }
    expect(checkParamSpecs(params as unknown as ParamSchema).some((p) => p.field.includes('endGapParam'))).toBe(true)
    params.sweepDeg!.handle!.endGapParam = { param: 'height', scale: 'half' }
    expect(checkParamSpecs(params as unknown as ParamSchema).some((p) => p.field.includes('endGapParam.scale'))).toBe(true)
  })
})
