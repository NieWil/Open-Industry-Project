import * as Y from 'yjs'
import type { PartInstance, SceneJSON } from '../core/types'
import { makePartMap, orderArray, paramEntries, partScalars, partsMap, writeDisplay, writePlcs, writeUnits } from './schema'

/**
 * Translate a local scene change (prev -> next) into minimal Yjs ops. Called by the bridge
 * inside `ydoc.transact(..., LOCAL_ORIGIN)`.
 *
 * Cheap because the EditorStore is immutable: an unchanged part keeps the same object
 * reference across commits (the mutators rebuild with `... ?? p`), so a `before === after`
 * identity check skips it in O(1); only the genuinely-touched parts get deep-diffed.
 */
export function applySceneDiff(ydoc: Y.Doc, prev: SceneJSON, next: SceneJSON): void {
  const parts = partsMap(ydoc)
  const order = orderArray(ydoc)
  // the scene's Units, Length, controllers and display list ride in `meta` (schema.ts UNITS_META, LENGTH_UNIT_META,
  // PLCS_META, DISPLAY_META)
  if (prev.units !== next.units || prev.lengthUnit !== next.lengthUnit) writeUnits(ydoc, next)
  if (prev.plcs !== next.plcs) writePlcs(ydoc, next.plcs)
  if (prev.display !== next.display) writeDisplay(ydoc, next.display)
  const prevById = new Map(prev.parts.map((p) => [p.id, p]))
  const nextById = new Map(next.parts.map((p) => [p.id, p]))

  // removed parts
  prevById.forEach((_p, id) => {
    if (!nextById.has(id)) parts.delete(id)
  })

  // added or changed parts
  for (const p of next.parts) {
    const before = prevById.get(p.id)
    if (before === undefined) {
      parts.set(p.id, makePartMap(p))
      continue
    }
    if (before === p) continue // identity unchanged -> nothing to diff
    const m = parts.get(p.id)
    if (!(m instanceof Y.Map)) {
      parts.set(p.id, makePartMap(p))
      continue
    }
    updatePartMap(m, before, p)
  }

  // order: rewrite only when it actually changed (the array is small)
  const nextOrder = next.parts.map((p) => p.id)
  if (!sameOrder(order.toArray(), nextOrder)) {
    order.delete(0, order.length)
    order.insert(0, nextOrder)
  }
}

/** apply only the changed scalar fields + changed params of one part */
function updatePartMap(m: Y.Map<unknown>, before: PartInstance, after: PartInstance): void {
  const a = partScalars(before)
  const b = partScalars(after)
  for (const k of Object.keys(b)) if (m.get(k) !== b[k]) m.set(k, b[k])
  for (const k of Object.keys(a)) if (!(k in b)) m.delete(k)

  const yp = m.get('params')
  if (!(yp instanceof Y.Map)) {
    m.set('params', buildParams(after))
    return
  }
  const pb = new Map(paramEntries(after))
  const pa = new Map(paramEntries(before))
  pb.forEach((v, k) => {
    if (!sameParam(yp.get(k), v)) yp.set(k, v)
  })
  pa.forEach((_v, k) => {
    if (!pb.has(k)) yp.delete(k)
  })
}

/**
 * Is the doc's stored param value already what we'd write? Built-in list params are JSON-string
 * atoms, so identity settles them; an SDK part's numberList is stored as a real array and copied
 * on every read/write (see sdkParamValue), so identity alone would rewrite it on every commit:
 * a doc op and a full remote rebuild per unrelated drag.
 */
function sameParam(stored: unknown, next: unknown): boolean {
  if (stored === next) return true
  if (!Array.isArray(stored) || !Array.isArray(next) || stored.length !== next.length) return false
  return stored.every((row, i) => {
    const other = next[i]
    if (Array.isArray(row) && Array.isArray(other))
      return row.length === other.length && row.every((n, j) => n === other[j])
    return row === other
  })
}

function buildParams(part: PartInstance): Y.Map<unknown> {
  const yp = new Y.Map<unknown>()
  for (const [k, v] of paramEntries(part)) yp.set(k, v)
  return yp
}

function sameOrder(a: readonly unknown[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
