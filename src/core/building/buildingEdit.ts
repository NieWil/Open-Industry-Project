// Changing a building without the editor (`npm run edit-part`, `npm run add-part -- <folder> building`, the agent's
// update_part): its params checked against the building's declared params (STRUCTURE_DEFS) the way a package part's
// are (partParamArgs.ts), and its open dock doors checked against the doors its wall rules cut. `dockDoors` lists
// those doors with their keys and positions, so a caller can name one without working out the perimeter order.

import { paramArgValue, type ParamArgs } from '../parts/partParamArgs'
import type { ParamChange } from '../parts/partEdit'
import { toWorldXZ } from '../parts/partGeometry'
import { STRUCTURE_DEFS } from '../types'
import type { BuildingParams, BuildingPart } from '../types'
import { dockOpenings } from './buildingDocks'

const SPECS = STRUCTURE_DEFS.building.params
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const r3 = (n: number): number => Math.round(n * 1000) / 1000

export type WallSide = 'front' | 'back' | 'left' | 'right'

/** the perimeter cells each wall holds, in the order a wall rule's `start` counts them; `facing` is building-local */
export function perimeterSides(L: number, W: number): { side: WallSide; facing: string; first: number; last: number }[] {
  return [
    { side: 'front', facing: '-z', first: 0, last: L - 1 },
    { side: 'back', facing: '+z', first: L, last: 2 * L - 1 },
    { side: 'left', facing: '-x', first: 2 * L, last: 2 * L + W - 1 },
    { side: 'right', facing: '+x', first: 2 * L + W, last: 2 * L + 2 * W - 1 },
  ]
}

export interface DockDoor {
  /** what `openDoors` names: `<perimeter cell>:<opening>` */
  key: string
  side: WallSide
  /** the opening's centre on the wall line, world metres */
  x: number
  z: number
  open: boolean
}

/** every dock door the building's wall rules cut, open or shut, in perimeter order */
export function dockDoors(part: BuildingPart): DockDoor[] {
  const sides = perimeterSides(part.params.lengthSections, part.params.widthSections)
  const open = new Set(part.params.openDoors ?? [])
  return dockOpenings(part).map((o) => {
    const cell = Number(o.key.split(':')[0])
    const w = toWorldXZ(part, o.x, o.z)
    return { key: o.key, side: sides.find((s) => cell >= s.first && cell <= s.last)!.side, x: r3(w.x), z: r3(w.z), open: open.has(o.key) }
  })
}

/** `openDoors` as given: a list of keys, or one comma-joined string ('' or [] = every door shut) */
function doorKeysArg(value: unknown): string[] {
  const keys = typeof value === 'string' ? value.split(',') : Array.isArray(value) && value.every((k) => typeof k === 'string') ? (value as string[]) : null
  if (keys === null) throw new Error(`params: openDoors=${JSON.stringify(value)} does not fit: openDoors is a list of dock door keys, e.g. openDoors=18:0,18:1 ('' = all shut)`)
  return [...new Set(keys.map((k) => k.trim()).filter((k) => k !== ''))]
}

/**
 * `part`'s params with `args` applied, and what changed. Throws an Error naming the bad piece: an unknown key, a value
 * that does not fit its param, or an open door the rules do not cut. Open doors the new rules or size no longer cut are
 * dropped, and a rule whose `start` is past the last perimeter cell (it wraps) is noted; both go onto `notes`.
 */
export function editBuildingParams(part: BuildingPart, args: ParamArgs, notes: string[] = []): { params: BuildingParams; changes: ParamChange[] } {
  const defaults = new Map(SPECS.map((s) => [s.key, s.default as unknown]))
  const base = { ...Object.fromEntries(defaults), ...part.params } as BuildingParams
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(args)) {
    if (key === 'openDoors') continue
    const spec = SPECS.find((s) => s.key === key)
    if (!spec) throw new Error(`params: a building has no param "${key}" (it has: ${[...SPECS.map((s) => s.key), 'openDoors'].join(', ')})`)
    next[key] = paramArgValue(spec, value)
  }
  const shaped = { ...part, params: next as unknown as BuildingParams }
  const cut = new Set(dockOpenings(shaped).map((o) => o.key))
  if ('openDoors' in args) {
    const keys = doorKeysArg(args.openDoors)
    const missing = keys.filter((k) => !cut.has(k))
    if (missing.length > 0) {
      throw new Error(`params: openDoors names ${missing.join(', ')}, which the wall rules do not cut (the dock doors are: ${[...cut].join(', ') || 'none'}; edit-part --docks lists them)`)
    }
    next.openDoors = keys
  } else {
    const kept = (base.openDoors ?? []).filter((k) => cut.has(k))
    const dropped = (base.openDoors ?? []).filter((k) => !cut.has(k))
    if (dropped.length > 0) notes.push(`openDoors: ${dropped.join(', ')} dropped, since the wall rules no longer cut ${dropped.length === 1 ? 'that door' : 'those doors'}`)
    next.openDoors = kept
  }
  if ((next.openDoors as string[]).length === 0) delete next.openDoors
  if ('rules' in args || 'lengthSections' in args || 'widthSections' in args) {
    const perimeter = 2 * (next.lengthSections as number) + 2 * (next.widthSections as number)
    ;(next.rules as BuildingParams['rules']).forEach((r, i) => {
      if (r.start >= perimeter) notes.push(`rules[${i}].start ${r.start} is past the last perimeter cell (${perimeter - 1}), so it wraps to ${r.start % perimeter}`)
    })
  }
  const changes: ParamChange[] = []
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const from = (base as unknown as Record<string, unknown>)[key]
    const to = next[key]
    // an absent openDoors is every door shut, the same as []
    if (key === 'openDoors' ? same(from ?? [], to ?? []) : same(from, to)) continue
    changes.push({ key, from, to, isDefault: key === 'openDoors' ? to === undefined : defaults.has(key) && same(to, defaults.get(key)) })
  }
  return { params: next as unknown as BuildingParams, changes }
}
