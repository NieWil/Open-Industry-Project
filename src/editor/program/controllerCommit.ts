// The controller edits the PLC panel's organizer makes: its tasks and program instances, "+ Program", and a PROGRAM
// renamed in the tree, whose instances follow it. Nothing here goes through a CodeMirror, which may not be mounted yet
// (the editor is a lazy chunk): every edit commits through the store (store.commitProgram: one undo step solo, one
// transaction in a room), and a mounted code editor catches up on its own (store.onStProgramEdit).

import type { Controller } from '../../core/controller'
import { addProgram, blockNameError, defaultController, defaultInterval, parseDocument, renameBlock, renameProgramType, type TagRename } from '../../plc'
import type { StFileReportData } from '../components/plc/StFileReport'
import { rewireTags } from './controllerRewire'
import type { EditorStore } from '../store/store'

/** What an edit has to tell the panel that made it; the panel stamps the id that resets the checklist. */
export type ControllerReport = Omit<StFileReportData, 'id'>

/**
 * Apply a controller edit: the table, the program's code, and the scene's wiring when tags were renamed, as
 * one undo step (store.commitProgram), so no Ctrl+Z takes back the table and leaves the code or the wiring. For a
 * program with no table of its own, a table that is still the default one (retimed, or following a renamed PROGRAM) is
 * its scan time and nothing more, so no table is stored. `source` is the code the edit starts from when the caller has
 * already changed it; by default, the program as the store holds it.
 *
 * Returns a report of the renamed tags, because that is the part of the edit nobody can see; null when none were.
 */
export function commitControllerEdit(store: EditorStore, next: Controller, renames: TagRename[], label: string, source?: string): ControllerReport | null {
  const state = store.getState()
  const text = source ?? state.stProgram
  const rewired = renames.length > 0 ? rewireTags(state.scene, renames) : null
  const retimed = state.controller ? null : defaultInterval(text, next)
  store.commitProgram(label, retimed !== null ? { source: text, scanMs: retimed } : { source: text, controller: next }, rewired ? { scene: rewired.scene } : undefined)
  return renameReport(label, renames, rewired)
}

/**
 * A tag renamed in the code (`source` already has it, plc/tags.ts `renameTag`): the scene's wiring follows it, as one
 * undo step: the commit a renamed PROGRAM makes (above), with the table untouched.
 * `renames` are the scene's names for the tag (plc/tags.ts `tagRenamesForScene`). Returns the receipt, as above.
 */
export function commitTagRename(store: EditorStore, source: string, renames: TagRename[], label: string): ControllerReport | null {
  const state = store.getState()
  const rewired = renames.length > 0 ? rewireTags(state.scene, renames) : null
  store.commitProgram(label, { source }, rewired ? { scene: rewired.scene } : undefined)
  return rewired ? renameReport(label, renames, rewired) : null
}

function renameReport(label: string, renames: TagRename[], rewired: { parts: string[] } | null): ControllerReport | null {
  if (renames.length === 0) return null
  const shown = renames.slice(0, 12).map((r) => `${r.from} is now ${r.to}`)
  return {
    headline: label,
    detail: `${renames.length} tag${renames.length === 1 ? '' : 's'} renamed${rewired ? `, and ${rewired.parts.length} part${rewired.parts.length === 1 ? '' : 's'} rewired to the new names` : ''}`,
    items: renames.length > shown.length ? [...shown, `...and ${renames.length - shown.length} more`] : shown,
    tone: 'ok',
    keepOnEdit: false,
    // no checklist: the tags are renamed and the parts already follow them, so nothing is left to do
    checklist: false,
  }
}

/**
 * "+ Program" with its name already chosen: a PROGRAM called `name` in the code, and an instance of it on `task` (the
 * first task when absent), named after it. The organizer asks for the name before the add, so the add is one edit.
 *
 * `name` omitted is the name the add would pick, which is what the name field starts with. A refused name comes back
 * with the reason instead of an edit. `kind` 'ladderProgram' writes the PROGRAM's body as a ladder (the PLC panel's
 * "+ Ladder program").
 */
export function namedProgramAddition(
  source: string,
  table: Controller,
  name?: string,
  kind: 'programPou' | 'ladderProgram' = 'programPou',
  task?: string,
): { name: string; error: null; source: string; controller: Controller } | { name: string; error: string } {
  const added = addProgram(source, table, task, kind)
  const picked = parseDocument(added.source).blocks[added.index]?.name ?? ''
  const to = (name ?? picked).trim()
  if (to === picked) return { name: to, error: null, source: added.source, controller: added.controller }
  const why = blockNameError(added.source, added.index, to)
  if (why !== null) return { name: to, error: why }
  const renamed = renameBlock(added.source, added.index, to)
  // the instance named after the PROGRAM follows it; a PROGRAM that did not exist a moment ago has nothing wired to its
  // tags, so the renames this reports have nothing to move
  return { name: to, error: null, source: renamed.source, controller: renameProgramType(renamed.source, added.controller, picked, to).controller }
}

/**
 * Commit "+ Program" under `name`: the PROGRAM and its instance on `task` as one undo step. A program with no
 * table of its own takes the default one, so its top-level code keeps running beside the new PROGRAM, names and all.
 * Returns why the name was refused, or null once the program is added.
 */
export function commitProgramAddition(store: EditorStore, name: string, kind: 'programPou' | 'ladderProgram' = 'programPou', task?: string): string | null {
  const s = store.getState()
  const added = namedProgramAddition(s.stProgram, s.controller ?? defaultController(s.stProgram, s.stScanMs), name, kind, task)
  if (added.error !== null) return added.error
  store.commitProgram(`Add program ${added.name}`, { source: added.source, controller: added.controller })
  return null
}
