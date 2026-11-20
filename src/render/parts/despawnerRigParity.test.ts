import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { examplePart, type RigGeo } from './examplePart'
const { behavior: DESPAWNER_BEHAVIOR, geometry: DESPAWNER_RIG } = examplePart<RigGeo>('oip.despawner')

// The Despawner, authored as a custom part (examples/parts/despawner), is a cargo sink: a single translucent
// volume box (built-in render/parts/despawner.ts parity) with a detection/removal zone its behavior reads
// (ctx.zone) and clears (ctx.despawn) - C-despawn. The removal + throughput count is proven headless in the real
// SimWorld (partPackage.test.ts "a custom despawner removes cargo in its zone..."); here we pin the artifact's shape.

const geo = DESPAWNER_RIG

describe('Despawner custom-part rig - structure parity with the built-in', () => {
  it('is a structurally valid package (a volume box + a dummy behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.despawner', name: 'Despawner', params: {}, behavior: 'definePart({ step(){} })', geometry: geo })).toEqual([])
  })

  it('is a non-colliding volume box whose zone resizes with the length/height/width params (built-in parity)', () => {
    const mouth = geo.links.find((l) => l.name === 'mouth')!
    expect(mouth.shape.kind).toBe('box') // the translucent red trigger box (built-in despawner look)
    expect(mouth.collision).toBe('none') // no collision body → cargo flows through, only detected
    expect(mouth.zone?.size?.every((n) => n > 0)).toBe(true)
    // the trigger volume tracks all three resize params - the sizing the pre-parity gate twin lacked
    const zoneAxes = (mouth.zone?.sizeParams ?? []).map((p) => p.axis).sort()
    expect(zoneAxes).toEqual([0, 1, 2])
    // and it stays in lockstep with the visible box (same sizeParams on the shape)
    const boxAxes = (mouth.shape.kind === 'box' ? mouth.shape.sizeParams ?? [] : []).map((p) => p.axis).sort()
    expect(boxAxes).toEqual([0, 1, 2])
  })

  it('the behavior is a zone-driven sink (ctx.zone → ctx.despawn)', () => {
    expect(DESPAWNER_BEHAVIOR).toContain("ctx.zone('mouth')")
    expect(DESPAWNER_BEHAVIOR).toContain("ctx.despawn('mouth')")
  })
})
