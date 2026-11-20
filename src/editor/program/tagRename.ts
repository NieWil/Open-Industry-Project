// A tag renamed with the wiring that names it, as one plan over the program and the scene: what the agent door's
// rename_tag commits and scripts/rename-tag.mjs writes into a project folder. The PLC panel's rename
// (plcPanelParts.tsx renameDeclaration) makes the same three calls; it loads plc/tags.ts lazily, so it does not
// import this module.

import type { Controller } from '../../core/controller'
import type { SceneJSON } from '../../core/types'
import { controllerFor } from '../../plc/controller'
import { renameTag, scopeOfPou, tagNameError, tagRenamesForScene } from '../../plc/tags'
import { rewireTags } from './controllerRewire'

export type TagRenamePlan =
  | { error: string }
  | {
      error: null
      source: string
      /** null when no part was wired to the tag */
      scene: SceneJSON | null
      /** the ids of the parts rewired */
      parts: string[]
      /** the scene's names for the tag before the rename (`Run`, or `Main.Run` for each instance) */
      oldNames: string[]
    }

/**
 * Rename tag `from` to `to` in `source`, and point every part wired to it at the new name. `pou` is the PROGRAM,
 * FUNCTION_BLOCK or FUNCTION that declares the tag, or '' for a top-level (controller) tag. `controller` is the
 * stored task table (null for a program with none), `scanMs` its scan time. A refused rename comes back with the
 * reason and changes nothing.
 */
export function planTagRename(scene: SceneJSON, source: string, controller: Controller | null, scanMs: number, pou: string, from: string, to: string): TagRenamePlan {
  const scope = scopeOfPou(pou)
  const name = to.trim()
  const bad = tagNameError(source, scope, name)
  if (bad !== null) return { error: bad }
  const edit = renameTag(source, scope, from, name)
  if (edit.error !== null) return { error: edit.error }
  const renames = tagRenamesForScene(source, scope, from, name, controllerFor(source, controller, scanMs))
  const rewired = rewireTags(scene, renames)
  return { error: null, source: edit.source, scene: rewired?.scene ?? null, parts: rewired?.parts ?? [], oldNames: renames.map((r) => r.from) }
}

/**
 * The kept tests that still name a renamed tag, by name: a rename moves the code and the wiring, not the tests, and a
 * test naming the old tag fails with `tag "X" never appeared`. Any string in a spec equal to one of the scene's old
 * names counts (the test's own name aside).
 */
export function testsNamingTag(tests: readonly { name?: string }[], oldNames: readonly string[]): string[] {
  const names = new Set(oldNames)
  const mentions = (v: unknown): boolean =>
    typeof v === 'string' ? names.has(v) : Array.isArray(v) ? v.some(mentions) : typeof v === 'object' && v !== null ? Object.values(v).some(mentions) : false
  return tests.flatMap((t, i) => {
    const { name, ...spec } = t
    return mentions(spec) ? [name ?? `test ${i + 1}`] : []
  })
}
