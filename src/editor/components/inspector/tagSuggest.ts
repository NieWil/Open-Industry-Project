// --- What a tag field suggests: the scene's tags, the program's, and the connected PLC's, ranked by what is typed ---
//
// Pure, apart from loadProgramTags, which reaches the PLC engine through a dynamic import: a tag field renders in
// the Inspector, which is in the first frame's graph, and the compiler and the parser behind listTags are not.

import type { TagRow } from '../../../plc/tags'
import type { ProgramCheck, ProgramTag } from '../../program/tagVerdicts'

/**
 * The names that fit `query`, best first, at most `limit` of them, and how many more fit. Nothing typed keeps
 * the list's own order. Otherwise, ignoring case: the name itself, then names whose last segment starts with it
 * (`mot` finds `Sorter.Motor`), then names that start with it, then a last segment that contains it, then any
 * name that contains it; shorter first within each.
 */
export function rankTagNames(query: string, names: readonly string[], limit: number): { shown: string[]; more: number } {
  const q = query.trim().toLowerCase()
  if (q === '') return { shown: names.slice(0, limit), more: Math.max(0, names.length - limit) }
  const scored: { name: string; rank: number }[] = []
  for (const name of names) {
    const n = name.toLowerCase()
    const last = n.slice(n.lastIndexOf('.') + 1).replace(/"/g, '')
    const rank = n === q ? 0 : last.startsWith(q) ? 1 : n.startsWith(q) ? 2 : last.includes(q) ? 3 : n.includes(q) ? 4 : -1
    if (rank >= 0) scored.push({ name, rank })
  }
  scored.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name))
  return { shown: scored.slice(0, limit).map((s) => s.name), more: Math.max(0, scored.length - limit) }
}

/** The types a part's tag can carry a program variable of: one bit or one number. */
const CARRIED = new Set(['BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL', 'BYTE', 'WORD', 'DWORD', 'LWORD'])

/** The program's tags a field may name: of its declared ST type when it has one, else any single bit or number. */
export function programTagChoices(tags: readonly ProgramTag[], stType: string | undefined): ProgramTag[] {
  return tags.filter((c) => (stType ? c.type === stType : CARRIED.has(c.type)))
}

/**
 * Why a program variable would leave a field of direction `dir` unconnected, or null when it would connect. A part
 * reads only what the program drives, and what a part writes reaches only the program's inputs (sim/behaviorBus.ts).
 * So a field the part reads misses a VAR_INPUT, and a variable with no declared direction that a part already writes
 * (the parts make it the program's input). A field the part writes misses a VAR_OUTPUT. `written` is the scene's tags
 * some part writes. The same rule as the field's mark (paramField.tsx TagMark), asked before the pick.
 */
export function tagMisfit(tag: ProgramTag, dir: 'in' | 'out' | undefined, written: ReadonlySet<string>): 'input' | 'written' | 'output' | null {
  if (dir === 'in') return tag.dir === 'in' ? 'input' : tag.dir === undefined && written.has(tag.name) ? 'written' : null
  if (dir === 'out') return tag.dir === 'out' ? 'output' : null
  return null
}

/**
 * What a program that does not compile (as one mid-edit does) still declares for a part to name: controller scope
 * (what wiring binds a part to), not CONSTANT. Declaration order.
 */
export function declaredTags(rows: readonly TagRow[]): ProgramTag[] {
  return rows
    .filter((r) => r.scope.kind === 'controller' && !r.constant)
    .map((r) => {
      const dir = r.section === 'VAR_INPUT' ? 'in' : r.section === 'VAR_OUTPUT' ? 'out' : undefined
      return { name: r.name, type: r.type.trim().toUpperCase(), ...(dir ? { dir } : {}) }
    })
}

let kept: { check: ProgramCheck; tags: Promise<readonly ProgramTag[]> } | null = null

/**
 * Every tag a part can be wired to in the program (program/tagVerdicts.ts programTagNames), loaded on first use. When
 * the program does not compile, what it declares (plc/tags.ts listTags); empty when it does not even read.
 */
export function loadProgramTags(check: ProgramCheck): Promise<readonly ProgramTag[]> {
  if (kept && kept.check === check) return kept.tags
  const tags = (async (): Promise<readonly ProgramTag[]> => {
    const compiled = await (await import('../../program/tagVerdicts')).programTagNames(check)
    return compiled ?? declaredTags(await declaredRows(check.source))
  })().catch(() => [])
  kept = { check, tags }
  return tags
}

async function declaredRows(source: string): Promise<readonly TagRow[]> {
  if (source.trim() === '') return []
  const [{ listTags }, { wrappedPrograms }] = await Promise.all([import('../../../plc/tags'), import('../../../plc/sceneProgram')])
  const rows = listTags(source)
  // a program that is one PROGRAM and nothing else answers to its variables' bare names (plc/link/plcLink.ts
  // soleInstanceAliases), so they are offered as the controller's own tags are
  const wrapped = wrappedPrograms(source)
  if (wrapped.length !== 1) return rows
  const sole = wrapped[0]!.type.toUpperCase()
  return rows.map((r) => (r.scope.kind === 'pou' && r.scope.name.toUpperCase() === sole ? { ...r, scope: { kind: 'controller' as const } } : r))
}
