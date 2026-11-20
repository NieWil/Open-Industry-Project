import type { PartInstance, SceneJSON } from '../core/types'
import type { PartPackage } from '../core/parts/partPackage'

/** An ordinary live edit expressed against the scene the worker already holds (protocol 'updatePatch'). */
export interface ScenePatch {
  changes: [index: number, part: PartInstance][]
  packages?: PartPackage[]
}

/**
 * The patch that turns `prev` into `next`, or null when only a whole scene will do. Store edits are immutable,
 * so an untouched part keeps its object across commits and identity is the change test: a drag or an
 * Inspector scrub changes one or a few parts of hundreds. A patch needs the part list's ids and order
 * unchanged; an add, a delete or a reorder sends the scene (those are one-off, not per pointer move).
 */
export function scenePatch(prev: SceneJSON, next: SceneJSON): ScenePatch | null {
  if (prev.version !== next.version) return null
  const a = prev.parts
  const b = next.parts
  if (a.length !== b.length) return null
  const changes: [number, PartInstance][] = []
  for (let i = 0; i < b.length; i++) {
    if (a[i] === b[i]) continue
    if (a[i]!.id !== b[i]!.id) return null
    changes.push([i, b[i]!])
  }
  const patch: ScenePatch = { changes }
  if (!samePackages(prev.packages, next.packages)) patch.packages = next.packages ?? []
  return patch
}

/** `base` with `patch` applied - a fresh scene, sharing every untouched part object with `base`. */
export function applyScenePatch(base: SceneJSON, patch: ScenePatch): SceneJSON {
  const parts = base.parts.slice()
  for (const [i, part] of patch.changes) parts[i] = part
  const packages = patch.packages ?? base.packages
  return packages ? { ...base, parts, packages } : { version: base.version, parts }
}

function samePackages(a: readonly PartPackage[] | undefined, b: readonly PartPackage[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return (a?.length ?? 0) === 0 && (b?.length ?? 0) === 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
