// A project test's flow facts (core/flow/flowFacts.ts), shaped for the in-app Tests overlay the way `npm run test-project`
// prints them: a one-line count by kind for every test, and for a failing one, the facts up to its earliest failing
// check (what the cargo did before the checks went wrong). Facts never fail a test; this only reports them.
//
// Loaded with the runner (projectTestsRun.ts imports it dynamically), so the tracker module stays off the boot path.
import { formatFlowFact, summarizeFlowFacts } from '../../core/flow/flowFacts'
import type { FlowFact } from '../../core/flow/flowFacts'
import type { CheckResult } from '../../core/project/projectTest'

/** How many of the facts before a failure to list: the latest ones, the nearest to it (as the CLI does). */
export const TEST_FACTS_SHOWN = 20

export interface TestFactsView {
  /** "1 dropped, 2 stalled", or "none" */
  summary: string
  total: number
  /** for a failing test: the facts up to its earliest failing check */
  beforeFailure?: {
    /** index of that check in the result's checks */
    check: number
    /** sim time (s) it failed at (the run's duration when the check gives none) */
    until: number
    /** one formatted line per fact, oldest first, at most TEST_FACTS_SHOWN */
    lines: string[]
    /** facts before the failure that were left out (older than the ones listed) */
    earlier: number
  }
}

export function testFactsView(checks: readonly Pick<CheckResult, 'ok' | 'failedAt'>[], facts: readonly FlowFact[], overflow: number, duration: number): TestFactsView {
  const view: TestFactsView = { summary: summarizeFlowFacts(facts, overflow), total: facts.length }
  // the earliest failure in time, not in list order: what the cargo had done by the moment things first went wrong
  let first = -1
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]!
    if (c.ok) continue
    if (first < 0 || (c.failedAt ?? Infinity) < (checks[first]!.failedAt ?? Infinity)) first = i
  }
  if (first < 0) return view
  const until = checks[first]!.failedAt ?? duration
  const before = facts.filter((f) => f.t <= until + 1e-9).sort((a, b) => a.t - b.t || a.id - b.id)
  const shown = before.slice(-TEST_FACTS_SHOWN)
  view.beforeFailure = { check: first, until, lines: shown.map(formatFlowFact), earlier: before.length - shown.length }
  return view
}
