// Copying a group of placed parts by an offset (`npm run duplicate-parts`): a second station from the first one, in
// one step instead of one add/snap per part with shifted coordinates and hand-renamed tags.
//
// What a copy carries, and what it does not:
//   - ids are fresh; a part's soft-parented subtree comes along (hierarchy.ts subtreeIds: duplicating acts on the
//     whole subtree, as in the editor);
//   - links inside the group follow the copies: `parent`, and every `partRef` param (a spawner's conveyorId); a link
//     to a part outside the group is kept, as the editor's duplicate keeps it (editor/store/storeCopy.ts);
//   - tag params (`tagRef`) are renamed through an explicit map, or a suffix appended to every tag; a direct address
//     (%IX0.0) takes only the explicit map, since a suffix would make it malformed;
//   - neighbour-derived geometry (guard openings, spur extents, deck clusters, roller grids, leg rests, guard holes,
//     stair cuts) is not stored on a part: core/scene/sceneResolve.ts recomputes all of it from the parts list on every
//     scene change, so the copies get their own from where they stand.
// A copied tag the part writes that another part already writes is a clash (two drivers, and the last write is
// what the tag holds: the wiring check's `contested`), reported for the caller to warn or fail on.

import { subtreeIds } from '../scene/hierarchy'
import { looksLikeAddress } from '../io/iecAddress'
import { partParamSpecs } from '../packageParams'
import type { PartInstance } from '../types'

export interface DuplicateOptions {
  /** world metres added to every copy's position */
  offset: [number, number, number]
  /** old tag -> new tag, applied first */
  rename?: ReadonlyMap<string, string>
  /** appended to every other (non-empty, non-address) tag of the copies */
  tagSuffix?: string
  /** appended to each copied id; without it a copy is `<id>-2` (or the next free number) */
  idSuffix?: string
}

export interface TagUse {
  partId: string
  key: string
  tag: string
  dir?: 'in' | 'out'
}

export interface DuplicateResult {
  /** the copies, in scene order, ready to append */
  copies: PartInstance[]
  /** original id -> copy id */
  idMap: Map<string, string>
  /** every tag param of the copies, after renaming, with the tag it was copied from */
  tags: (TagUse & { from: string })[]
  /** a copy writes a tag some other part (an original, or another copy) already writes */
  clashes: { copy: TagUse; writers: TagUse[] }[]
  /** a copy reads a tag it kept unchanged, so it follows the same signal as its original (often meant: a shared run) */
  shared: TagUse[]
  /** problems with the request that did not stop it (a rename that matched no tag) */
  warnings: string[]
  /** ids pulled in because an asked-for part is their soft parent */
  addedChildren: string[]
}

/** `Old=New,...` into a map; throws on a piece without `=` or an empty side. */
export function parseRenameMap(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const piece of text.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const eq = piece.indexOf('=')
    const from = eq > 0 ? piece.slice(0, eq).trim() : ''
    const to = eq > 0 ? piece.slice(eq + 1).trim() : ''
    if (!from || !to) throw new Error(`--rename: "${piece}" is not Old=New`)
    if (out.has(from) && out.get(from) !== to) throw new Error(`--rename: ${from} is renamed twice`)
    out.set(from, to)
  }
  return out
}

/** every non-empty tag param of `part`, with its declared direction */
export function tagUses(part: PartInstance): TagUse[] {
  const params = part.params as Record<string, unknown>
  const out: TagUse[] = []
  for (const spec of partParamSpecs(part)) {
    if (spec.kind !== 'tagRef') continue
    const v = params[spec.key]
    if (typeof v === 'string' && v !== '') out.push({ partId: part.id, key: spec.key, tag: v, dir: spec.dir })
  }
  return out
}

const nextName = (used: Set<string>, name: string): string => {
  const m = /^(.*?)(?:\s+(\d+))?$/.exec(name)
  const stem = m?.[1] ?? name
  let n = m?.[2] ? Number(m[2]) + 1 : 2
  while (used.has(`${stem} ${n}`)) n++
  return `${stem} ${n}`
}

/**
 * Copies of `ids` (plus their subtrees) out of `parts`, by `opts.offset`. Throws an Error for an unknown id, or an
 * `idSuffix` id that is taken. Does not touch `parts`.
 */
export function duplicateParts(parts: readonly PartInstance[], ids: readonly string[], opts: DuplicateOptions): DuplicateResult {
  const known = new Set(parts.map((p) => p.id))
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length > 0) throw Object.assign(new Error(`no part ${unknown.map((id) => `"${id}"`).join(', ')} in the scene`), { unknownIds: unknown })
  const group = subtreeIds(parts, ids)
  const asked = new Set(ids)
  const addedChildren = group.filter((id) => !asked.has(id))
  const source = parts.filter((p) => group.includes(p.id))

  const taken = new Set(known)
  const idMap = new Map<string, string>()
  for (const p of source) {
    let id: string
    if (opts.idSuffix !== undefined) {
      id = `${p.id}${opts.idSuffix}`
      if (taken.has(id)) throw new Error(`--id-suffix: "${id}" (the copy of ${p.id}) is already a part's id`)
    } else {
      let n = 2
      while (taken.has(`${p.id}-${n}`)) n++
      id = `${p.id}-${n}`
    }
    taken.add(id)
    idMap.set(p.id, id)
  }

  const usedNames = new Set<string>()
  for (const p of parts) if (p.name) usedNames.add(p.name)
  const rename = opts.rename ?? new Map<string, string>()
  const renamedUsed = new Set<string>()
  const [dx, dy, dz] = opts.offset
  const copies: PartInstance[] = []
  const tags: DuplicateResult['tags'] = []
  for (const p of source) {
    const copy = { ...p, id: idMap.get(p.id)!, position: [p.position[0] + dx, p.position[1] + dy, p.position[2] + dz], params: { ...p.params } } as PartInstance
    if (copy.name) {
      copy.name = nextName(usedNames, copy.name)
      usedNames.add(copy.name)
    }
    if (copy.parent !== undefined && idMap.has(copy.parent)) copy.parent = idMap.get(copy.parent)
    const params = copy.params as Record<string, unknown>
    for (const spec of partParamSpecs(copy)) {
      const v = params[spec.key]
      if (typeof v !== 'string' || v === '') continue
      if (spec.kind === 'partRef') {
        const mapped = idMap.get(v)
        if (mapped !== undefined) params[spec.key] = mapped
      } else if (spec.kind === 'tagRef') {
        let next = v
        if (rename.has(v)) {
          next = rename.get(v)!
          renamedUsed.add(v)
        } else if (opts.tagSuffix && !looksLikeAddress(v)) next = `${v}${opts.tagSuffix}`
        params[spec.key] = next
        tags.push({ partId: copy.id, key: spec.key, tag: next, dir: spec.dir, from: v })
      }
    }
    copies.push(copy)
  }

  const warnings: string[] = []
  for (const from of rename.keys()) {
    if (!renamedUsed.has(from)) warnings.push(`--rename ${from}=${rename.get(from)}: no copied part has a tag "${from}"`)
  }

  // writers already in the scene, then each copy's writes in turn (two copies writing one tag clash too)
  const writers = new Map<string, TagUse[]>()
  const addWriter = (u: TagUse): void => {
    const list = writers.get(u.tag)
    if (list) list.push(u)
    else writers.set(u.tag, [u])
  }
  for (const p of parts) for (const u of tagUses(p)) if (u.dir === 'out') addWriter(u)
  const clashes: DuplicateResult['clashes'] = []
  const shared: TagUse[] = []
  for (const t of tags) {
    const use: TagUse = { partId: t.partId, key: t.key, tag: t.tag, dir: t.dir }
    if (t.dir === 'out') {
      const already = writers.get(t.tag)
      if (already?.length) clashes.push({ copy: use, writers: [...already] })
      addWriter(use)
    } else if (t.tag === t.from) shared.push(use)
  }
  return { copies, idMap, tags, clashes, shared, warnings, addedChildren }
}
