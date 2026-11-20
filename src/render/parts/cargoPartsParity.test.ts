import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import type { PartPackage } from '../../core/parts/partPackage'
import { buildAuthoredCargoFrame, CARGO_KIND_BOX, CARGO_KIND_PALLET, cargoView } from '../../core/frame'
import { registerPackage } from '../../core/parts/partRegistry'
import { instantiatePartScript } from '../../core/parts/partScript'
import type { SdkPart } from '../../core/types'
import { PALLET_SIZE } from '../../core/types'
import { partFootprint } from '../../core/parts/partGeometry'
import { examplePart, type CargoGeo } from './examplePart'

// The cargo Box + Pallet, authored on the part SDK's cargo geometry kind (C-cargo,
// docs/architecture.md): the package declares { kind: 'cargo', cargoKind, size } and the host builds the
// part as a dynamic body + instanced-batch render through the same pipeline as the built-in box/pallet. The
// shared recognizer is core/frame cargoView: the sim, the idle frame, the view and the controller all resolve
// a cargo part's kind/size/colour/mass through it, so this is what we pin here (the dynamic-body physics is
// proven in the real Jolt world in sim/partPackage.test.ts).

const box = examplePart<CargoGeo>('oip.box')
const pallet = examplePart<CargoGeo>('oip.pallet')

// register the packages so cargoView (and everything downstream of getPackage) resolves them. Params are
// baked from the behavior through core's compile chokepoint (instantiatePartScript), the render-legal seam;
// sim/buildPackage is the sim project's wrapper over the same capture and may not be imported from render.
const bake = (id: string, name: string, geometry: CargoGeo, behavior: string, materials: PartPackage['materials'] = []): PartPackage => {
  const { def, error } = instantiatePartScript(behavior)
  if (!def) throw new Error(error)
  return { format: PACKAGE_FORMAT, id, name, params: (def.params ?? {}) as PartPackage['params'], behavior, geometry, materials }
}
registerPackage(bake('oip.box', 'Box', box.geometry, box.behavior))
registerPackage(bake('oip.pallet', 'Pallet', pallet.geometry, pallet.behavior, pallet.materials))

const inst = (packageId: string, params: Record<string, number | string | boolean>, id = 'cp_1'): SdkPart =>
  ({ type: 'part', id, packageId, position: [1, 0.2, -2], rotationY: 0.5, params }) as SdkPart

describe('Box + Pallet custom parts (C-cargo - the cargo geometry kind)', () => {
  it('are valid cargo packages with a passive behavior (cargo is payload, not machine)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.box', name: 'Box', params: {}, behavior: box.behavior, geometry: box.geometry })).toEqual([])
    // with its materials: its start rule (a pallet authored `wrapped`) dresses the load in its own 'film'
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.pallet', name: 'Pallet', params: {}, behavior: pallet.behavior, geometry: pallet.geometry, materials: pallet.materials })).toEqual([])
    expect(box.geometry).toMatchObject({ kind: 'cargo', cargoKind: 'box' })
    expect(pallet.geometry).toMatchObject({ kind: 'cargo', cargoKind: 'pallet' })
    // no world-reaching calls: an empty step (the host owns the body)
    for (const b of [box.behavior, pallet.behavior]) {
      expect(b).toContain('definePart')
      expect(b).not.toContain('ctx.')
    }
  })

  it('validation rejects a bad cargoKind / missing size', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'x', name: 'x', params: {}, behavior: 'definePart({ step(){} })', geometry: { kind: 'cargo', cargoKind: 'crate', size: { length: 1, width: 1, height: 1 } } }).some((p) => p.field === 'geometry.cargoKind')).toBe(true)
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'x', name: 'x', params: {}, behavior: 'definePart({ step(){} })', geometry: { kind: 'cargo', cargoKind: 'box' } }).some((p) => p.field === 'geometry.size')).toBe(true)
  })

  it('cargoView resolves the SDK box like the built-in: param-driven size/mass/colour, centre origin', () => {
    const v = cargoView(inst('oip.box', { length: 1.0, height: 0.5, width: 0.4, mass: 25, color: '#22aa44' }))
    expect(v).toMatchObject({ kind: CARGO_KIND_BOX, halfExtents: [0.5, 0.25, 0.2], color: '#22aa44', mass: 25 })
    // sparse instance params fall back to the schema defaults (0.6 × 0.4 × 0.4, 10 kg, white)
    expect(cargoView(inst('oip.box', {}))).toMatchObject({ kind: CARGO_KIND_BOX, halfExtents: [0.3, 0.2, 0.2], color: '#ffffff', mass: 10 })
  })

  it('cargoView resolves the SDK pallet at the fixed EUR size (only mass/colour authorable)', () => {
    const v = cargoView(inst('oip.pallet', { mass: 30, color: '#886644', length: 9 }))
    expect(v).toMatchObject({ kind: CARGO_KIND_PALLET, halfExtents: [PALLET_SIZE[0] / 2, PALLET_SIZE[1] / 2, PALLET_SIZE[2] / 2], color: '#886644', mass: 30 })
  })

  it('a non-cargo part resolves to null (machines are not cargo)', () => {
    expect(cargoView({ type: 'part', id: 'x', packageId: 'oip.no-such', position: [0, 0, 0], rotationY: 0, params: {} } as SdkPart)).toBeNull()
  })

  it('the idle authored-cargo frame includes SDK cargo (instanced-batch render, like the built-ins)', () => {
    const frame = buildAuthoredCargoFrame([
      inst('oip.box', { length: 0.8, height: 0.6, width: 0.4, color: '#ff0000' }, 'cp_1'),
      inst('oip.pallet', {}, 'cp_2'),
    ])
    expect(frame.count).toBe(2)
    expect(Array.from(frame.kinds)).toEqual([CARGO_KIND_BOX, CARGO_KIND_PALLET])
    expect(frame.partIds).toEqual(['cp_1', 'cp_2'])
    expect(frame.halfExtents[0]).toBeCloseTo(0.4, 6) // box length/2 from the instance params
    expect(frame.halfExtents[4]).toBeCloseTo(PALLET_SIZE[1] / 2, 6) // pallet fixed height/2
    expect(frame.colors[0]).toBeCloseTo(1, 3) // #ff0000 → r=1
    expect(frame.colors[1]).toBeCloseTo(0, 3)
  })

  it('the footprint is a centre-origin box (floorRest seats the underside on the floor, like the built-ins)', () => {
    const fp = partFootprint(inst('oip.box', { length: 1.0, height: 0.5, width: 0.4 }))
    expect(fp).toMatchObject({ hx: 0.5, hz: 0.2, y0: -0.25, y1: 0.25 })
  })
})
