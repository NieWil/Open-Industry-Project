// What an agent's run of edits changed (agentSession.ts keeps the document from before it): parts placed, removed
// and changed, the program, the part library and the kept tests. Read by the review dialog and by get_context, so
// the person and the agent see the same list. A compare of two documents, no React.

import { sameAsBuiltIn } from '../../core/builtInVersion'
import type { PartPackage } from '../../core/parts/partPackage'
import type { TestSpec } from '../../core/project/projectTest'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { EditorStore } from '../store/store'
import type { AgentBaseline } from './agentSession'

export interface PartChangeRow {
  id: string
  /** the part's name, else its package or type */
  label: string
  change: 'added' | 'removed' | 'changed'
  /** for a changed part: which of its fields moved ('position', 'rotationY', 'params.speed', ...) */
  fields?: string[]
}

export interface AgentChanges {
  parts: PartChangeRow[]
  /** the program text, when it changed: the first and last changed line of the new text, and the line counts */
  program: { fromLine: number; toLine: number; linesBefore: number; linesAfter: number } | null
  /** the scan time or task table changed */
  tasks: boolean
  /** the project's own part definitions, matched by id and listed by name */
  library: { added: string[]; removed: string[]; changed: string[] }
  /** kept tests, by name (revert does not take these back: they are not undo steps) */
  tests: { added: string[]; removed: string[]; changed: string[] }
}

export interface AgentDocument {
  scene: SceneJSON
  program: AgentBaseline['program']
  packages: readonly PartPackage[]
  tests: readonly TestSpec[]
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

function partLabel(p: PartInstance): string {
  if (p.name) return p.name
  const pkg = (p as { packageId?: string }).packageId
  return pkg ?? p.type
}

/** the fields of `b` that differ from `a`, a part's params one by one */
function changedFields(a: PartInstance, b: PartInstance): string[] {
  const out: string[] = []
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (key === 'params' && ra.params && rb.params && typeof ra.params === 'object' && typeof rb.params === 'object') {
      const pa = ra.params as Record<string, unknown>
      const pb = rb.params as Record<string, unknown>
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (!same(pa[k], pb[k])) out.push(`params.${k}`)
    } else if (!same(ra[key], rb[key])) out.push(key)
  }
  return out
}

function partChanges(before: SceneJSON, after: SceneJSON): PartChangeRow[] {
  const was = new Map(before.parts.map((p) => [p.id, p]))
  const rows: PartChangeRow[] = []
  for (const p of after.parts) {
    const old = was.get(p.id)
    if (!old) rows.push({ id: p.id, label: partLabel(p), change: 'added' })
    else if (old !== p) {
      const fields = changedFields(old, p)
      if (fields.length > 0) rows.push({ id: p.id, label: partLabel(p), change: 'changed', fields })
    }
    was.delete(p.id)
  }
  for (const p of was.values()) rows.push({ id: p.id, label: partLabel(p), change: 'removed' })
  return rows
}

/** Where two texts differ, as lines of the new one: the span between their common first and last lines. */
function programChange(before: string, after: string): AgentChanges['program'] {
  if (before === after) return null
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return { fromLine: head + 1, toLine: Math.max(head + 1, b.length - tail), linesBefore: a.length, linesAfter: b.length }
}

/** two lists matched by `key`, reported by `label` */
function byKey<T>(before: readonly T[], after: readonly T[], key: (t: T) => string, label: (t: T) => string): { added: string[]; removed: string[]; changed: string[] } {
  const was = new Map(before.map((t) => [key(t), t]))
  const out = { added: [] as string[], removed: [] as string[], changed: [] as string[] }
  for (const t of after) {
    const k = key(t)
    const old = was.get(k)
    if (old === undefined) out.added.push(label(t))
    else if (old !== t && !same(old, t)) out.changed.push(label(t))
    was.delete(k)
  }
  out.removed.push(...[...was.values()].map(label))
  return out
}

export function agentChanges(before: AgentDocument, after: AgentDocument): AgentChanges {
  const testName = (t: TestSpec): string => t.name ?? '(unnamed)'
  return {
    parts: partChanges(before.scene, after.scene),
    program: programChange(before.program.source, after.program.source),
    tasks: before.program.scanMs !== after.program.scanMs || !same(before.program.controller, after.program.controller),
    library: byKey(before.packages, after.packages, (p) => p.id, (p) => p.name || p.id),
    tests: byKey(before.tests, after.tests, testName, testName),
  }
}

/** how many separate things changed, for the one-line notice */
export function changeCount(c: AgentChanges): number {
  const lists = (l: { added: string[]; removed: string[]; changed: string[] }): number => l.added.length + l.removed.length + l.changed.length
  return c.parts.length + (c.program ? 1 : 0) + (c.tasks ? 1 : 0) + lists(c.library) + lists(c.tests)
}

/** The open document in the shape the compare takes. */
export function currentDocument(store: Pick<EditorStore, 'getState' | 'documentScene' | 'snapshotProject'>): AgentDocument {
  const s = store.getState()
  return {
    scene: store.documentScene(),
    program: { source: s.stProgram, scanMs: s.stScanMs, controller: s.controller },
    packages: s.userPackages,
    tests: store.snapshotProject().tests ?? [],
  }
}

/**
 * What the agent's run changed in the open document, as the review shows it. A project's untouched copy of a
 * built-in is left out of the library list: placing a built-in makes one (docs/part-sources.md), and listing it
 * beside the part it was placed for names the same edit twice.
 */
export function reviewChanges(baseline: AgentBaseline, store: Pick<EditorStore, 'getState' | 'documentScene' | 'snapshotProject'>): AgentChanges {
  const bundled = new Map(store.getState().bundledPackages.map((p) => [p.id, p]))
  const authored = (pkgs: readonly PartPackage[]): PartPackage[] => pkgs.filter((p) => !sameAsBuiltIn(p, bundled.get(p.id)))
  const now = currentDocument(store)
  return agentChanges({ ...baseline, packages: authored(baseline.packages) }, { ...now, packages: authored(now.packages) })
}
