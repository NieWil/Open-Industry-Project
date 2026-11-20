// --- the pure half of the program editor (ParamSpec.program) and of named table rows (ParamSpec.rowNames) ---
//
// A program param is one numberList, rows `[program, op, ...args]`, steps in row order within their program. Every
// edit here returns the whole next table, normalized: grouped by program ascending, each program's steps in order.
// Removing a row of a table other params point at (a robot deleting a waypoint its jobs move to) is the edit with
// real consequences, so it lives here too: `removeTableRow` returns the patch that keeps every pointer valid.

import type { ProgramArg, ProgramOp, ProgramSpec } from '../../../core/parts/partApi'
import type { ParamSpec, ParamValue } from '../../../core/types'

/** names stored one per line; a missing line reads as '' */
export const splitNames = (v: unknown): string[] => (typeof v === 'string' && v !== '' ? v.split('\n') : [])
export const joinNames = (names: readonly string[]): string => {
  // trailing blanks carry nothing, so they are not stored (an all-unnamed table stays '')
  let end = names.length
  while (end > 0 && names[end - 1] === '') end--
  return names.slice(0, end).join('\n')
}

/** one program as the editor shows it: its index, and its steps with the table row each one is */
export interface ProgramView {
  index: number
  steps: { row: number; values: number[] }[]
}

/** how many programs there are: every one a step belongs to, and every one that has a name */
export function programCount(rows: readonly number[][], names: readonly string[]): number {
  let n = names.length
  for (const r of rows) if (Number.isInteger(r[0]) && r[0]! >= 0) n = Math.max(n, r[0]! + 1)
  return n
}

export function programViews(rows: readonly number[][], names: readonly string[]): ProgramView[] {
  const out: ProgramView[] = Array.from({ length: programCount(rows, names) }, (_, index) => ({ index, steps: [] }))
  rows.forEach((values, row) => {
    const p = values[0]
    if (Number.isInteger(p) && p! >= 0) out[p!]!.steps.push({ row, values: [...values] })
  })
  return out
}

/** the table in its one order: programs ascending, each program's steps as they were */
function normalize(rows: readonly number[][]): number[][] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r[0]! - b.r[0]!) || a.i - b.i)
    .map(({ r }) => [...r])
}

export const opOf = (spec: ProgramSpec, code: number): ProgramOp | undefined => spec.ops.find((o) => o.code === code)

function argDefault(a: ProgramArg): number {
  if (a.kind === 'row') return 0
  if (a.kind === 'number') return a.default ?? a.min ?? 0
  return a.default ?? a.options[0]?.value ?? 0
}

/** a fresh step of `op` for program `p`, padded to the table's width */
export function newStep(spec: ProgramSpec, arity: number, p: number, code: number): number[] {
  const op = opOf(spec, code)
  const args = (op?.args ?? []).map(argDefault)
  return [p, code, ...args, ...Array.from({ length: Math.max(0, arity - 2 - args.length) }, () => 0)].slice(0, arity)
}

/** the step at `row` switched to another op: the arguments the two share by position and kind are kept */
export function changeOp(spec: ProgramSpec, rows: readonly number[][], row: number, code: number, arity: number): number[][] {
  const old = rows[row]
  if (!old) return rows.map((r) => [...r])
  const from = opOf(spec, old[1]!)
  const next = newStep(spec, arity, old[0]!, code)
  const to = opOf(spec, code)
  ;(to?.args ?? []).forEach((a, j) => {
    const b = from?.args?.[j]
    if (b && b.kind === a.kind && (a.kind !== 'row' || (b.kind === 'row' && b.of === a.of))) next[2 + j] = old[2 + j]!
  })
  return rows.map((r, i) => (i === row ? next : [...r]))
}

export function setArg(rows: readonly number[][], row: number, arg: number, value: number): number[][] {
  return rows.map((r, i) => (i === row ? r.map((n, c) => (c === 2 + arg ? value : n)) : [...r]))
}

export function addStep(spec: ProgramSpec, rows: readonly number[][], p: number, arity: number, code = spec.ops[0]!.code): number[][] {
  return normalize([...rows, newStep(spec, arity, p, code)])
}

export function removeStep(rows: readonly number[][], row: number): number[][] {
  return rows.filter((_, i) => i !== row).map((r) => [...r])
}

/** a copy of the step at `row`, right after it */
export function duplicateStep(rows: readonly number[][], row: number): number[][] {
  const out = rows.map((r) => [...r])
  if (rows[row]) out.splice(row + 1, 0, [...rows[row]!])
  return out
}

/** the step at `row` swapped with its neighbour in the same program (-1 = up, 1 = down); a no-op at either end */
export function moveStep(rows: readonly number[][], row: number, dir: -1 | 1): number[][] {
  const out = rows.map((r) => [...r])
  const p = rows[row]?.[0]
  let j = row + dir
  while (j >= 0 && j < rows.length && rows[j]![0] !== p) j += dir
  if (p === undefined || j < 0 || j >= rows.length) return out
  ;[out[row], out[j]] = [out[j]!, out[row]!]
  return out
}

/** a new, empty program at the end, named (programs with no steps exist through their name) */
export function addProgram(rows: readonly number[][], names: readonly string[], name: string): { rows: number[][]; names: string[] } {
  const n = programCount(rows, names)
  const next = [...names]
  while (next.length < n) next.push('')
  next.push(name)
  return { rows: rows.map((r) => [...r]), names: next }
}

/** program `p` and its steps gone; every later program moves up one */
export function removeProgram(rows: readonly number[][], names: readonly string[], p: number): { rows: number[][]; names: string[] } {
  return {
    rows: rows.filter((r) => r[0] !== p).map((r) => (r[0]! > p ? [r[0]! - 1, ...r.slice(1)] : [...r])),
    names: names.filter((_, i) => i !== p),
  }
}

/** a copy of program `p`, steps and all, added at the end */
export function duplicateProgram(rows: readonly number[][], names: readonly string[], p: number, name: string): { rows: number[][]; names: string[] } {
  const n = programCount(rows, names)
  const copy = rows.filter((r) => r[0] === p).map((r) => [n, ...r.slice(1)])
  const next = [...names]
  while (next.length < n) next.push('')
  next.push(name)
  return { rows: normalize([...rows, ...copy]), names: next }
}

/** a name no other entry has: `base`, else `base 2`, `base 3` ... */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`
}

/**
 * Every param that points at the rows of table `key`, re-pointed after its rows were renumbered by `shift` (old
 * index to new, -1 = the row is gone): a `rowsOf` set drops a gone row and stays ascending, and a program step's
 * `row` argument on this table follows its row, or becomes -1 (missing). Never re-pointed at a neighbour: a step
 * that moved to "Pick" must not quietly start moving to "Place".
 */
function repointed(specs: readonly ParamSpec[], current: (k: string) => number[][], key: string, shift: (i: number) => number): Record<string, ParamValue> {
  const patch: Record<string, ParamValue> = {}
  for (const s of specs) {
    if (s.kind !== 'numberList' || s.key === key) continue
    if (s.rowsOf === key) {
      patch[s.key] = current(s.key)
        .map((r) => shift(r[0]!))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)
        .map((i) => [i])
    }
    const program = s.program
    if (program) {
      const cols = (code: number): number[] =>
        (opOf(program, code)?.args ?? []).flatMap((a, j) => (a.kind === 'row' && a.of === key ? [2 + j] : []))
      patch[s.key] = current(s.key).map((r) => {
        const refs = cols(r[1]!)
        return refs.length ? r.map((n, c) => (refs.includes(c) && n >= 0 ? shift(n) : n)) : [...r]
      })
    }
  }
  return patch
}

/** a numberList param's rows as stored, else its default */
const rowsReader = (specs: readonly ParamSpec[], params: Readonly<Record<string, unknown>>) => (k: string): number[][] => {
  const v = params[k]
  if (Array.isArray(v)) return v as number[][]
  const s = specs.find((x) => x.key === k)
  return s?.kind === 'numberList' ? s.default : []
}

/** the row names of table `key`, when it has them: the param that holds them, and one name per row */
function tableNames(specs: readonly ParamSpec[], params: Readonly<Record<string, unknown>>, key: string): { param: string; names: string[] } | null {
  const table = specs.find((s) => s.key === key)
  if (table?.kind !== 'numberList' || !table.rowNames) return null
  return { param: table.rowNames, names: splitNames(params[table.rowNames] ?? specs.find((s) => s.key === table.rowNames)?.default) }
}

/**
 * Removing row `index` of table `key`, and everything that points at it kept valid, as one patch: the table's row
 * names lose that line, and the params that point at its rows are renumbered (`repointed`).
 */
export function removeTableRow(specs: readonly ParamSpec[], params: Readonly<Record<string, unknown>>, key: string, index: number): Record<string, ParamValue> {
  const current = rowsReader(specs, params)
  const patch: Record<string, ParamValue> = { [key]: current(key).filter((_, i) => i !== index).map((r) => [...r]) }
  const named = tableNames(specs, params, key)
  if (named) patch[named.param] = joinNames(named.names.filter((_, i) => i !== index))
  return { ...patch, ...repointed(specs, current, key, (i) => (i === index ? -1 : i > index ? i - 1 : i)) }
}

/**
 * Row `index` of table `key` swapped with its neighbour (-1 = up, 1 = down), as one patch: the two rows' names
 * swap with them, and everything that points at either row follows it. Null at either end of the table.
 */
export function moveTableRow(specs: readonly ParamSpec[], params: Readonly<Record<string, unknown>>, key: string, index: number, dir: -1 | 1): Record<string, ParamValue> | null {
  const current = rowsReader(specs, params)
  const rows = current(key)
  const other = index + dir
  if (index < 0 || other < 0 || index >= rows.length || other >= rows.length) return null
  const swap = (i: number): number => (i === index ? other : i === other ? index : i)
  const patch: Record<string, ParamValue> = { [key]: rows.map((_, i) => [...rows[swap(i)]!]) }
  const named = tableNames(specs, params, key)
  if (named) patch[named.param] = joinNames(rows.map((_, i) => named.names[swap(i)] ?? ''))
  return { ...patch, ...repointed(specs, current, key, swap) }
}
