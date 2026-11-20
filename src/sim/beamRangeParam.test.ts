// `beam.rangeParam`: a param sets a beam's sensing reach, not just its drawn line. Without it, a custom
// sensor's detection distance is the manifest's static `range`, and only the renderer follows a param
// (one literally named `maxRange`), so an Inspector "range" slider would move the line and not what the sensor sees.

import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import { resolvedBeamRange } from '../core/rig/rigPose'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

function eye(beam: { range: number; rangeParam?: string }) {
  return buildPackage(
    {
      id: 'acme.eye',
      name: 'Eye',
      geometry: {
        kind: 'rig',
        links: [{ name: 'lens', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0.3, 0], beam }],
        joints: [],
        bounds: { length: 0.1, width: 0.1, top: 0.4 },
      },
    },
    "definePart({ params: { reach: { type: 'number', default: 0.5, min: 0.1, max: 5 } }, step(ctx){ ctx.writeTag('blocked', ctx.sense('lens').hit) } })",
  )
}

/** Does the eye see a box 1 m ahead, at this reach setting? */
function sees(beam: { range: number; rangeParam?: string }, params: Record<string, number>): boolean {
  clearPackages()
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [eye(beam)],
    parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.eye', position: [0, 0, 0], rotationY: 0, params }],
  })
  expect(res.ok).toBe(true)
  if (!res.ok) return false
  const w = new SimWorld(Jolt, res.scene)
  w.spawnBoxAt(0, 0.3, 1, 0.2, 0.2, 0.2, 0, 10, [1, 0, 0])
  for (let i = 0; i < 3; i++) w.step()
  const blocked = w.frame().tags?.cp_1?.blocked
  w.dispose()
  return blocked === true
}

describe('beam.rangeParam', () => {
  it('the param, not the static range, sets how far the beam senses', () => {
    expect(sees({ range: 2, rangeParam: 'reach' }, {})).toBe(false) // default reach 0.5 m < 1 m
    expect(sees({ range: 2, rangeParam: 'reach' }, { reach: 1.5 })).toBe(true)
    expect(sees({ range: 2 }, {})).toBe(true) // no rangeParam: the static 2 m, as before
  })

  it('falls back to the static range when the param is missing or not > 0', () => {
    expect(resolvedBeamRange({ range: 2, rangeParam: 'reach' }, { reach: 0 })).toBe(2)
    expect(resolvedBeamRange({ range: 2, rangeParam: 'reach' }, {})).toBe(2)
    expect(resolvedBeamRange({ range: 2, rangeParam: 'reach' }, { reach: 'far' })).toBe(2)
    expect(resolvedBeamRange({ range: 2, rangeParam: 'reach' }, { reach: 0.75 })).toBe(0.75)
  })
})
