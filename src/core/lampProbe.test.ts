// The `lamp` world probe: a project test reads whether a part's lamp is lit directly, instead of the part having
// to publish its lamps as a debug tag (what an agent's beacon trial had to add).

import { describe, expect, it } from 'vitest'
import type { BoxFrame } from './frame'
import { ProbeSampler } from './project/projectProbe'
import { describeProbe, probeKey, validateTestSpec } from './project/projectTest'
import type { TestCheck } from './project/projectTest'

const frame = (lamps?: BoxFrame['lamps']): BoxFrame =>
  ({ count: 0, positions: new Float32Array(), quats: new Float32Array(), halfExtents: new Float32Array(), colors: new Float32Array(), kinds: new Uint8Array(), partIds: [], simTime: 0, ...(lamps ? { lamps } : {}) }) as unknown as BoxFrame

describe('lamp probe', () => {
  const check: TestCheck = { at: 1, equals: true, probe: { lamp: { part: 'beacon', lamp: 'red' } } }

  it('validates and describes', () => {
    const ok = validateTestSpec({ scene: 'main', duration: 2, checks: [check] })
    expect(ok.ok).toBe(true)
    expect(describeProbe(check.probe!)).toBe('lamp(beacon.red)')
    const bad = validateTestSpec({ scene: 'main', duration: 2, checks: [{ at: 1, equals: true, probe: { lamp: { part: 'beacon' } } }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join('\n')).toMatch(/lamp\.lamp must be the lamp's name/)
    const numeric = validateTestSpec({ scene: 'main', duration: 2, checks: [{ at: 1, min: 1, probe: { lamp: { part: 'beacon', lamp: 'red' } } }] })
    expect(numeric.ok).toBe(false) // a lamp is lit or dark
    if (!numeric.ok) expect(numeric.errors.join('\n')).toMatch(/must use equals: true or false/)
  })

  it('reads the last commanded state and holds it across steps with no command', () => {
    const s = new ProbeSampler([check])
    expect(s.values(frame())).toEqual({}) // never commanded → absent, so the check fails as "never appeared"
    expect(s.values(frame({ beacon: { red: true } }))).toEqual({ [probeKey(0)]: true })
    expect(s.values(frame())).toEqual({ [probeKey(0)]: true }) // latched
    expect(s.values(frame({ beacon: { red: false, green: true } }))).toEqual({ [probeKey(0)]: false })
    expect(s.values(frame({ other: { red: true } }))).toEqual({ [probeKey(0)]: false }) // another part's lamp
  })
})
