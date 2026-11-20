// Which tags a project test reads and which it drives, for the wiring check (scripts/check-wiring.mjs): a tag that
// only a test checks is read, and one only a test's input drives is written, so neither is a dangling wire.

import { isOperand, type TestSpec } from './projectTest'

export interface TestTagUse {
  /** tags a check reads: its `tag`, and a right-hand `{ tag }` operand */
  reads: string[]
  /** tags the test drives: each input's `tag`, and a `commsLoss` fault's `statusTag` */
  writes: string[]
}

const PREDICATES = ['equals', 'notEquals', 'min', 'max', 'near'] as const

/** The tags one spec reads and drives, each once, in first-mention order. */
export function testTagUse(spec: TestSpec): TestTagUse {
  const reads = new Set<string>()
  const writes = new Set<string>()
  for (const c of spec.checks) {
    if (c.tag !== undefined) reads.add(c.tag)
    for (const k of PREDICATES) {
      const v = c[k]
      if (isOperand(v) && 'tag' in v) reads.add(v.tag)
    }
  }
  for (const i of spec.inputs ?? []) writes.add(i.tag)
  for (const f of spec.faults ?? []) if (f.kind === 'commsLoss' && f.statusTag) writes.add(f.statusTag)
  return { reads: [...reads], writes: [...writes] }
}

/** A wiring problem as far as this needs one (plc/wiring.ts WiringProblem; core cannot import plc). */
interface TagProblem {
  kind: string
  tag: string
}

/** A warning the project's tests answer: who in the tests reads (`unread`) or drives (`undriven`) the tag. */
export interface TestCovered<P extends TagProblem> {
  problem: P
  /** labels of the tests that read the tag (for `unread`) or drive it (for `undriven`) */
  by: string[]
}

/**
 * Split wiring problems into those still standing and those the tests answer: an `unread` tag some test checks is
 * read, and an `undriven` tag some test's input drives is written. Tag names match exactly, as the tag bus does.
 * `tests` is each test's label (`tests/sort.test.json`) with its spec.
 */
export function coverByTests<P extends TagProblem>(
  problems: readonly P[],
  tests: readonly { label: string; spec: TestSpec }[],
): { problems: P[]; covered: TestCovered<P>[] } {
  const readBy = new Map<string, string[]>()
  const writtenBy = new Map<string, string[]>()
  const note = (m: Map<string, string[]>, tag: string, label: string) => {
    const list = m.get(tag) ?? []
    if (!list.includes(label)) list.push(label)
    m.set(tag, list)
  }
  for (const { label, spec } of tests) {
    const use = testTagUse(spec)
    for (const t of use.reads) note(readBy, t, label)
    for (const t of use.writes) note(writtenBy, t, label)
  }
  const kept: P[] = []
  const covered: TestCovered<P>[] = []
  for (const p of problems) {
    const by = p.kind === 'unread' ? readBy.get(p.tag) : p.kind === 'undriven' ? writtenBy.get(p.tag) : undefined
    if (by && by.length > 0) covered.push({ problem: p, by })
    else kept.push(p)
  }
  return { problems: kept, covered }
}
