import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { examplePart, type RigGeo } from './examplePart'
const { behavior: PALLET_SPAWNER_BEHAVIOR, geometry: PALLET_SPAWNER_RIG } = examplePart<RigGeo>('oip.pallet-spawner')

// The Pallet Spawner as a custom part (examples/parts/palletSpawner) covers C-spawn's pallet kind: its
// rate-timer behavior emits real EUR pallets via ctx.spawn({ kind:'pallet' }). The cargo-kind side is tested
// headless in the real SimWorld (partPackage.test.ts "a pallet spawner emits real PALLET cargo"). This file pins
// the generated artifact's shape.

const geo = PALLET_SPAWNER_RIG

describe('Pallet Spawner custom-part rig - structure parity', () => {
  it('is a structurally valid package (a hopper rig + a dummy behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.pallet-spawner', name: 'Pallet Spawner', params: {}, behavior: 'definePart({ step(){} })', geometry: geo })).toEqual([])
  })

  it('is a pure producer (marker rig, no joints)', () => {
    expect(geo.joints).toHaveLength(0)
    expect(geo.links.map((l) => l.name)).toContain('marker')
  })

  it('matches the built-in spawner marker - a translucent box + a translucent "drops here" cone, no collision', () => {
    const box = geo.links.find((l) => l.shape.kind === 'box')
    const cone = geo.links.find((l) => l.shape.kind === 'cone')
    expect(box?.opacity).toBeLessThan(1)
    expect(box?.outline).toBeDefined() // the built-in's light-blue edge outline
    expect(box?.collision).toBe('none')
    expect(cone).toBeDefined()
    expect(cone!.opacity).toBeLessThan(1)
    expect(cone!.offset[1]).toBeLessThan(0)
  })

  it('the behavior is a rate-driven pallet spawner', () => {
    expect(PALLET_SPAWNER_BEHAVIOR).toContain('palletsPerMinute')
    expect(PALLET_SPAWNER_BEHAVIOR).toContain("default: 'oip.pallet'") // its product, a Pallet unless set otherwise
  })

  it('carries the built-in parity knobs (fixedRate jitter + a pilot Use toggle)', () => {
    expect(PALLET_SPAWNER_BEHAVIOR).toContain('fixedRate')
    expect(PALLET_SPAWNER_BEHAVIOR).toContain('interactive: true') // the pallet spawner's Use action → ctx.used()
    expect(PALLET_SPAWNER_BEHAVIOR).toContain('ctx.used()')
    expect(PALLET_SPAWNER_BEHAVIOR).not.toContain('Math.random(') // the twin stays reproducible
  })
})
