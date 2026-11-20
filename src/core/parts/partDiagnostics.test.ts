import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allPartDiagnostics, clearPartDiagnostics, notePartDiagnosticsDropped, partDiagnosticsFor, partDiagnosticsOverflowed, reportPartDiagnostic, subscribePartDiagnostics } from './partDiagnostics'

describe('partDiagnostics channel', () => {
  beforeEach(() => clearPartDiagnostics())

  it('deduplicates a repeated diagnostic into one entry with a bumped count', () => {
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'boom', simTime: 1 })
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'boom', simTime: 2 })
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'boom', simTime: 3 })
    const diags = partDiagnosticsFor('p1')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.count).toBe(3)
    expect(diags[0]!.firstSimTime).toBe(1)
    expect(diags[0]!.lastSimTime).toBe(3)
  })

  it('keeps distinct messages / parts / sources as separate entries', () => {
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'boom' })
    reportPartDiagnostic({ source: 'geometry', partId: 'p1', message: 'boom' })
    reportPartDiagnostic({ source: 'step', partId: 'p2', message: 'boom' })
    expect(allPartDiagnostics()).toHaveLength(3)
    expect(partDiagnosticsFor('p1')).toHaveLength(2)
  })

  it('notifies subscribers once per unique diagnostic - count bumps are silent', () => {
    const seen = vi.fn()
    const off = subscribePartDiagnostics(seen)
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'boom' })
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'boom' })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith({ kind: 'report', entry: expect.objectContaining({ message: 'boom' }) })
    off()
  })

  it('clearing one part drops only its entries and notifies a clear event', () => {
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'boom' })
    reportPartDiagnostic({ source: 'step', partId: 'p2', message: 'boom' })
    const seen = vi.fn()
    const off = subscribePartDiagnostics(seen)
    clearPartDiagnostics('p1')
    expect(partDiagnosticsFor('p1')).toHaveLength(0)
    expect(partDiagnosticsFor('p2')).toHaveLength(1)
    expect(seen).toHaveBeenCalledWith({ kind: 'clear', partId: 'p1' })
    off()
  })

  it('clearing an already-empty part does not notify', () => {
    const seen = vi.fn()
    const off = subscribePartDiagnostics(seen)
    clearPartDiagnostics('nobody')
    expect(seen).not.toHaveBeenCalled()
    off()
  })

  it('returns a stable snapshot reference until something changes', () => {
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'boom' })
    const a = allPartDiagnostics()
    expect(allPartDiagnostics()).toBe(a)
    reportPartDiagnostic({ source: 'step', partId: 'p1', message: 'other' })
    expect(allPartDiagnostics()).not.toBe(a)
  })
})

describe('the cap', () => {
  beforeEach(() => clearPartDiagnostics())

  it('says when it stopped recording, once, and forgets it on a full clear', () => {
    const events: string[] = []
    const off = subscribePartDiagnostics((e) => events.push(e.kind))
    for (let i = 0; i < 200; i++) reportPartDiagnostic({ source: 'step', partId: `p${i}`, message: 'threw' })
    expect(partDiagnosticsOverflowed()).toBe(false)
    // past the cap: dropped, and reported as dropped exactly once however many more arrive
    for (let i = 200; i < 260; i++) reportPartDiagnostic({ source: 'step', partId: `p${i}`, message: 'threw' })
    expect(allPartDiagnostics()).toHaveLength(200)
    expect(partDiagnosticsOverflowed()).toBe(true)
    expect(events.filter((k) => k === 'dropped')).toHaveLength(1)
    // a repeat of a kept entry is not a drop
    events.length = 0
    reportPartDiagnostic({ source: 'step', partId: 'p0', message: 'threw' })
    expect(events).toEqual([])
    off()
    clearPartDiagnostics()
    expect(partDiagnosticsOverflowed()).toBe(false)
  })

  it('takes a drop in the sim worker too, which the main thread only hears about as an event', () => {
    notePartDiagnosticsDropped()
    expect(partDiagnosticsOverflowed()).toBe(true)
  })
})
