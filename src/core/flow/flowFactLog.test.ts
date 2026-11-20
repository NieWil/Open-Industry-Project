import { describe, expect, it } from 'vitest'
import { FlowFactLog } from './flowFactLog'
import type { FlowFact } from './flowFacts'

const fact = (id: number, over: Partial<FlowFact> = {}): FlowFact => ({ id, kind: 'dropped', t: id, at: [0, 0, 0], message: `fact ${id}`, ...over })

describe('FlowFactLog: the main thread record of a run', () => {
  it('keeps the latest record per id, so a stall that ended replaces its start', () => {
    const log = new FlowFactLog()
    log.accept([fact(1, { kind: 'stalled', part: 'belt' })])
    log.accept([fact(1, { kind: 'stalled', part: 'belt', duration: 3 }), fact(2)])
    expect(log.size).toBe(2)
    expect(log.get(1)?.duration).toBe(3)
    expect(log.all().map((f) => f.id)).toEqual([1, 2])
  })

  it('notifies once per batch, and never for an empty one', () => {
    const log = new FlowFactLog()
    let calls = 0
    const off = log.subscribe(() => calls++)
    log.accept([fact(1), fact(2), fact(3)])
    expect(calls).toBe(1)
    log.accept([])
    expect(calls).toBe(1)
    off()
    log.accept([fact(4)])
    expect(calls).toBe(1)
  })

  it('hands out the same snapshot until something changes (what a memo keys on)', () => {
    const log = new FlowFactLog()
    log.accept([fact(1)])
    const a = log.all()
    const rev = log.rev()
    expect(log.all()).toBe(a)
    log.accept([fact(2)])
    expect(log.rev()).toBeGreaterThan(rev)
    expect(log.all()).not.toBe(a)
  })

  it('a clear empties it and notifies, a clear of an empty log does neither', () => {
    const log = new FlowFactLog()
    let calls = 0
    log.subscribe(() => calls++)
    log.clear()
    expect(calls).toBe(0)
    log.accept([fact(1)])
    log.clear()
    expect(calls).toBe(2)
    expect(log.all()).toEqual([])
  })
})
