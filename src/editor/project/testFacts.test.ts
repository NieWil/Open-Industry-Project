import { describe, expect, it } from 'vitest'
import type { FlowFact } from '../../core/flow/flowFacts'
import { TEST_FACTS_SHOWN, testFactsView } from './testFacts'

const fact = (id: number, t: number, kind: FlowFact['kind'] = 'dropped'): FlowFact => ({ id, kind, t, at: [0, 0, 0], message: `fact ${id}` })

describe('a project test run, as its flow facts', () => {
  it('summarizes every test by kind, pass or fail, and lists nothing more for a pass', () => {
    const v = testFactsView([{ ok: true }], [fact(1, 1), fact(2, 2, 'stalled'), fact(3, 3)], 0, 10)
    expect(v.summary).toBe('2 dropped, 1 stalled')
    expect(v.total).toBe(3)
    expect(v.beforeFailure).toBeUndefined()
    expect(testFactsView([{ ok: true }], [], 0, 10).summary).toBe('none')
  })

  it('lists the facts up to the earliest failing check in time, oldest first', () => {
    const checks = [{ ok: true }, { ok: false, failedAt: 8 }, { ok: false, failedAt: 4 }]
    const v = testFactsView(checks, [fact(3, 6), fact(1, 1), fact(2, 4)], 0, 10)
    expect(v.beforeFailure?.check).toBe(2)
    expect(v.beforeFailure?.until).toBe(4)
    expect(v.beforeFailure?.lines).toHaveLength(2)
    expect(v.beforeFailure?.lines[0]).toMatch(/^t=1\.000s/)
    expect(v.beforeFailure?.earlier).toBe(0)
  })

  it('keeps the latest ones when there are many, and counts the rest', () => {
    const facts = Array.from({ length: TEST_FACTS_SHOWN + 5 }, (_, i) => fact(i + 1, i))
    const v = testFactsView([{ ok: false }], facts, 0, 1000)
    expect(v.beforeFailure?.until).toBe(1000)
    expect(v.beforeFailure?.lines).toHaveLength(TEST_FACTS_SHOWN)
    expect(v.beforeFailure?.earlier).toBe(5)
    expect(v.beforeFailure?.lines[TEST_FACTS_SHOWN - 1]).toContain(`fact ${TEST_FACTS_SHOWN + 5}`)
  })
})
