import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conveyorSpeedOf, isConveyorReversed } from './conveyorDirection'
import { PACKAGE_FORMAT, type PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { PartInstance } from '../types'

// The engine-side half of the effective-speed rule: authored speed × the snap-owned `reverse`
// flag. Every static consumer of a conveyor's direction (flow arrow, snap output-end rule, pilot surface
// mirror, render scroll) routes through here, so a curve snapped into a flow-incompatible neighbour reverses
// everywhere at once instead of one seam at a time.

const pkg = (id: string, conveyor?: PartPackage['conveyor']): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id,
    name: id,
    ...(conveyor ? { conveyor } : {}),
    params: { speed: { type: 'number', default: 1 }, reverse: { type: 'boolean', default: false, hidden: true } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 1 } },
  }) as PartPackage
// the curve declares which params are its speed and its reverse flag; the robot has a `speed` of its own (how fast
// it moves) and declares no conveyor, so the host must not read it as a conveying speed
beforeAll(() => {
  registerPackage(pkg('acme.curve', { bed: 'arc', surface: 'roller', speedParam: 'speed', reverseParam: 'reverse' }))
  registerPackage(pkg('acme.robot'))
})
afterAll(() => clearPackages())

const part = (params: Record<string, unknown>, packageId = 'acme.curve'): PartInstance =>
  ({ id: 'p', type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params }) as unknown as PartInstance

describe('conveyorSpeedOf (authored speed folded with the snap-owned reverse flag)', () => {
  it('passes an un-reversed speed through, sign and all', () => {
    expect(conveyorSpeedOf(part({ speed: 2 }))).toBe(2)
    expect(conveyorSpeedOf(part({ speed: -2 }))).toBe(-2) // hand-reversed: still the user-facing way
  })

  it('flips a reversed conveyor without touching the authored param', () => {
    const p = part({ speed: 2, reverse: true })
    expect(conveyorSpeedOf(p)).toBe(-2)
    expect((p.params as { speed: number }).speed).toBe(2) // the number the user typed is untouched
  })

  it('composes with a hand-typed negative speed (both reversals apply, so they cancel)', () => {
    expect(conveyorSpeedOf(part({ speed: -2, reverse: true }))).toBe(2)
  })

  it('reads 0 for a part that declares no speed, and ignores a non-boolean reverse', () => {
    expect(conveyorSpeedOf(part({}))).toBe(0)
    expect(conveyorSpeedOf(part({ speed: 2, reverse: true }, 'acme.robot'))).toBe(0) // a param named speed is not one
    expect(isConveyorReversed(part({ speed: 2, reverse: true }, 'acme.robot'))).toBe(false)
    expect(conveyorSpeedOf(part({ speed: 2, reverse: 'yes' }))).toBe(2) // only a real `true` reverses
  })

  it('isConveyorReversed reports the flag alone, independent of the speed sign', () => {
    expect(isConveyorReversed(part({ speed: -2 }))).toBe(false)
    expect(isConveyorReversed(part({ speed: 2, reverse: true }))).toBe(true)
  })
})
