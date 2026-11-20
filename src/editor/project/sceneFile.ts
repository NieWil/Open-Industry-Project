// Shared scene file/lifecycle actions, so the toolbar buttons and the native desktop menu
// (apps/desktop) drive the exact same code paths. Pure of any React/DOM-ref state: they take
// the store/state and do their work, so both entry points behave the same.

import { blankScene, serializeScene, validateScene } from '../../core/scene/scene'
import { DEFAULT_SIM_HZ } from '../../core/types'
import { getRoomCodeGate } from '../../collab/session'
import { DEFAULT_SCAN_MS } from '../program/stProgram'
import type { EditorController } from '../controller'
import type { EditorState, EditorStore, SceneFileContents } from '../store/store'
import { documentSceneOf } from '../store/store'
import { sceneToProject } from '../../core/project/project'
import { definitionsUsedBy } from '../../core/parts/partPackage'
import { getPackage } from '../../core/parts/partRegistry'
import { canCreateProject, createProjectFrom } from './newProject'
import { clearEntryParams, fileOutgoingDocument } from './documentStore'

/**
 * Start a fresh simulation: reset to a blank scene (just the default building), clear the PLC
 * program and put the step rate back to the default. No surface offers this (New Project starts over without
 * destroying anything): unit tests use it. loadStProgram clears the program
 * of record itself (localStorage solo, the shared Y.Text in a room), so it goes whether or not the
 * ST editor panel happens to be mounted to catch the broadcast.
 */
export function newSimulation(store: EditorStore): void {
  store.loadScene(blankScene())
  // the scan time is part of the program, so a cleared program resets it too
  store.loadStProgram('', { scanMs: DEFAULT_SCAN_MS })
  // and the step rate is the scene's, so a fresh scene starts at the default
  store.setSimHz(DEFAULT_SIM_HZ)
}

/**
 * Open the built-in demo - a project of its own, listed under Examples in the projects list. Like opening any
 * project it reloads: into `/app/?scene=demo`, the boot that builds the demo from this build's source every time,
 * so it can never be a stale copy. A project holds one
 * scene, so the demo is another project to open, not a scene swapped in over the one on screen.
 *
 * The project being left is filed first, as every path that leaves a project does, then the page goes. The demo
 * is read-only until edited: nothing of it is saved, and the first edit makes it a project of the user's own
 * (store.stashDemoSession). Leaving it is opening any other project. A room is left too: the demo is the
 * browser's own, not the room's.
 *
 * Routed through the controller when there is one, so a running sim stops and any part-focus session is left
 * before the page goes (EditorController.leaveForSceneSwap).
 */
export function openDemoScene(store: EditorStore, controller?: EditorController | null): void {
  controller?.leaveForSceneSwap()
  store.flushPersist()
  void fileOutgoingDocument(store.outgoingProject()).then((refused) => {
    if (refused !== null) {
      alert(refused)
      return
    }
    if (typeof location === 'undefined') return
    const url = new URL(location.href)
    url.searchParams.delete('room')
    url.searchParams.delete('view')
    url.searchParams.delete('server')
    url.searchParams.set('scene', 'demo')
    location.assign(url.toString())
  }).catch((e: unknown) => alert(e instanceof Error ? e.message : String(e)))
}

/**
 * Leave the demo for the project it was opened from - the working copy, untouched while the demo was on screen:
 * drop the `?scene=demo` entry param and reload. (The projects list does the same for any other project.)
 */
export function leaveDemo(): void {
  clearEntryParams()
  if (typeof location !== 'undefined') location.reload()
}

/**
 * The scene file's text: the layout plus the PLC program bound to it. The one place that decides
 * what an exported scene contains - it takes the program from the same state the controller
 * attaches from, so a file can never carry a different program than the one that was running.
 * (Not the solo localStorage buffer: in a room that holds whatever the user had before they
 * joined, so a scene exported from a room would ship the wrong logic or, usually, none.)
 */
export function sceneFileText(state: EditorState): string {
  // the document's scene, also while a definition session has its own scene on screen
  const scene = documentSceneOf(state)
  // Only the definitions its parts use, products included: a scene file is the scene, not the project's parts. Worked out
  // from the parts rather than trusted to the live scene's copies, which a part added without its copy lacks.
  const { packages: stored, ...rest } = scene
  const byId = new Map((stored ?? []).map((p) => [p.id, p]))
  const packages = definitionsUsedBy(scene.parts, (id) => getPackage(id) ?? byId.get(id))
  const out = packages.length > 0 ? { ...rest, packages } : rest
  return serializeScene(out, state.stProgram, state.stScanMs, undefined, state.controller, state.stDialect, state.simHz)
}

/**
 * Say so when a file leaves this client without the part code a room is holding back (collab/codeTrust.ts).
 *
 * A held part reaches the store carrying a stand-in, and nothing downstream is ever handed the author's
 * source (an export included), so what is written to the file is the stand-in. The file explains that about
 * itself (INERT_BEHAVIOR), but the person exporting is the only one who can still fix it (allow the room's
 * code, export again), so they are told at the moment it happens. Without the notice, a part saved
 * this way is indistinguishable from a part that genuinely does nothing. Called by every path that writes a
 * file out of the app: the project export (projectFile.downloadProject), the one export since format 4.
 */
export function noticeHeldCodeInExport(store: EditorStore): void {
  const held = getRoomCodeGate()?.getHeld() ?? []
  if (held.length === 0) return
  store.showSaveNotice(
    'Saved without some part code',
    held.length === 1
      ? `“${held[0]!.name}” isn't running its own code here, so it was saved without it.`
      : `${held.length} part types in this shared project aren't running their own code here, so they were saved without it.`,
  )
}

const PROJECT_PICKED =
  'This is a project file, not a scene file from an earlier version. Open it with Import Project, in the File menu or the command palette. In the desktop app, a project folder opens with Open Project Folder.'

/** Parse + validate a scene file's text: its contents, or a human-readable reason it is not a scene file. */
function readSceneText(text: string): { ok: true; file: SceneFileContents } | { ok: false; error: string } {
  // a .oip archive is a zip: its text starts with the zip magic, never JSON
  if (text.startsWith('PK\u0003\u0004')) return { ok: false, error: PROJECT_PICKED }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'File is not valid JSON' }
  }
  // a project (a one-file document, or a project folder's project.json) holds a scene (or, before format 4, lists
  // scenes); a scene file holds its parts at the top
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const d = data as { scenes?: unknown; scene?: unknown; parts?: unknown }
    if (Array.isArray(d.scenes) || (d.scene !== undefined && d.parts === undefined)) return { ok: false, error: PROJECT_PICKED }
  }
  const result = validateScene(data)
  if (!result.ok) return { ok: false, error: `Invalid scene file:\n${result.errors.join('\n')}` }
  return { ok: true, file: result }
}

/** The project name for a scene file: its file name without the extension (`.scene.json` from an older project folder). */
export function sceneNameFromFile(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/(\.scene)?\.json$/i, '').trim()
  return base === '' ? 'Imported project' : base
}

/**
 * Import Project, handed a scene file: a scene file (its layout, and the program, scan time, controller, dialect and step rate it
 * carries) as a new project, named after the file and filed beside the one open - which is kept, so nothing is asked
 * first. Creating a project reloads into it (newProject.ts). Resolves to a human-readable error, or null once the
 * reload is under way. A project holds one scene, so this is where a scene file goes; Load over the open scene is
 * loadSceneText, which no surface offers.
 */
export async function importSceneText(store: EditorStore, text: string, fileName: string, controller?: EditorController | null): Promise<string | null> {
  const read = readSceneText(text)
  if (!read.ok) return read.error
  if (!canCreateProject(store)) return SCENE_FILE_NEEDS_LIBRARY
  const f = read.file
  controller?.leaveForSceneSwap()
  return createProjectFrom(store, sceneToProject(f.scene, f.stProgram, sceneNameFromFile(fileName), f.stScanMs, f.controller, f.stDialect, f.simHz))
}

/**
 * Is this text a scene file rather than a project? Import Project takes both and goes by this (App.tsx). By shape,
 * not by validating: a broken scene file should be reported as a broken scene, not as a broken project.
 */
export function isSceneFileText(text: string): boolean {
  if (text.startsWith('PK\u0003\u0004')) return false
  try {
    const d = JSON.parse(text) as { scenes?: unknown; scene?: unknown; parts?: unknown } | null
    return typeof d === 'object' && d !== null && !Array.isArray(d) && Array.isArray(d.parts) && d.scene === undefined && d.scenes === undefined
  } catch {
    return false
  }
}

const SCENE_FILE_NEEDS_LIBRARY =
  'A scene file opens as a project of its own, and there is nowhere to keep a second project here (a view link, or a browser that keeps one project).'

/**
 * Parse + validate a scene file's text and load it over the active scene. Returns a human-readable error
 * message, or null on success. A bundled PLC program replaces the editor buffer; an ST-less scene leaves it
 * as-is. No surface offers this (Import Project makes a scene file a new project): it is what unit tests and gates
 * (window.__oip.loadSceneText) use to put a fixture on screen in the project that is open.
 */
export function loadSceneText(store: EditorStore, text: string): string | null {
  const read = readSceneText(text)
  if (!read.ok) return read.error
  const result = read.file
  store.loadScene(result.scene)
  // A bundled program replaces the buffer, scan time and all. An ST-less file leaves the current
  // program alone (a layout-only import shouldn't silently delete your logic) - which can leave a
  // program attached that names none of this scene's tags, so attachProgram surfaces that as
  // unbound tags / "drives no device" rather than the line never starting.
  if (result.stProgram !== undefined) {
    store.loadStProgram(result.stProgram, { scanMs: result.stScanMs ?? DEFAULT_SCAN_MS, controller: result.controller ?? null, dialect: result.stDialect ?? null })
  } else if (result.stDialect !== undefined && store.getState().stProgram === '') {
    // No program, but a family chosen for one (an empty scene saved after its family was picked, core/dialect.ts). It
    // comes along only onto an empty program: over code it would relabel that code rather than convert it, so there
    // the file is layout-only like any other ST-less file.
    const { stScanMs, controller } = store.getState()
    store.loadStProgram('', { scanMs: stScanMs, controller, dialect: result.stDialect })
  }
  // The step rate is the layout's (core/project/project.ts ProjectMachine.simHz), so unlike the program it always comes along:
  // a file that names none is a 60 Hz scene, and the scene it replaces does not lend it its own
  store.setSimHz(result.simHz ?? DEFAULT_SIM_HZ)
  return null
}
