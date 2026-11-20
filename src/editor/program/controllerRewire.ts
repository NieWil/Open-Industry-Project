// Rewiring a scene after a controller edit renames program tags (plc/controllerEdits.ts).
//
// A program instance's variables are its tags, `Instance.Name`, and a part is wired to one by writing
// that name into a tag parameter. So splitting a program into tasks (`Motor` becomes `Main.Motor`) or
// renaming an instance (`Main.Motor` becomes `Line1.Motor`) would leave every wired part talking to a
// tag that no longer exists: the line stops, and nothing in the scene says why. This follows the rename
// through the scene, as one commit, so Ctrl+Z puts the wiring back in a single step.
//
// What it touches: a part's tag parameters (the package's `tagRef` specs) and an annotation's displayed
// tag, when the value is exactly the old name.

import { packageParamSpecs } from '../../core/packageParams'
import { getPackage } from '../../core/parts/partRegistry'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { TagRename } from '../../plc/controllerEdits'

/** The tag parameter keys of a part: its package's `tagRef` params, or an annotation's `tag`. */
function tagKeys(part: PartInstance): string[] {
  if (part.type === 'annotation') return ['tag']
  if (part.type !== 'part') return []
  const pkg = getPackage((part as { packageId?: string }).packageId ?? '')
  return pkg ? packageParamSpecs(pkg).filter((s) => s.kind === 'tagRef').map((s) => s.key) : []
}

/**
 * The scene with every tag parameter that named a renamed tag pointed at its new name, and the ids of the
 * parts that changed. Null when no part was wired to any of them, so there is nothing to commit.
 */
export function rewireTags(scene: SceneJSON, renames: readonly TagRename[]): { scene: SceneJSON; parts: string[] } | null {
  if (renames.length === 0) return null
  const to = new Map(renames.map((r) => [r.from, r.to]))
  const changed: string[] = []
  const parts = scene.parts.map((part) => {
    const params = (part as { params?: Record<string, unknown> }).params
    if (!params) return part
    let next: Record<string, unknown> | null = null
    for (const key of tagKeys(part)) {
      const v = params[key]
      if (typeof v !== 'string') continue
      const renamed = to.get(v)
      if (renamed === undefined) continue
      next ??= { ...params }
      next[key] = renamed
    }
    if (!next) return part
    changed.push(part.id)
    return { ...part, params: next } as PartInstance
  })
  return changed.length > 0 ? { scene: { ...scene, parts }, parts: changed } : null
}
