// The `joint` world probe: a project test reads a rig part's joint value directly, instead of the part
// having to publish it as a debug tag (the pattern agent trials fell back on).

import { describe, expect, it } from 'vitest'
import type { BoxFrame } from './frame'
import { ProbeSampler } from './project/projectProbe'
import { describeProbe, probeKey, validateTestSpec } from './project/projectTest'
import type { TestCheck } from './project/projectTest'

const frame = (joints?: BoxFrame['joints']): BoxFrame =>
  ({ count: 0, positions: new Float32Array(), quats: new Float32Array(), halfExtents: new Float32Array(), colors: new Float32Array(), kinds: new Uint8Array(), partIds: [], simTime: 0, ...(joints ? { joints } : {}) }) as unknown as BoxFrame

describe('joint probe', () => {
  const check: TestCheck = { at: 1, near: 0.3, tolerance: 0.01, probe: { joint: { part: 'stop', joint: 'lift' } } }

  it('validates and describes', () => {
    const ok = validateTestSpec({ scene: 'main', duration: 2, checks: [check] })
    expect(ok.ok).toBe(true)
    expect(describeProbe(check.probe!)).toBe('joint(stop.lift)')
    const bad = validateTestSpec({ scene: 'main', duration: 2, checks: [{ at: 1, near: 0, probe: { joint: { part: 'stop' } } }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join('\n')).toMatch(/joint\.joint must be the joint's name/)
  })

  it('reads the last commanded value and holds it across steps with no command', () => {
    const s = new ProbeSampler([check])
    expect(s.values(frame())).toEqual({}) // never commanded → absent, so the check fails as "never appeared"
    expect(s.values(frame({ stop: { lift: 0.3 } }))).toEqual({ [probeKey(0)]: 0.3 })
    expect(s.values(frame())).toEqual({ [probeKey(0)]: 0.3 }) // latched
    expect(s.values(frame({ other: { lift: 9 } }))).toEqual({ [probeKey(0)]: 0.3 }) // another part's joint
  })
})
