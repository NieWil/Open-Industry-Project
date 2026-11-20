import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { examplePart, type RigGeo } from './examplePart'
const { behavior: BOX_SPAWNER_BEHAVIOR, geometry: BOX_SPAWNER_RIG } = examplePart<RigGeo>('oip.box-spawner')

// The Box Spawner, a custom part (examples/parts/box-spawner), is a cargo producer: a hopper whose behavior
// runs a rate timer and calls ctx.spawn() (C-spawn). The spawning itself is tested headless in the real
// SimWorld (partPackage.test.ts "a custom spawner emits cargo boxes at its rate"). This pins the generated
// artifact's shape: a valid hopper rig with no articulation, driven by a rate-timer spawn behavior.

const geo = BOX_SPAWNER_RIG

describe('Box Spawner custom-part rig - structure parity with the built-in', () => {
  it('is a structurally valid package (a plain hopper rig + a dummy behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.box-spawner', name: 'Box Spawner', params: {}, behavior: 'definePart({ step(){} })', geometry: geo })).toEqual([])
  })

  it('is a pure producer: a marker rig, no joints / emissive / beams', () => {
    expect(geo.joints).toHaveLength(0)
    expect(geo.links.every((l) => !l.lamps?.[0]?.emissive && !l.beam)).toBe(true)
    expect(geo.links.map((l) => l.name)).toContain('marker')
  })

  it('matches the built-in spawner marker - a translucent box + a translucent "drops here" cone, no collision', () => {
    const box = geo.links.find((l) => l.shape.kind === 'box')
    const cone = geo.links.find((l) => l.shape.kind === 'cone')
    expect(box?.opacity).toBeLessThan(1) // translucent blue cube, like spawner.ts (opacity 0.3)
    expect(box?.outline).toBeDefined() // the built-in's crisp light-blue edge outline (EdgesGeometry)
    expect(box?.collision).toBe('none') // a source marker, not a solid object cargo touches
    expect(cone).toBeDefined()
    expect(cone!.opacity).toBeLessThan(1)
    expect(cone!.offset[1]).toBeLessThan(0) // the cone hangs below the marker (the drop cue)
  })

  it('the behavior is a rate-driven spawner (boxesPerMinute → ctx.spawn)', () => {
    expect(BOX_SPAWNER_BEHAVIOR).toContain('boxesPerMinute')
    expect(BOX_SPAWNER_BEHAVIOR).toContain('ctx.spawn(')
  })

  it('carries the built-in parity knobs (fixedRate jitter, colour cycle, random size) driven by ctx.rng()', () => {
    for (const knob of ['fixedRate', 'boxColors', 'randomColors', 'randomSize']) expect(BOX_SPAWNER_BEHAVIOR).toContain(knob)
    expect(BOX_SPAWNER_BEHAVIOR).toContain('ctx.rng(') // jitter/colour/size draws are deterministic, not Math.random
    expect(BOX_SPAWNER_BEHAVIOR).not.toContain('Math.random(') // the twin stays reproducible
  })
})
