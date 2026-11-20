import { describe, expect, it } from 'vitest'
import { describeFault, faultActive, FaultInjector, formatTrace, operandProbeKey, probePartErrors, TestEvaluator, probeKey, TraceRecorder, validateTestSpec } from './projectTest'
import type { ResolvedFault, TestCheck, TestValue } from './projectTest'

/** Run a check against a scripted timeline of {time → tags} samples, return its single result. */
function evalCheck(check: TestCheck, duration: number, timeline: [number, Record<string, TestValue>][]) {
  const ev = new TestEvaluator({ duration, checks: [check] })
  for (const [t, tags] of timeline) ev.sample(t, tags)
  return ev.finalize().checks[0]!
}

describe('validateTestSpec', () => {
  const base = { duration: 10, checks: [{ at: 1, tag: 'x', equals: true }] }

  it('accepts a well-formed spec and normalizes it', () => {
    const res = validateTestSpec({ ...base, name: 'demo', inputs: [{ at: 0, tag: 'Start', value: true }] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.spec.duration).toBe(10)
    expect(res.spec.inputs).toEqual([{ at: 0, tag: 'Start', value: true }])
  })

  it('rejects a non-positive duration and an empty checks list', () => {
    expect(validateTestSpec({ duration: 0, checks: [] }).ok).toBe(false)
    const res = validateTestSpec({ duration: -1, checks: [{ at: 1, tag: 'x', equals: 1 }] })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.some((e) => e.includes('duration'))).toBe(true)
  })

  it('requires exactly one temporal mode and one predicate per check', () => {
    const twoTemporal = validateTestSpec({ duration: 5, checks: [{ at: 1, always: true, tag: 'x', equals: 1 }] })
    expect(twoTemporal.ok).toBe(false)
    if (!twoTemporal.ok) expect(twoTemporal.errors.some((e) => e.includes('exactly one of at/always/eventually'))).toBe(true)

    const noPredicate = validateTestSpec({ duration: 5, checks: [{ at: 1, tag: 'x' }] })
    expect(noPredicate.ok).toBe(false)
    if (!noPredicate.ok) expect(noPredicate.errors.some((e) => e.includes('exactly one of equals/min/max/near'))).toBe(true)
  })

  it('rejects a malformed input entry', () => {
    const res = validateTestSpec({ duration: 5, inputs: [{ at: 0, tag: '', value: 'nope' }], checks: [{ at: 1, tag: 'x', equals: 1 }] })
    expect(res.ok).toBe(false)
  })
})

describe('validateTestSpec - faults', () => {
  const base = { duration: 5, checks: [{ at: 1, tag: 'x', equals: true }] }
  const errorsOf = (faults: unknown): string[] => {
    const res = validateTestSpec({ ...base, faults })
    return res.ok ? [] : res.errors
  }

  it('accepts both kinds and keeps only the fields each one has', () => {
    const res = validateTestSpec({
      ...base,
      faults: [
        { at: 1, until: 2, part: 'pe1', kind: 'sensorStuck', value: true },
        { at: 0.5, part: 'm1', kind: 'actuatorDead' },
      ],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.spec.faults).toEqual([
      { at: 1, until: 2, part: 'pe1', kind: 'sensorStuck', value: true },
      { at: 0.5, part: 'm1', kind: 'actuatorDead' },
    ])
  })

  it('leaves faults off a spec that has none', () => {
    const res = validateTestSpec(base)
    expect(res.ok && res.spec.faults).toBe(undefined)
  })

  it('requires a stuck sensor to say which way it sticks, and a dead actuator not to', () => {
    expect(errorsOf([{ at: 1, part: 'pe1', kind: 'sensorStuck' }]).join()).toMatch(/value must be true or false/)
    expect(errorsOf([{ at: 1, part: 'm1', kind: 'actuatorDead', value: false }]).join()).toMatch(/value is only for sensorStuck/)
  })

  it('rejects an unknown kind, a missing part, a negative time, and an until that is not after at', () => {
    expect(errorsOf([{ at: 1, part: 'm1', kind: 'meltdown' }]).join()).toMatch(/kind must be one of sensorStuck\/actuatorDead\/commsLoss\/jam/)
    expect(errorsOf([{ at: 1, part: '', kind: 'actuatorDead' }]).join()).toMatch(/part must be a part id/)
    expect(errorsOf([{ at: -1, part: 'm1', kind: 'actuatorDead' }]).join()).toMatch(/at must be a time/)
    expect(errorsOf([{ at: 2, until: 2, part: 'm1', kind: 'actuatorDead' }]).join()).toMatch(/until must be a time after at/)
    expect(errorsOf({ at: 1 }).join()).toMatch(/faults must be an array/)
    expect(errorsOf([null]).join()).toMatch(/faults\[0\] must be an object/)
  })
})

describe('validateTestSpec - comms loss', () => {
  const base = { duration: 5, checks: [{ at: 1, tag: 'x', equals: true }] }
  const errorsOf = (faults: unknown): string[] => {
    const res = validateTestSpec({ ...base, faults })
    return res.ok ? [] : res.errors
  }

  it('accepts a network loss with no part, and one device with modes and a status bit', () => {
    const res = validateTestSpec({
      ...base,
      faults: [
        { at: 1, kind: 'commsLoss' },
        { at: 2, until: 3, kind: 'commsLoss', part: 'rio1', inputs: 'hold', outputs: 'off', statusTag: 'Rio1Fault' },
      ],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.spec.faults).toEqual([
      { at: 1, kind: 'commsLoss' },
      { at: 2, until: 3, kind: 'commsLoss', part: 'rio1', inputs: 'hold', outputs: 'off', statusTag: 'Rio1Fault' },
    ])
  })

  it('rejects a bad mode, an empty status tag, and an empty part', () => {
    expect(errorsOf([{ at: 1, kind: 'commsLoss', inputs: 'zero' }]).join()).toMatch(/inputs must be "off" or "hold"/)
    expect(errorsOf([{ at: 1, kind: 'commsLoss', statusTag: '' }]).join()).toMatch(/statusTag must be a PLC input's name/)
    expect(errorsOf([{ at: 1, kind: 'commsLoss', part: '' }]).join()).toMatch(/part must be a part id/)
  })

  it('keeps comms-only fields off the device faults', () => {
    expect(errorsOf([{ at: 1, part: 'm1', kind: 'actuatorDead', outputs: 'hold' }]).join()).toMatch(/outputs is only for commsLoss/)
    expect(errorsOf([{ at: 1, part: 'pe1', kind: 'sensorStuck', value: true, statusTag: 'X' }]).join()).toMatch(/statusTag is only for commsLoss/)
    expect(errorsOf([{ at: 1, kind: 'commsLoss', value: true }]).join()).toMatch(/value is only for sensorStuck/)
  })
})

describe('validateTestSpec - jam', () => {
  const base = { duration: 5, checks: [{ at: 1, tag: 'x', equals: true }] }
  const errorsOf = (faults: unknown): string[] => {
    const res = validateTestSpec({ ...base, faults })
    return res.ok ? [] : res.errors
  }

  it('accepts a zone and normalizes it', () => {
    const res = validateTestSpec({ ...base, faults: [{ at: 1, until: 3, kind: 'jam', zone: { min: [4, 0, -0.5], max: [5, 1, 0.5] } }] })
    expect(res.ok && res.spec.faults).toEqual([{ at: 1, until: 3, kind: 'jam', zone: { min: [4, 0, -0.5], max: [5, 1, 0.5] } }])
  })

  it('needs a zone, rejects a reversed one, and takes no part', () => {
    expect(errorsOf([{ at: 1, kind: 'jam' }]).join()).toMatch(/zone must be an object/)
    expect(errorsOf([{ at: 1, kind: 'jam', zone: { min: [5, 0, 0], max: [4, 1, 1] } }]).join()).toMatch(/reversed on x/)
    expect(errorsOf([{ at: 1, kind: 'jam', part: 'm1', zone: { min: [0, 0, 0], max: [1, 1, 1] } }]).join()).toMatch(/part is not for a jam/)
    expect(errorsOf([{ at: 1, kind: 'actuatorDead', part: 'm1', zone: { min: [0, 0, 0], max: [1, 1, 1] } }]).join()).toMatch(/zone is only for jam/)
  })

  it('names a jam by its zone', () => {
    expect(describeFault({ at: 0, kind: 'jam', zone: { min: [4, 0, -0.5], max: [5, 1, 0.5] } })).toBe('jam([4, 0, -0.5]..[5, 1, 0.5])')
  })
})

describe('FaultInjector', () => {
  const stuck: ResolvedFault = { fault: { at: 1, until: 2, part: 'pe1', kind: 'sensorStuck', value: true }, side: 'toPlc', forced: { PE1: true } }
  const dead: ResolvedFault = { fault: { at: 1.5, part: 'm1', kind: 'actuatorDead' }, side: 'toPart', forced: { Run: false, Speed: 0 } }

  it('is in effect from at (inclusive) to until (exclusive), and for good without until', () => {
    expect(faultActive(stuck.fault, 0.99)).toBe(false)
    expect(faultActive(stuck.fault, 1)).toBe(true)
    expect(faultActive(stuck.fault, 1.99)).toBe(true)
    expect(faultActive(stuck.fault, 2)).toBe(false)
    expect(faultActive(dead.fault, 1000)).toBe(true)
  })

  it('forces only its own side of the PLC, only while in effect', () => {
    const inj = new FaultInjector([stuck, dead])
    expect(inj.overrides('toPlc', 0.5, {})).toEqual({})
    expect(inj.overrides('toPlc', 1.2, {})).toEqual({ PE1: true })
    expect(inj.overrides('toPart', 1.2, {})).toEqual({})
    expect(inj.overrides('toPart', 1.6, {})).toEqual({ Run: false, Speed: 0 })
    expect(inj.overrides('toPlc', 2.5, {})).toEqual({})
  })

  it('lets a later fault win a key two of them force', () => {
    const stuckOff: ResolvedFault = { fault: { at: 1, until: 2, part: 'pe1', kind: 'sensorStuck', value: false }, side: 'toPlc', forced: { PE1: false } }
    expect(new FaultInjector([stuck, stuckOff]).overrides('toPlc', 1.5, {})).toEqual({ PE1: false })
  })

  it('hold: keeps what each key read the moment the fault began, whatever it reads after', () => {
    const lost: ResolvedFault = { fault: { at: 1, until: 2, kind: 'commsLoss' }, side: 'toPlc', forced: { PE1: false, Count: 0 }, hold: true }
    const inj = new FaultInjector([lost])
    expect(inj.overrides('toPlc', 0.9, { PE1: true, Count: 7 })).toEqual({})
    expect(inj.overrides('toPlc', 1, { PE1: true, Count: 7 })).toEqual({ PE1: true, Count: 7 }) // the onset snapshot
    expect(inj.overrides('toPlc', 1.5, { PE1: false, Count: 9 })).toEqual({ PE1: true, Count: 7 }) // still the snapshot
    expect(inj.overrides('toPlc', 2, { PE1: false, Count: 9 })).toEqual({}) // cleared: the live values return
  })

  it('hold: a key with no value yet at the onset falls back to its off value', () => {
    const lost: ResolvedFault = { fault: { at: 0, kind: 'commsLoss' }, side: 'toPart', forced: { Run: false }, hold: true }
    expect(new FaultInjector([lost]).overrides('toPart', 0, {})).toEqual({ Run: false })
  })

  it('idle: a status bit reads false before and after the fault, true during, and an active fault outranks it', () => {
    const bit: ResolvedFault = { fault: { at: 1, until: 2, kind: 'commsLoss', statusTag: 'IoFault' }, side: 'toPlc', forced: { IoFault: true }, idle: { IoFault: false } }
    const inj = new FaultInjector([bit])
    expect(inj.overrides('toPlc', 0.5, {})).toEqual({ IoFault: false })
    expect(inj.overrides('toPlc', 1.5, {})).toEqual({ IoFault: true })
    expect(inj.overrides('toPlc', 2.5, {})).toEqual({ IoFault: false })
    // a second loss on the same bit, still in effect, must not be masked by the first one's idle value
    const later: ResolvedFault = { ...bit, fault: { at: 2, until: 3, kind: 'commsLoss', statusTag: 'IoFault' } }
    expect(new FaultInjector([later, bit]).overrides('toPlc', 2.5, {})).toEqual({ IoFault: true })
  })

  it('names a fault by its device, or the whole network', () => {
    expect(describeFault(dead.fault)).toBe('actuatorDead(m1)')
    expect(describeFault({ at: 0, kind: 'commsLoss' })).toBe('commsLoss(all)')
    expect(describeFault({ at: 0, kind: 'commsLoss', part: 'rio1' })).toBe('commsLoss(rio1)')
  })
})

describe('validateTestSpec - world probes', () => {
  const spec = (check: unknown) => validateTestSpec({ duration: 10, checks: [check] })
  const errorsOf = (res: ReturnType<typeof validateTestSpec>) => (res.ok ? [] : res.errors)

  it('accepts a count probe and normalizes its zone', () => {
    const res = spec({ probe: { count: { zone: { min: [2, 0, -1], max: [6, 2, 1] } } }, eventually: true, min: 10 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.spec.checks[0]!.probe).toEqual({ count: { zone: { min: [2, 0, -1], max: [6, 2, 1] } } })
  })

  it('accepts a pose probe', () => {
    expect(spec({ probe: { pose: { part: 'agv-1', axis: 'x' } }, at: 30, near: 12.5, tolerance: 0.2 }).ok).toBe(true)
  })

  it('requires exactly one source - neither both tag and probe, nor neither', () => {
    expect(errorsOf(spec({ tag: 'x', probe: { count: {} }, at: 1, min: 0 })).some((e) => e.includes('exactly one of tag/probe'))).toBe(true)
    expect(errorsOf(spec({ at: 1, min: 0 })).some((e) => e.includes('exactly one of tag/probe'))).toBe(true)
  })

  it('requires exactly one probe kind', () => {
    expect(errorsOf(spec({ probe: {}, at: 1, min: 0 })).some((e) => e.includes('exactly one of count/pose'))).toBe(true)
    expect(errorsOf(spec({ probe: { count: {}, pose: { part: 'a', axis: 'x' } }, at: 1, min: 0 })).length).toBeGreaterThan(0)
  })

  it('rejects a reversed zone, which would silently match nothing', () => {
    const errs = errorsOf(spec({ probe: { count: { zone: { min: [6, 0, -1], max: [2, 2, 1] } } }, at: 1, min: 0 }))
    expect(errs.some((e) => e.includes('reversed on x'))).toBe(true)
  })

  it('rejects a malformed zone vector', () => {
    expect(errorsOf(spec({ probe: { count: { zone: { min: [0, 0], max: [1, 1, 1] } } }, at: 1, min: 0 })).some((e) => e.includes('3 finite numbers'))).toBe(true)
  })

  it('rejects a bad pose axis and an empty part id', () => {
    expect(errorsOf(spec({ probe: { pose: { part: 'a', axis: 'w' } }, at: 1, min: 0 })).some((e) => e.includes('axis must be one of'))).toBe(true)
    expect(errorsOf(spec({ probe: { pose: { part: '', axis: 'x' } }, at: 1, min: 0 })).some((e) => e.includes('non-empty part id'))).toBe(true)
  })

  it('rejects a BOOL predicate on a probe, which could never hold', () => {
    const errs = errorsOf(spec({ probe: { count: {} }, always: true, equals: true }))
    expect(errs.some((e) => e.includes('must be a number'))).toBe(true)
  })

  it('rejects an unknown count filter value', () => {
    expect(errorsOf(spec({ probe: { count: { kind: 'crate' } }, at: 1, min: 0 })).some((e) => e.includes('"box", "pallet" or "tote"'))).toBe(true)
  })
})

describe('TestEvaluator - probe checks reuse the whole temporal/predicate matrix', () => {
  const countCheck: TestCheck = { probe: { count: { zone: { min: [0, 0, 0], max: [1, 1, 1] } } }, eventually: true, min: 3 }

  it('passes on a probe value and names the probe in the detail', () => {
    const r = evalCheck(countCheck, 10, [
      [1, { [probeKey(0)]: 1 }],
      [2, { [probeKey(0)]: 4 }],
    ])
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('count(zone [0, 0, 0]..[1, 1, 1])')
    expect(r.detail).toContain('t=2.00s')
  })

  it('fails a probe that never satisfies, without mentioning tags', () => {
    const r = evalCheck(countCheck, 10, [[1, { [probeKey(0)]: 0 }]])
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('never reached ≥ 3')
  })

  it('flags an absent pose probe as a missing part, not a missing tag', () => {
    const r = evalCheck({ probe: { pose: { part: 'agv-9', axis: 'x' } }, at: 1, min: 0 }, 10, [[1, { Other: 1 }]])
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('probe pose(agv-9.x) never appeared')
    expect(r.detail).toContain('no such part in the running scene')
  })

  // A missing tag's message names what is true (the names that do exist), not hypotheses like "typo, or
  // not exposed by the scene": in an agent loop the usual cause is no ST program loaded, so every program
  // tag is absent, and an agent cannot ask a follow-up question.
  it('answers a misspelled tag with the names that do exist, not a guess', () => {
    const r = evalCheck({ always: true, tag: 'Msipelled', equals: false }, 3, [[1, { Jam: false, Run: true }]])
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('tag "Msipelled" never appeared')
    expect(r.detail).toContain('the run did publish: Jam, Run')
    expect(r.detail).not.toContain('typo') // a checkable fact, not a guess
  })

  it('distinguishes "no tags at all" - the unloaded-program case - from a naming mistake', () => {
    const r = evalCheck({ always: true, tag: 'Run', equals: true }, 3, [[1, {}]])
    expect(r.detail).toContain('no tags existed in this run at all')
    expect(r.detail).toContain('stProgram') // names where to look, in the file that decides it
  })

  it('does not count probe bookkeeping as a published tag', () => {
    // probe keys are NUL-prefixed; treating one as a tag would report "the run did publish: \0probe0"
    const r = evalCheck({ always: true, tag: 'Run', equals: true }, 3, [[1, { [probeKey(0)]: 1 }]])
    expect(r.detail).toContain('no tags existed in this run at all')
  })

  it('caps the published list rather than printing a 200-tag scene', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`T${String(i).padStart(2, '0')}`, true]))
    const r = evalCheck({ always: true, tag: 'Nope', equals: true }, 3, [[1, many]])
    expect(r.detail).toContain('+12 more')
  })
})

describe('TestEvaluator - at (sample once)', () => {
  it('passes when the predicate holds at the sampled time', () => {
    const r = evalCheck({ at: 5, tag: 'Run', equals: true }, 10, [
      [4.98, { Run: false }],
      [5.0, { Run: true }],
      [5.02, { Run: false }], // later samples don't matter for `at`
    ])
    expect(r.ok).toBe(true)
  })

  it('fires at the first sample reaching the target time and reports the observed value on failure', () => {
    const r = evalCheck({ at: 5, tag: 'Run', equals: true }, 10, [
      [5.0, { Run: false }],
      [6.0, { Run: true }],
    ])
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('was false at t=5s')
  })

  it('fails if the run ends before the target time', () => {
    const r = evalCheck({ at: 20, tag: 'Run', equals: true }, 10, [[9.9, { Run: true }]])
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('run ended before')
  })
})

describe('TestEvaluator - always (invariant)', () => {
  it('passes when the predicate holds at every sample', () => {
    const r = evalCheck({ always: true, tag: 'Jam', equals: false }, 3, [
      [1, { Jam: false }],
      [2, { Jam: false }],
      [3, { Jam: false }],
    ])
    expect(r.ok).toBe(true)
  })

  it('fails on the first violation and records when', () => {
    const r = evalCheck({ always: true, tag: 'Jam', equals: false }, 3, [
      [1, { Jam: false }],
      [2, { Jam: true }],
      [3, { Jam: false }],
    ])
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('t=2.00s')
  })
})

describe('TestEvaluator - eventually (liveness)', () => {
  it('passes when the predicate holds at some sample within the window', () => {
    const r = evalCheck({ eventually: true, within: 5, tag: 'Count', min: 10 }, 30, [
      [1, { Count: 3 }],
      [4, { Count: 12 }],
    ])
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('t=4.00s')
  })

  it('fails when it only satisfies after the window closes', () => {
    const r = evalCheck({ eventually: true, within: 5, tag: 'Count', min: 10 }, 30, [
      [4, { Count: 3 }],
      [6, { Count: 12 }], // too late
    ])
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('within 5s')
  })

  it('defaults the window to the run duration when `within` is omitted', () => {
    const r = evalCheck({ eventually: true, tag: 'Done', equals: true }, 10, [
      [9, { Done: false }],
      [9.9, { Done: true }],
    ])
    expect(r.ok).toBe(true)
  })
})

describe('TestEvaluator - predicates + missing tags', () => {
  it('near/tolerance compares within an absolute band', () => {
    expect(evalCheck({ at: 1, tag: 'S', near: 1.2, tolerance: 0.05 }, 2, [[1, { S: 1.23 }]]).ok).toBe(true)
    expect(evalCheck({ at: 1, tag: 'S', near: 1.2, tolerance: 0.05 }, 2, [[1, { S: 1.3 }]]).ok).toBe(false)
  })

  it('min/max are numeric bounds', () => {
    expect(evalCheck({ at: 1, tag: 'N', min: 10 }, 2, [[1, { N: 10 }]]).ok).toBe(true)
    expect(evalCheck({ at: 1, tag: 'N', max: 10 }, 2, [[1, { N: 11 }]]).ok).toBe(false)
  })

  it('a check whose tag never appears fails as "never appeared" (typo guard)', () => {
    const r = evalCheck({ always: true, tag: 'Msipelled', equals: false }, 3, [
      [1, { Jam: false }],
      [2, { Jam: false }],
    ])
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('never appeared')
  })
})

describe('when a check failed (failedAt), which a trace of the run is centred on', () => {
  const timeline: [number, Record<string, TestValue>][] = [
    [0.1, { Q: false }],
    [0.2, { Q: true }],
    [0.3, { Q: true }],
  ]
  it('is the time an `at` check looked, the moment an `always` broke, and the end of a missed `eventually`', () => {
    expect(evalCheck({ at: 0.3, tag: 'Q', equals: false }, 1, timeline).failedAt).toBe(0.3)
    expect(evalCheck({ always: true, tag: 'Q', equals: false }, 1, timeline).failedAt).toBe(0.2)
    expect(evalCheck({ eventually: true, within: 0.5, tag: 'Q', equals: 5 }, 1, timeline).failedAt).toBe(0.5)
  })
  it('is absent on a check that held', () => {
    expect(evalCheck({ at: 0.3, tag: 'Q', equals: true }, 1, timeline).failedAt).toBeUndefined()
  })
})

describe('TraceRecorder', () => {
  const run = (rec: TraceRecorder): void => {
    rec.sample(0.1, { Start: false, Stop: false, Enc: 0 })
    rec.sample(0.2, { Start: true, Stop: false, Enc: 1 })
    rec.sample(0.3, { Start: false, Stop: false, Enc: 2 })
    rec.sample(0.4, { Start: false, Stop: true, Enc: 3, Late: 7 })
  }
  it('keeps each tag as its first value and then only its changes, with their times', () => {
    const rec = new TraceRecorder(['Start', 'Stop', 'Late'])
    run(rec)
    expect(rec.result()).toEqual([
      { tag: 'Late', start: 7, changes: [] },
      { tag: 'Start', start: false, changes: [{ t: 0.2, v: true }, { t: 0.3, v: false }] },
      { tag: 'Stop', start: false, changes: [{ t: 0.4, v: true }] },
    ])
  })
  it('in a window, starts each tag at what it held coming in, and can leave out the ones that held', () => {
    const rec = new TraceRecorder('all', [{ from: 0.3, to: 0.4 }])
    run(rec)
    expect(rec.result(0, true).map((t) => [t.tag, t.start, t.changes.map((c) => c.t)])).toEqual([
      ['Enc', 1, [0.3, 0.4]],
      ['Late', 7, []],
      ['Start', true, [0.3]],
      ['Stop', false, [0.4]],
    ].filter(([, , ch]) => (ch as number[]).length > 0))
  })
  it('never records a probe (a NUL-prefixed key is the harness bookkeeping)', () => {
    const rec = new TraceRecorder('all')
    rec.sample(0.1, { [probeKey(0)]: 3, A: true })
    expect(rec.result().map((t) => t.tag)).toEqual(['A'])
  })
  it('formats as value then each change, and cuts a tag that changes too often to read', () => {
    const rec = new TraceRecorder('all')
    for (let i = 0; i < 20; i++) rec.sample(i / 10, { Enc: i, Go: i >= 5 })
    const [enc, go] = formatTrace(rec.result(), 4)
    expect(go).toBe('Go   FALSE -> 0.500s TRUE')
    expect(enc).toContain('... 15 more ...')
    expect(enc!.startsWith('Enc  0 -> 0.100s 1 -> 0.200s 2 -> ... 15 more ... -> 1.800s 18 -> 1.900s 19')).toBe(true)
  })
})

describe('validateTestSpec - notEquals, a tag or probe on the right, windows, passed + colour', () => {
  const errorsOf = (check: Record<string, unknown>, duration = 10): string[] => {
    const res = validateTestSpec({ duration, checks: [check] })
    return res.ok ? [] : res.errors
  }
  const zone = { min: [0, 0, 0], max: [1, 1, 1] }

  it('accepts each new form and keeps it normalized', () => {
    const res = validateTestSpec({
      duration: 20,
      checks: [
        { at: 1, tag: 'Mode', notEquals: 3 },
        { at: 19, tag: 'Sorted1', equals: { tag: 'Lane1Out' } },
        { always: true, tag: 'Sorted1', min: { probe: { passed: { zone, color: 'RED' } } } },
        { always: true, from: 12, until: 19, tag: 'Running', equals: false },
        { eventually: true, from: 2, within: 8, tag: 'Running', equals: true },
        { always: true, probe: { count: { color: '#E01010' } }, max: 3 },
      ],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.spec.checks[2]!.min).toEqual({ probe: { passed: { zone: { min: [0, 0, 0], max: [1, 1, 1] }, color: 'red' } } })
    expect(res.spec.checks[5]!.probe).toEqual({ count: { color: '#e01010' } })
  })

  it('rejects a malformed right-hand side', () => {
    expect(errorsOf({ at: 1, tag: 'x', equals: { tag: '' } }).join()).toMatch(/equals\.tag must be a non-empty tag name/)
    expect(errorsOf({ at: 1, tag: 'x', equals: { name: 'y' } }).join()).toMatch(/exactly one of tag\/probe/)
    expect(errorsOf({ at: 1, tag: 'x', min: 'y' }).join()).toMatch(/min must be a number, or \{"tag"/)
    expect(errorsOf({ at: 1, tag: 'x', notEquals: 'y' }).join()).toMatch(/notEquals must be a boolean, a finite number/)
    expect(errorsOf({ at: 1, tag: 'x', min: { probe: { count: { kind: 'crate' } } } }).join()).toMatch(/"box", "pallet" or "tote"/)
  })

  it('rejects sides of types that could never compare', () => {
    const lamp = { lamp: { part: 'b', lamp: 'red' } }
    expect(errorsOf({ at: 1, tag: 'x', max: { probe: lamp } }).join()).toMatch(/yields lit \/ dark, not a number/)
    expect(errorsOf({ at: 1, probe: { count: {} }, equals: { probe: lamp } }).join()).toMatch(/compares a count\/coordinate with lamp/)
    expect(errorsOf({ at: 1, probe: lamp, notEquals: 2 }).join()).toMatch(/must use equals: true or false/)
    expect(errorsOf({ at: 1, probe: lamp, notEquals: true })).toEqual([])
  })

  it('rejects a window on an `at` check, one past the run, one that ends before it starts, and until with within', () => {
    expect(errorsOf({ at: 1, from: 0, tag: 'x', equals: 1 }).join()).toMatch(/only for always or eventually/)
    expect(errorsOf({ always: true, until: 11, tag: 'x', equals: 1 }).join()).toMatch(/until \(11s\) is past the end of the run/)
    expect(errorsOf({ always: true, from: 10, tag: 'x', equals: 1 }).join()).toMatch(/not before the end of the run/)
    expect(errorsOf({ always: true, from: 5, until: 4, tag: 'x', equals: 1 }).join()).toMatch(/ends \(4s\) before it starts/)
    expect(errorsOf({ eventually: true, from: 5, within: 5, tag: 'x', equals: 1 }).join()).toMatch(/ends \(5s\) before it starts/)
    expect(errorsOf({ eventually: true, until: 5, within: 6, tag: 'x', equals: 1 }).join()).toMatch(/until or within, not both/)
    expect(errorsOf({ always: true, from: -1, tag: 'x', equals: 1 }).join()).toMatch(/from must be a time ≥ 0/)
  })

  it('needs a zone on passed, a known colour, and no filter it does not have', () => {
    expect(errorsOf({ at: 1, probe: { passed: {} }, min: 0 }).join()).toMatch(/passed\.zone is required/)
    expect(errorsOf({ at: 1, probe: { passed: { zone, color: 'purple' } }, min: 0 }).join()).toMatch(/color must be red\/green\/blue\/yellow or a "#rrggbb" tint/)
    expect(errorsOf({ at: 1, probe: { count: { color: '#e0101' } }, min: 0 }).join()).toMatch(/color must be/)
    expect(errorsOf({ at: 1, probe: { count: { colour: 'red' } }, min: 0 }).join()).toMatch(/count\.colour is not a filter/)
  })

  it('needs a zone and a heading on square, and takes heading on square only', () => {
    expect(errorsOf({ always: true, probe: { square: { zone, heading: 30, color: 'red' } }, max: 10 })).toEqual([])
    expect(errorsOf({ always: true, probe: { square: { heading: 30 } }, max: 10 }).join()).toMatch(/square\.zone is required/)
    expect(errorsOf({ always: true, probe: { square: { zone } }, max: 10 }).join()).toMatch(/square\.heading is required/)
    expect(errorsOf({ always: true, probe: { square: { zone, heading: '30' } }, max: 10 }).join()).toMatch(/square\.heading is required/)
    expect(errorsOf({ always: true, probe: { count: { zone, heading: 30 } }, max: 10 }).join()).toMatch(/count\.heading is not a filter/)
  })
})

describe('TestEvaluator - notEquals', () => {
  it('passes while the value differs, fails with the value when it does not', () => {
    expect(evalCheck({ always: true, tag: 'Mode', notEquals: 3 }, 2, [[1, { Mode: 1 }], [2, { Mode: 2 }]]).ok).toBe(true)
    const r = evalCheck({ always: true, tag: 'Mode', notEquals: 3 }, 2, [[1, { Mode: 1 }], [2, { Mode: 3 }]])
    expect(r.ok).toBe(false)
    expect(r.detail).toBe('Mode became 3 at t=2.00s (must always be ≠ 3)')
  })
})

describe('TestEvaluator - a tag (or probe) on the right-hand side', () => {
  it('compares two tags at the same step, and names the other side and its value', () => {
    const ok = evalCheck({ at: 2, tag: 'Sorted1', equals: { tag: 'Lane1Out' } }, 3, [[2, { Sorted1: 8, Lane1Out: 8 }]])
    expect(ok.ok).toBe(true)
    expect(ok.detail).toBe('Sorted1 = Lane1Out (8) at t=2s')
    const bad = evalCheck({ at: 2, tag: 'Sorted1', equals: { tag: 'Lane1Out' } }, 3, [[2, { Sorted1: 8, Lane1Out: 7 }]])
    expect(bad.ok).toBe(false)
    expect(bad.detail).toBe('Sorted1 was 8 at t=2s, expected = Lane1Out (7)')
  })

  it('always / eventually against a moving right-hand side', () => {
    const tl: [number, Record<string, TestValue>][] = [
      [1, { Out: 0, In: 1 }],
      [2, { Out: 1, In: 2 }],
      [3, { Out: 2, In: 2 }],
    ]
    expect(evalCheck({ always: true, tag: 'Out', max: { tag: 'In' } }, 3, tl).ok).toBe(true)
    expect(evalCheck({ always: true, tag: 'Out', min: { tag: 'In' } }, 3, tl).ok).toBe(false) // negative control
    const ev = evalCheck({ eventually: true, tag: 'Out', equals: { tag: 'In' } }, 3, tl)
    expect(ev.ok && ev.detail).toBe('Out reached = In (2) at t=3.00s')
  })

  it('reads a probe operand from its own key', () => {
    const check: TestCheck = { at: 1, tag: 'Sorted1', equals: { probe: { count: {} } } }
    expect(evalCheck(check, 1, [[1, { Sorted1: 2, [operandProbeKey(0)]: 2 }]]).ok).toBe(true)
    expect(evalCheck(check, 1, [[1, { Sorted1: 2, [operandProbeKey(0)]: 3 }]]).ok).toBe(false)
  })

  it('fails when the right-hand tag never appeared, naming it and what did appear (no vacuous pass)', () => {
    const r = evalCheck({ always: true, tag: 'Sorted1', max: { tag: 'Lane1Outt' } }, 2, [[1, { Sorted1: 0, Lane1Out: 0 }]])
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/^tag "Lane1Outt" \(the right-hand side\) never appeared \(the run did publish: Lane1Out, Sorted1\)/)
    const p = evalCheck({ always: true, tag: 'Sorted1', max: { probe: { passed: { zone: { min: [0, 0, 0], max: [1, 1, 1] } } } } }, 2, [[1, { Sorted1: 0 }]])
    expect(p.ok).toBe(false)
    expect(p.detail).toMatch(/probe passed\(zone .*\) \(the right-hand side\) never appeared \(no cargo at all entered its zone/)
  })

  it('an `at` with the right-hand side absent at that moment fails, saying so', () => {
    const r = evalCheck({ at: 1, tag: 'A', equals: { tag: 'B' } }, 2, [
      [1, { A: 1 }],
      [2, { A: 1, B: 1 }],
    ])
    expect(r.ok).toBe(false)
    expect(r.detail).toBe('tag "B" (the right-hand side) not present at t=1s')
  })
})

describe('TestEvaluator - always / eventually over a window', () => {
  const run: [number, Record<string, TestValue>][] = [
    [1, { Running: true }],
    [2, { Running: false }],
    [3, { Running: false }],
    [4, { Running: true }],
  ]

  it('always: judged only inside [from, until], both ends inclusive', () => {
    const ok = evalCheck({ always: true, from: 2, until: 3, tag: 'Running', equals: false }, 4, run)
    expect(ok.ok).toBe(true)
    expect(ok.detail).toBe('Running stayed = false between t=2s and t=3s')
    // negative controls: widen it either way and the run outside breaks it
    const late = evalCheck({ always: true, from: 2, until: 4, tag: 'Running', equals: false }, 4, run)
    expect(late.ok).toBe(false)
    expect(late.detail).toBe('Running became true at t=4.00s (must always be = false between t=2s and t=4s)')
    expect(late.failedAt).toBe(4)
    expect(evalCheck({ always: true, from: 1, until: 3, tag: 'Running', equals: false }, 4, run).ok).toBe(false)
    expect(evalCheck({ always: true, from: 4, tag: 'Running', equals: true }, 4, run).ok).toBe(true)
  })

  it('always: a window its source was never present in held over nothing, and fails', () => {
    const r = evalCheck({ always: true, from: 3, until: 4, tag: 'Alarm', equals: false }, 4, [
      [1, { Alarm: false }],
      [2, { Alarm: false }],
    ])
    expect(r.ok).toBe(false)
    expect(r.detail).toBe('Alarm was never present between t=3s and t=4s, so "always = false" held over nothing')
  })

  it('eventually: a match before `from` does not count', () => {
    expect(evalCheck({ eventually: true, from: 2, tag: 'Running', equals: true }, 4, run).detail).toBe('Running reached = true at t=4.00s')
    const r = evalCheck({ eventually: true, from: 2, until: 3, tag: 'Running', equals: true }, 4, run)
    expect(r.ok).toBe(false) // true at 1 s and at 4 s, both outside
    expect(r.detail).toBe('Running never reached = true between t=2s and t=3s')
    expect(r.failedAt).toBe(3)
  })
})

describe('TestEvaluator - the never-appeared guard on the new probes', () => {
  it('names why a colour or a passed probe never answered', () => {
    const colour = evalCheck({ always: true, probe: { count: { color: 'red' } }, max: 0 }, 1, [[1, {}]])
    expect(colour.ok).toBe(false)
    expect(colour.detail).toBe('probe count(red) never appeared (no red cargo existed in the whole run - is the colour right?)')
    const gate = evalCheck({ always: true, probe: { passed: { zone: { min: [0, 0, 0], max: [1, 1, 1] } } }, max: 0 }, 1, [[1, {}]])
    expect(gate.ok).toBe(false)
    expect(gate.detail).toMatch(/never appeared \(no cargo at all entered its zone in the whole run - is the zone on the cargo's path\?\)$/)
  })
})

describe('a pass that proves nothing (CheckResult.warning)', () => {
  const ready = { eventually: true, tag: 'Ready', equals: false } as TestCheck
  it('warns on an eventually that already held on the first sample of the run', () => {
    const r = evalCheck(ready, 2, [[0.01, { Ready: false }], [1, { Ready: true }]])
    expect(r.ok).toBe(true)
    expect(r.warning).toContain('already true at the start of the run')
  })

  it('does not warn when it became true during the run', () => {
    const r = evalCheck(ready, 2, [[0.01, { Ready: true }], [1, { Ready: false }]])
    expect(r.ok).toBe(true)
    expect(r.warning).toBeUndefined()
  })

  it('does not warn on a window the author started later, nor on a source that first appears when it comes true', () => {
    expect(evalCheck({ ...ready, from: 0.5 }, 2, [[0.01, { Ready: true }], [1, { Ready: false }]]).warning).toBeUndefined()
    // a passed probe has no value until a case enters its zone: holding on its first value is the event itself
    expect(evalCheck(ready, 2, [[0.01, {}], [1, { Ready: false }]]).warning).toBeUndefined()
  })
})

describe('probePartErrors: a count or passed probe names a placed part', () => {
  const parts = [{ id: 'box1', packageId: 'oip.box' }, { id: 'box2', packageId: 'oip.box' }, { id: 'belt', packageId: 'oip.belt-conveyor' }]
  const zone = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }
  it('accepts a placed part id, and no part at all', () => {
    expect(probePartErrors(parts, [{ eventually: true, min: 1, probe: { count: { zone, part: 'box1' } } }, { at: 1, max: 0, probe: { count: {} } }])).toEqual([])
  })
  it('names the placed parts of a part type given in its place, on a probe or a right-hand operand', () => {
    const [onProbe] = probePartErrors(parts, [{ eventually: true, min: 1, probe: { passed: { zone, part: 'oip.box' } } }])
    expect(onProbe).toContain('is a part type')
    expect(onProbe).toContain('box1, box2')
    expect(probePartErrors(parts, [{ at: 1, tag: 'N', equals: { probe: { count: { part: 'oip.box' } } } }])).toHaveLength(1)
  })
  it('refuses an id no part has', () => {
    expect(probePartErrors(parts, [{ at: 1, max: 0, probe: { count: { part: 'bx1' } } }])[0]).toContain('no placed part')
  })
})

describe('validateTestSpec: the marked filter', () => {
  const spec = (marked: unknown) => validateTestSpec({ duration: 1, checks: [{ at: 1, min: 0, probe: { count: { marked } } }] })
  it('takes a mark key, or one key and its value', () => {
    expect(spec('sealed').ok).toBe(true)
    expect(spec({ code: 2 }).ok).toBe(true)
    expect(spec({ sku: 'A-100' }).ok).toBe(true)
  })
  it('refuses anything else, naming the two forms', () => {
    for (const bad of ['', { a: 1, b: 2 }, {}, { code: [1] }, 3]) {
      const r = spec(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join(' ')).toContain('marked must be a mark key')
    }
  })
})

describe('a range check: min and max together', () => {
  it('validates two numbers, min not above max, and nothing more', () => {
    const spec = (c: Record<string, unknown>) => validateTestSpec({ duration: 5, checks: [{ at: 1, tag: 'Kg', ...c }] })
    expect(spec({ min: 9, max: 11 }).ok).toBe(true)
    const above = spec({ min: 11, max: 9 })
    expect(above.ok).toBe(false)
    if (!above.ok) expect(above.errors.join(' ')).toContain('above its max')
    expect(spec({ min: 9, max: { tag: 'Hi' } }).ok).toBe(false) // a range takes two numbers
    expect(spec({ min: 9, max: 11, equals: 10 }).ok).toBe(false) // and is the only predicate
  })

  it('holds inside the range, ends included, and says the range when it fails', () => {
    const kg = (v: number) => evalCheck({ at: 1, tag: 'Kg', min: 9, max: 11 } as TestCheck, 2, [[1, { Kg: v }]])
    expect(kg(9).ok).toBe(true)
    expect(kg(11).ok).toBe(true)
    const low = kg(7)
    expect(low.ok).toBe(false)
    expect(low.detail).toContain('expected in 9..11')
    // an invariant over a window too
    const r = evalCheck({ always: true, tag: 'Kg', min: 9, max: 11 } as TestCheck, 2, [[0.5, { Kg: 10 }], [1, { Kg: 12 }]])
    expect(r.ok).toBe(false)
  })
})
