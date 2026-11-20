// Giving a project's part a new id (docs/parts-shelf.md, "Identity"). Two different parts can share an id: the
// project's own and the shelf's. Neither replaces the other silently, so the project's part moves to a new id and
// the shelf's can then come in beside it. Placed parts name a part by id, so they move with it.

import { packageDependencies } from './partPackage'
import type { PartPackage } from './partPackage'
import type { PartInstance, SceneJSON } from '../types'

/** What a new part id may be: it names the part's folder in a project and on the shelf. */
const PART_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Why `id` cannot be a part's new id, or '' when it can. `taken` says whether a part of that id already exists. */
export function newPartIdProblem(id: string, taken: (id: string) => boolean): string {
  if (!PART_ID.test(id)) return 'An id is letters, digits, dots, dashes and underscores, starting with a letter or digit.'
  if (taken(id)) return `A part with the id “${id}” already exists.`
  return ''
}

/** A free id near `id`: `acme.transfer` gives `acme.transfer-2`, then `-3`, and so on. */
export function freePartId(id: string, taken: (id: string) => boolean): string {
  const stem = id.replace(/-\d+$/, '')
  let n = 2
  while (taken(`${stem}-${n}`)) n++
  return `${stem}-${n}`
}

/** The library parts whose definitions name `id` (held cargo, a unit load's pieces). Their scripts would need to change. */
export function partsNaming(library: readonly PartPackage[], id: string): PartPackage[] {
  return library.filter((p) => p.id !== id && packageDependencies(p).includes(id))
}

function renameInParts(parts: PartInstance[], from: string, to: string): PartInstance[] {
  let changed = false
  const next = parts.map((p) => {
    if (p.type !== 'part' || p.packageId !== from) return p
    changed = true
    return { ...p, packageId: to }
  })
  return changed ? next : parts
}

/** `scene` with every placed copy of part `from`, and any copy of it the scene carries, under `to`. */
export function renamePartInScene(scene: SceneJSON, from: string, to: string): SceneJSON {
  const parts = renameInParts(scene.parts, from, to)
  const carries = scene.packages?.some((p) => p.id === from) === true
  if (parts === scene.parts && !carries) return scene
  return {
    ...scene,
    parts,
    ...(carries ? { packages: scene.packages!.map((p) => (p.id === from ? { ...p, id: to } : p)) } : {}),
  }
}
