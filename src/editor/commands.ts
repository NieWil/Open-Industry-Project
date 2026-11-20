// The editor's commands: one definition per app-level action, shared by every surface that offers it.
// Separate copies per surface drift apart (a native-menu Cut that stays clickable with nothing selected
// while the tree menu greys it out), so the label, enablement and behaviour are defined once here.
//
// The split of duties:
//   core/keymap.ts  owns chords (portable, no store); a command names one by id via `keys`
//   this module     owns label + enablement + behaviour
//   each surface    renders the list; it decides layout and nothing else
// commands.test.ts checks the join: every `keys` must name a real keymap action.
//
// The context is module-level rather than passed through props (App re-publishes it each render). One editor
// instance owns the window, popped-out panels included (they run in this same module instance), so there is
// nothing to disambiguate, and a menu item three components deep needs no ctx prop.

import { activeBinding, type KeyActionId } from '../core/keymap'
import { isKnownDialect } from '../core/dialect'
import { defineMessage, t, type MessageId } from '../core/i18n'
import { openDemoScene } from './project/sceneFile'
import { clearParkedSplitOff, downloadProject, downloadProjectDocument, exportChoicesFor, readParkedSplitOff } from './project/projectFile'
import { saveProject } from './project/saveProject'
import { copyRoomToProjects } from './project/roomCopy'
import { ownSharedProject, renameSharedProject, setSpotlight, stopSharing } from './project/sharedProject'
import { getCollabSnapshot } from '../collab/session'
import { requestTutorial } from './tutorial/session'
import { getOipProjectApi, openProjectFromFolder, saveProjectToFolder } from './desktop/desktopProjectBridge'
import { supportsFolderSync } from './project/projectFolderSync'
import { canCreateProject, createNewProject, UNTITLED_PROJECT } from './project/newProject'
import {
  hasPausedFolder,
  linkProjectFolder,
  reconnectProjectFolder,
  saveAndLinkProjectFolder,
  supportsFolderLink,
  unlinkProjectFolder,
} from './project/projectFolderLink'
import type { EditorController } from './controller'
import type { AxisViewId } from './controller/camera'
import { guardOpeningsTarget } from './store/store'
import { canPasteProperties, copyProperties, pasteProperties, propertiesSource } from './store/storeProperties'
import { hasTags } from './program/assignController'
import type { EditorState, EditorStore } from './store/store'
// Lazy: the PLC file doors carry the PLCopen writer and readers, which nothing needs until a file actually moves, and the
// build budgets what loads before the first frame (optimize-assets.mjs, eager JS)
const stFileTransfer = (): Promise<typeof import('./program/stFileTransfer')> => import('./program/stFileTransfer')
import { askName } from './nameDialog'
import { acceleratorHint, primaryKey } from './keyHint'
import { DESKTOP_SHELL } from './desktop/desktopMenuBridge'
import { requestAgentDoorReveal } from './agent/desktopAgent'
import { DESKTOP_DOWNLOAD_URL, openInDesktopApp } from './desktop/desktopLink'
import { canOpenExternal, openExternal, partFolderOf } from './parts/externalEditor'
import { getOipPartsApi } from './desktop/desktopPartsBridge'
import { getShelfApi } from './parts/partShelf'
import { sameAsBuiltIn } from '../core/builtInVersion'
import type { PartPackage } from '../core/parts/partPackage'
import type { SdkPart } from '../core/types'

/** The UI-only affordances a command needs and the store can't provide (pickers, overlays, layout). */
export interface CommandUi {
  /** open the hidden PLC-program picker (.st / PLCopen XML): one input for the PLC panel, the menu and the palette */
  openPlcImportPicker(): void
  /** open Export Project's choices (components/ExportProjectDialog.tsx), for a project with something to leave out */
  openProjectExport(): void
  /** open the hidden project-file picker (.oip, or a scene .json): one input for the menus and the palette */
  openProjectFilePicker(): void
  /** put the docks back to the default arrangement + sizes */
  resetLayout(): void
  /** the settings dialog, on its keyboard tab */
  showShortcuts(): void
  /** the settings dialog, on its preferences tab */
  showSettings(): void
  /** Get parts: the part libraries' parts, to add to the project (components/GetPartsWindow.tsx) */
  showGetParts(): void
  /** Publish to Part Library, for one part of the project's library (components/PublishPartDialog.tsx) */
  showPublishPart(packageId: string): void
  /** this list, as a searchable overlay */
  showCommandPalette(): void
  /** the projects list: every document this browser holds, with open / new / rename / delete */
  showProjects(): void
  /** run the project's own tests and show the verdicts */
  runTests(): void
  /** Controller Properties: where the program runs, here or on an external PLC, and how the link reaches it */
  showControllerProperties(): void
  /** Assign to Controller: which PLC the selected parts' tags go to (components/plc/AssignControllerDialog.tsx) */
  showAssignController(): void
}

export interface CommandCtx {
  store: EditorStore
  controller: EditorController | null
  state: EditorState
  ui: CommandUi
  /** what a surface names for a part command (part.*) when it is not the selection's: a Scene dock row's part, a
   *  catalog card's package. Set only by {@link runCommandOn} / {@link commandEnabledOn}. */
  target?: CommandTarget
}

/** A part command's subject named by a surface, see {@link CommandCtx.target}. */
export interface CommandTarget {
  partId?: string
  packageId?: string
}

export type CommandGroup = 'File' | 'Edit' | 'Simulation' | 'View' | 'Help'

export interface Command {
  /** stable id; shares the namespace with keymap action ids, and IS the id the native menu sends */
  id: string
  label: string
  group: CommandGroup
  /** keymap action whose chord this command shows. The app binds it, so a menu only displays it. */
  keys?: KeyActionId
  /** an accelerator the native menu owns, for commands the app doesn't bind itself (Ctrl+N, F5, …) */
  accelerator?: string
  /**
   * With an {@link accelerator}: a keymap action the app binds that reaches this command too, for the browser,
   * which has no menu to register the accelerator in. A different chord (the transport's F5 is the browser's own),
   * so it can't double-fire with the menu (the transport's Space and Shift+Space); display sites print the accelerator in the desktop app and this in the
   * browser (see {@link commandChord}).
   */
  webKeys?: KeyActionId
  /** needs the desktop shell's file-system bridges; hidden from the web surfaces */
  shellOnly?: boolean
  /** the browser's stand-in for something the desktop does its own way; hidden from the desktop surfaces */
  webOnly?: boolean
  /** false → the surface greys it out. Absent means "always available". */
  enabled?(ctx: CommandCtx): boolean
  /**
   * Why this command is greyed out, when the reason is specific to the command rather than to the
   * app's global state (the toolbar already explains "stop the simulation first" and "view-only link"
   * for everything at once). Consulted only while {@link enabled} is false, and surfaced as the
   * control's tooltip.
   *
   * This exists because a greyed control with no explanation is worse than a hidden one: the user
   * clicks, nothing happens, and there is nowhere to find out why. The case that forced it is the
   * folder link on Safari and Firefox, which have no directory picker - without a reason the whole
   * agent workflow appears broken, when in fact there is another way in (.oip export).
   */
  disabledReason?(ctx: CommandCtx): string | null
  run(ctx: CommandCtx): void
}

/**
 * The sim-speed ladder, in one place. The toolbar cycles it from a single button; each rung is also a
 * command of its own, because cycling is the wrong shape for the surfaces that aren't that button - a
 * menu item or a palette hit that silently advances a setting tells you nothing about where you
 * landed, and getting from 1x to 8x meant clicking four times with no way to ask for 8x directly.
 *
 * 8x is the top rung. Fidelity is not the limit - the loop feeds Jolt the scene's fixed
 * step dt and just runs more steps (sim/worker.ts), so a boosted run is exact at any rung - CPU is:
 * holding Nx needs hz*N steps/s, and the demo scene's ~1.3 ms/step at 60 Hz puts 8x at roughly two
 * thirds of the worker (a 240 Hz scene gets there at 2x). Past that the worker saturates on any real scene and quietly sheds backlog, so a higher
 * rung would be a number the machine can't honour. For "simulate a whole shift as fast as possible",
 * the unclocked path (projectTestRunner) is the right tool, not a bigger multiple of real time.
 */
export const SIM_SPEEDS = [0.5, 1, 2, 4, 8] as const
export type SimSpeed = (typeof SIM_SPEEDS)[number]

/** 0.5 -> 'sim.speed0_5' - a dot would read as a group separator in the id namespace. */
const speedCommandId = (v: SimSpeed): string => `sim.speed${String(v).replace('.', '_')}`

// Each rung says "Speed:" so a palette hit stands on its own, out of the menu that groups them.
const SPEED_NOTE: Partial<Record<SimSpeed, string>> = { 0.5: ' (Slow Motion)', 1: ' (Real Time)' }

// ── Messages shown by run() bodies ───────────────────────────────────────────────────────────────
// The transform below covers every `label` automatically. These are the strings it cannot see, because
// they live inside run() bodies. They name their messages by hand, and commandsI18n.test.ts fails the
// build if a new confirm/alert/prompt goes in carrying a bare literal. Runtime values arrive as {named}
// placeholders rather than concatenated fragments - a fragment join bakes in English word order.

const MSG_NEW_PROJECT_PROMPT = defineMessage('command.file.newProject.prompt', 'New project')
const MSG_NEW_PROJECT_CONFIRM = defineMessage('command.file.newProject.confirm', 'Create')
const MSG_RENAME_PROMPT = defineMessage('command.file.renameProject.prompt', 'Rename project')
const MSG_SAVE_VIEW_ONLY = defineMessage(
  'command.file.save.viewOnly',
  'A view-only link has nothing of yours to save. Export Project makes a copy you can keep.',
)
const MSG_RENAME_CONFIRM = defineMessage('command.file.renameProject.confirm', 'Rename')
const MSG_EXTERNAL_DESKTOP_ONLY = defineMessage(
  'command.part.openExternal.desktopOnly',
  "Open the desktop app to edit this part's script in your own editor.",
)
const MSG_STEP_PAUSE_FIRST = defineMessage('command.sim.step.pauseFirst', 'Pause the simulation to step it one physics step at a time')
const MSG_OPEN_SCRIPT_FAILED = defineMessage('command.part.openExternal.failed', "Couldn't open the script: {error}")
const MSG_SAVED_AS_NEW = defineMessage('command.part.saveAsNew.done', 'Saved as “{name}” in the Parts catalog. Placed parts are unchanged.')
const MSG_GUARD_OPENINGS_NO_TARGET = defineMessage('command.edit.guardOpenings.noTarget', 'Select one conveyor with side guards first.')
const MSG_COPY_PROPERTIES_ONE = defineMessage('command.edit.copyProperties.one', 'Select one part to copy its properties.')
const MSG_PASTE_PROPERTIES_EMPTY = defineMessage('command.edit.pasteProperties.empty', 'Copy Properties from a part first.')
const MSG_PASTE_PROPERTIES_KIND = defineMessage(
  'command.edit.pasteProperties.kind',
  'The properties are from a {kind}. Select parts of that type to paste them onto.',
)
// Kept verbatim from projectFile's ROOM_OWNS_DOCUMENT, the string that already said this, so the import
// refuses a room in the same words wherever the refusal is shown.
const MSG_COPY_ROOM_CONFIRM = defineMessage(
  'command.file.copyRoom.confirm',
  'Copy this shared project into a new project of your own and open it? The shared project is not changed, and its link still opens it.',
)
const MSG_COPY_ROOM_FAILED = defineMessage('command.file.copyRoom.failed', "Couldn't make the copy:\n{error}")
const MSG_COPY_ROOM_SOLO = defineMessage('command.file.copyRoom.solo', "For a shared project someone gave you a link to: it copies it into a project of your own.")
const MSG_STOP_SHARING_NONE = defineMessage('command.file.stopSharing.none', 'For a project of yours that is shared: it makes the project yours alone again.')
const MSG_SPOTLIGHT_OWNER = defineMessage('command.sim.spotlight.owner', 'For the person who shared the project: it asks everyone in it to watch their run.')
/** this tab is the owner of the shared project it is in, as the server vouches for it */
const isRoomOwner = (c = getCollabSnapshot()): boolean => c.owner !== null && c.owner === c.selfId
const MSG_STOP_SHARING_FAILED = defineMessage('command.file.stopSharing.failed', "Couldn't stop sharing:\n{error}")
const MSG_SAVE_FAILED = defineMessage('command.file.saveProject.failed', "Couldn't save the project folder:\n{error}")
const MSG_LINK_FAILED = defineMessage('command.file.linkFolder.failed', "Couldn't link the project folder:\n{error}")
const MSG_RECONNECT_FAILED = defineMessage('command.file.reconnectFolder.failed', "Couldn't follow the project folder again:\n{error}")
// Safari and Firefox have no directory picker (File System Access is Chromium-only for arbitrary
// folders). The message names the alternative: the .oip export carries the identical files, so the
// workflow still works, just manually.
const MSG_NO_PICKER = defineMessage(
  'command.file.folder.noPicker',
  'This browser cannot open a folder. Use Export Project (.oip) instead - it holds the same files.',
)

// Why Reload PLC Program is greyed out, one sentence per reason (see `sim.reloadProgram`).
const MSG_RELOAD_STOPPED = defineMessage('command.sim.reloadProgram.stopped', 'The simulation is stopped. Play runs the program as it is now.')
const MSG_RELOAD_EXTERNAL = defineMessage(
  'command.sim.reloadProgram.external',
  'An external PLC is running the logic (Controller Properties), so this program does not run.',
)
const MSG_RELOAD_PART_SCENE = defineMessage(
  'command.sim.reloadProgram.partScene',
  "The Part Editor runs its part's own behavior, not the PLC program.",
)
const MSG_RELOAD_CURRENT = defineMessage('command.sim.reloadProgram.current', 'The running program is up to date.')
// the text on screen failed to attach, and reloading the same text would fail the same way (editor/program/programReload.ts)
const MSG_RELOAD_FAILED_PREVIOUS = defineMessage(
  'command.sim.reloadProgram.failedPrevious',
  'The program has an error, so the PLC is still running the previous one. Fix it first.',
)
const MSG_RELOAD_FAILED_NONE = defineMessage(
  'command.sim.reloadProgram.failedNone',
  'The program has an error, so the PLC is running nothing. Fix it first.',
)

/** Edits are blocked while the sim runs or on a read-only (view) link - the toolbar's rule, hoisted. */
const editable = (ctx: CommandCtx): boolean => !ctx.state.running && !ctx.state.readOnly
/** The program is in a dialect this build reads (core/dialect.ts), so a command may rewrite it as IEC text. */
const readsProgram = (ctx: CommandCtx): boolean => isKnownDialect(ctx.state.stDialect)
const foreignProgram = (ctx: CommandCtx): string | null =>
  readsProgram(ctx) ? null : `The program is written for the '${ctx.state.stDialect}' dialect, which this version cannot edit`
/** Over OPC UA or EtherNet/IP a part's PLC tag is the PLC's own name for it (MAIN.Eye), so there is no address to give it. */
const byName = (ctx: CommandCtx): boolean => ctx.state.externalPlc.mode === 'opcua' || ctx.state.externalPlc.mode === 'eip' || ctx.state.externalPlc.mode === 'ads'
const ioDisabledReason = (ctx: CommandCtx): string | null =>
  foreignProgram(ctx) ??
  (byName(ctx) ? `Over ${ctx.state.externalPlc.mode === 'eip' ? 'EtherNet/IP' : ctx.state.externalPlc.mode === 'ads' ? 'ADS' : 'OPC UA'} a part's PLC tag is the PLC's own name for it, so nothing is given an address (Controller Properties)` : null)
// Assign I/O, Import / Export I/O List: loaded when one runs, not with the app. Imported statically it held the I/O
// planner (plc/ioAssign.ts) in the first frame for three commands (per eager-census); enablement stays here,
// synchronous, so a menu never waits on it
const ioAssign = (): Promise<typeof import('./program/ioAssign')> => import('./program/ioAssign')
// A rejected command promise reports as the command's own failures do (an alert, a hint), or else in the console
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const warnFailed = (id: string) => (e: unknown): void => console.warn(`[oip] ${id} failed`, e)

const hasSelection = (ctx: CommandCtx): boolean => ctx.state.selectedIds.length > 0

/**
 * The custom part a part command (part.*) acts on: the one the surface names ({@link runCommandOn}: a Scene dock
 * row's icon), else the one part selected, the part whose node is selected, or with nothing selected the part open
 * as its own scene. Null for anything else, a built-in type or a multi-selection included.
 */
function targetPart(ctx: CommandCtx): SdkPart | null {
  const s = ctx.state
  const id =
    ctx.target?.partId ??
    (s.selectedIds.length === 1 ? s.selectedIds[0]! : s.selectedIds.length === 0 ? (s.selectedRigNode?.partId ?? s.focusedPartId) : null)
  const part = id ? s.scene.parts.find((p) => p.id === id) : undefined
  return part?.type === 'part' ? (part as SdkPart) : null
}

/** the package a part command acts on: the one named (a catalog card's), else {@link targetPart}'s */
const targetPackage = (ctx: CommandCtx): string | null => ctx.target?.packageId ?? targetPart(ctx)?.packageId ?? null

/** where this project keeps the target part's files, null when not in the library yet or there is no project folder */
const partScriptDir = (ctx: CommandCtx): string | null => {
  const pkg = targetPackage(ctx)
  return pkg ? partFolderOf(ctx.state, pkg) : null
}

/** the target part as this project made or changed it, which is what can go on the shelf; undefined for a stock built-in */
const shelvablePart = (ctx: CommandCtx): PartPackage | undefined => {
  const id = targetPackage(ctx)
  const copy = id === null ? undefined : ctx.state.userPackages.find((p) => p.id === id)
  return copy && !sameAsBuiltIn(copy, ctx.state.bundledPackages.find((b) => b.id === copy.id)) ? copy : undefined
}

/** an axis view's command, under its keymap action's id and chord */
const axisView = (id: AxisViewId, label: string): Command => ({
  id,
  label,
  group: 'View',
  keys: id,
  enabled: (ctx) => !!ctx.controller,
  run: ({ controller }) => controller?.viewAlongAxis(id),
})

const COMMAND_DEFS: readonly Command[] = [
  // ── File ────────────────────────────────────────────────────────────────────────────────────────
  {
    // A new project, filed beside the one being left (which is saved on the way out and stays in the
    // projects list). Ctrl+N is here and not on Clear below: the chord every app trains people on has
    // to create something, never empty what they are working on.
    id: 'file.newProject',
    label: 'New Project…',
    group: 'File',
    accelerator: 'CmdOrCtrl+N',
    // a room and a view link have no projects list to add to, nor a browser with no library (newProject.ts)
    enabled: (ctx) => canCreateProject(ctx.store),
    run: ({ store }) =>
      void askName({ title: t(MSG_NEW_PROJECT_PROMPT), initial: UNTITLED_PROJECT, confirmLabel: t(MSG_NEW_PROJECT_CONFIRM) })
        .then((name) => name !== null && createNewProject(store, name).then((error) => error !== null && alert(error)))
        .catch((e: unknown) => alert(errorText(e))),
  },
  {
    // An older project's other scenes, in a browser that keeps one project (projectSplit.ts): each split off as a
    // project of its own and downloaded as an .oip file to keep, since there is nowhere here to file them. Shown only
    // while some are waiting. The label says projects because each download is a project file.
    id: 'file.exportSplitOff',
    label: 'Download Split-Off Projects',
    group: 'File',
    enabled: () => readParkedSplitOff().length > 0,
    run: () =>
      void (async () => {
        for (const project of readParkedSplitOff()) await downloadProjectDocument(project)
        clearParkedSplitOff()
      })(),
  },
  {
    id: 'file.openDemo',
    // Not "Open Demo Scene": it opens a project, the built-in example (a reload into ?scene=demo), which becomes
    // one of the user's only when they edit it or keep a copy (store.stashDemoSession).
    label: 'Open Demo',
    group: 'File',
    enabled: editable,
    // rebuilt from this build's source every time, so the example is never a stale copy
    run: ({ store, controller }) => openDemoScene(store, controller),
  },
  {
    // Save, on every surface: the project already saves itself as you go, so this writes anything pending
    // and says where the work is - its folder on the desktop, this browser's storage (with "Download a
    // copy") on the web (editor/project/saveProject.ts). `keys`, not `accelerator`: the app binds Ctrl+S (App.tsx),
    // because the browser has no menu to, and the desktop menu then only displays the chord.
    id: 'file.save',
    label: 'Save',
    group: 'File',
    keys: 'file.save',
    // saving changes nothing in the document, so a running sim is no reason to refuse it
    enabled: (ctx) => !ctx.state.readOnly,
    disabledReason: (ctx) => (ctx.state.readOnly ? t(MSG_SAVE_VIEW_ONLY) : null),
    run: ({ store, controller }) => void saveProject(store, controller),
  },
  {
    // The project as one file: the scene, its program, the part library, the tests - what "keep a
    // copy" means. It is also the way to send a job: when the project carries things the scene does not show (custom
    // parts nothing uses, tests), it asks which to include first (ExportProjectDialog), all ticked. That
    // replaced a separate "Export Scene", which was this trimmed export under a name that made a scene look like a
    // file of its own. A pure export, so it stays available while running, read-only and in a room (whose parts it
    // carries, with stand-ins for code the room is holding back: noticeHeldCodeInExport).
    id: 'file.exportProject',
    label: 'Export Project (.oip)…',
    group: 'File',
    run: ({ store, ui }) => {
      const choices = exportChoicesFor(store.snapshotProject())
      if (choices.unusedParts.length === 0 && choices.tests === 0) void downloadProject(store)
      else ui.openProjectExport()
    },
  },
  {
    // The way back IN, beside the way out. Import kept the very defect the comment above records fixing for
    // export: it lived only as an icon in the scene switcher, so the File menu, the palette and the overflow
    // could not find it, the desktop menu could not offer it at all (main renders the model this registry
    // builds, and holds no labels of its own), and the mobile toolbar drops the project-management buttons
    // outright - leaving a phone no route in. That matters more than an ordinary omission because the folder
    // link points here: a browser with no directory picker is told to use Export Project (.oip) instead
    // (MSG_NO_PICKER), which is a round trip whose return leg was undiscoverable.
    //
    // Placed next to the export so the pair reads as one round trip in every menu that renders this list.
    //
    // It is also where a scene file comes in (App.tsx sniffs which it was): both become a project of their own, so
    // a separate "Open Scene File…" was a second door to the same room, and made a scene look like a document.
    id: 'file.importProject',
    label: 'Import Project…',
    group: 'File',
    accelerator: 'CmdOrCtrl+O',
    // The three refusals, said once. A run must stop first (the import
    // reloads into another document); a room owns its document, which importProjectData refuses anyway, so
    // greying it says so before a file picker opens rather than after; and a view-only link has nothing to
    // import into.
    enabled: (ctx) => !ctx.state.running && !ctx.state.readOnly,
    // Only the room is spoken here. Running and view-only are the global blocks a surface already explains
    // (Toolbar.fileBlockedReason fills that half in), and the convention is that a command must not double
    // them up - see the folder commands' two specs in commands.test.ts.
    run: ({ ui }) => ui.openProjectFilePicker(),
  },
  {
    // A room's document as a new project of your own (roomCopy.ts): what the export-leave-import round trip
    // did, without its two traps. Allowed on a view-only link too: wanting your own copy is exactly a viewer's case.
    id: 'file.copyRoom',
    label: 'Make a Copy',
    group: 'File',
    enabled: (ctx) => ctx.state.collab && !ctx.state.running,
    // Running is the global block the toolbar explains; outside a room, say what the command is for.
    disabledReason: (ctx) => (ctx.state.collab ? null : t(MSG_COPY_ROOM_SOLO)),
    run: ({ store }) => {
      if (!confirm(t(MSG_COPY_ROOM_CONFIRM))) return
      void copyRoomToProjects(store).then((error) => {
        if (error !== null) alert(t(MSG_COPY_ROOM_FAILED, { error }))
      }).catch((e: unknown) => alert(t(MSG_COPY_ROOM_FAILED, { error: errorText(e) })))
    },
  },
  {
    // A project of the user's own, shared, becomes theirs alone again (project/sharedProject.ts). The Share popover
    // offers it too.
    id: 'file.stopSharing',
    label: 'Stop Sharing This Project',
    group: 'File',
    enabled: (ctx) => ctx.state.collab && !ctx.state.running && ownSharedProject() !== null,
    disabledReason: (ctx) => (ctx.state.collab && ownSharedProject() !== null ? null : t(MSG_STOP_SHARING_NONE)),
    run: ({ store }) => {
      const shared = ownSharedProject()
      if (!shared) return
      void stopSharing(store, shared).then((error) => {
        if (error !== null) alert(t(MSG_STOP_SHARING_FAILED, { error }))
      }).catch((e: unknown) => alert(t(MSG_STOP_SHARING_FAILED, { error: errorText(e) })))
    },
  },
  {
    // The PLC program's own doors, beside the project's. Import replaces only the program, as one undo step
    // (stFileTransfer.ts), so a running sim is no reason to refuse it; a view-only link is.
    id: 'file.importPlc',
    label: 'Import PLC Program…',
    group: 'File',
    enabled: ({ state }) => !state.readOnly,
    run: ({ ui }) => ui.openPlcImportPicker(),
  },
  {
    // An I/O list is the document a controls engineer hands over: tag names against addresses. Importing one
    // puts this scene on the real machine's points, so the program it will run there is the program run here.
    id: 'file.importIoList',
    label: 'Import I/O List…',
    group: 'File',
    enabled: (ctx) => editable(ctx) && readsProgram(ctx) && !byName(ctx),
    disabledReason: ioDisabledReason,
    run: ({ store }) => void ioAssign().then((m) => m.pickAndImportIoList(store)).catch(warnFailed('file.importIoList')),
  },
  {
    // The other half of the I/O list door: what this scene serves, as the CSV a panel builder works from.
    // A pure export, so it stays available while running and on a view-only link.
    id: 'file.exportIoList',
    label: 'Export I/O List (.csv)',
    group: 'File',
    enabled: (ctx) => ctx.state.scene.parts.length > 0,
    run: ({ store }) => void ioAssign().then((m) => m.exportIoList(store)).catch(warnFailed('file.exportIoList')),
  },
  {
    // pure exports, like Export Project: available while running and on a view-only link
    id: 'file.exportPlcSt',
    label: 'Export PLC Program (.st)',
    group: 'File',
    run: ({ store }) => void stFileTransfer().then((m) => m.exportStProgram(store, 'iec-text')).catch(warnFailed('file.exportPlcSt')),
  },
  {
    id: 'file.exportPlcXml',
    label: 'Export PLC Program (PLCopen XML)',
    group: 'File',
    run: ({ store }) => void stFileTransfer().then((m) => m.exportStProgram(store, 'plcopen-xml')).catch(warnFailed('file.exportPlcXml')),
  },
  {
    // The projects list. A command and not a start screen: /app/ opens onto the working copy and
    // always will (a single-document web app opening on your last work is correct, and the landing
    // funnel is one click to a running line). This is the surface a returning user reaches for once
    // there is a second line to build - the point at which "no recents" stopped being cosmetic.
    id: 'file.projects',
    label: 'Projects…',
    group: 'File',
    // A view-only link owns nothing. A shared project is left for the one opened, as any open project is.
    // Running is fine: the projects list is only a list, and the actions inside it stop the session anyway.
    enabled: (ctx) => !ctx.state.readOnly,
    run: ({ ui }) => ui.showProjects(),
  },
  {
    // Where the document is named. The name shows on the project menu's button (ProjectMenu.tsx) and in the
    // browser tab / desktop window title, and is changed from here.
    id: 'file.renameProject',
    label: 'Rename Project…',
    group: 'File',
    // Not `editable`: a relabel touches no scene, so a running sim is no reason to refuse
    // it. The two that are real are the demo preview (a rename must not fork it into a scene) and a room
    // (the name would not persist) - store.renameProject enforces the same two, this only greys them.
    // A shared project of the user's own is still theirs to rename (project/sharedProject.ts).
    enabled: (ctx) => !ctx.state.readOnly && !ctx.state.demoSession && (!ctx.state.collab || (ownSharedProject() !== null && !ownSharedProject()!.demo)),
    // askName rather than window.prompt, which throws in the Electron shell - where this is a native menu item
    run: ({ store, state }) =>
      void askName({ title: t(MSG_RENAME_PROMPT), initial: ownSharedProject()?.project ?? state.projectName, confirmLabel: t(MSG_RENAME_CONFIRM) })
        .then((name) => {
          if (name === null) return
          const shared = state.collab ? ownSharedProject() : null
          if (shared) renameSharedProject(store, shared.docId, name)
          else store.renameProject(name)
        })
        .catch((e: unknown) => alert(errorText(e))),
  },
  {
    id: 'file.openProject',
    label: 'Open Project Folder…',
    group: 'File',
    shellOnly: true,
    enabled: editable,
    run: ({ store }) => void openProjectFromFolder(store),
  },
  {
    // One command, two implementations: the desktop's native picker, and the browser's File System
    // Access equivalent. Either way the project is then stored in that folder, kept in sync both ways
    // (projectFolderSync.ts), and a "Saved to folder" notice says where.
    id: 'file.saveProject',
    label: 'Save Project to Folder…',
    group: 'File',
    enabled: (ctx) => (getOipProjectApi() !== null || supportsFolderLink()) && editable(ctx),
    disabledReason: (ctx) => (getOipProjectApi() === null && !supportsFolderLink() && editable(ctx) ? t(MSG_NO_PICKER) : null),
    run: ({ store, controller }) => {
      if (getOipProjectApi() !== null) return void saveProjectToFolder(store, controller)
      void saveAndLinkProjectFolder(store, controller).then((error) => {
        if (error !== null) alert(t(MSG_SAVE_FAILED, { error }))
      }).catch((e: unknown) => alert(t(MSG_SAVE_FAILED, { error: errorText(e) })))
    },
  },
  {
    // The browser's way to open a project from a folder and keep the two in sync both ways (Open Project
    // Folder does this on the desktop). Greyed out where the picker doesn't exist (Safari, Firefox) rather
    // than hidden, so the reason is discoverable instead of the command silently not being there.
    id: 'file.linkFolder',
    label: 'Link Project Folder…',
    group: 'File',
    // The desktop has its own (Open Project Folder, through the shell). Electron's Chromium would offer the
    // browser picker too, and a second host for the same document would run two conflicting syncs.
    webOnly: true,
    enabled: (ctx) => supportsFolderLink() && !supportsFolderSync() && editable(ctx),
    disabledReason: (ctx) => (!supportsFolderLink() && editable(ctx) ? t(MSG_NO_PICKER) : null),
    run: ({ store, controller }) =>
      void linkProjectFolder(store, controller).then((error) => {
        // the picker is a user gesture, so an alert is the right weight here; failures from the
        // background sync go to the sticky banner instead (nobody is watching for a dialog then)
        if (error !== null) alert(t(MSG_LINK_FAILED, { error }))
      }).catch((e: unknown) => alert(t(MSG_LINK_FAILED, { error: errorText(e) }))),
  },
  {
    // Only reachable in the one state that needs it: a folder this document is remembered as following
    // (folderHandleStore) whose permission the browser dropped on reload. The banner carries the same
    // action where the user will actually see it; this exists so the palette and the File menu can do
    // it too. Enablement reads state so the menu re-evaluates on a change, and hasPausedFolder() keeps
    // it in sync with the live handle behind that state.
    id: 'file.reconnectFolder',
    label: 'Reconnect Project Folder',
    group: 'File',
    enabled: (ctx) => ctx.state.pausedFolder !== null && hasPausedFolder(),
    run: ({ store, controller }) =>
      void reconnectProjectFolder(store, controller).then((error) => {
        // a click, so an alert is the right weight - the same split linkFolder makes
        if (error !== null) alert(t(MSG_RECONNECT_FAILED, { error }))
      }).catch((e: unknown) => alert(t(MSG_RECONNECT_FAILED, { error: errorText(e) }))),
  },
  {
    id: 'file.unlinkFolder',
    label: 'Unlink Project Folder',
    group: 'File',
    // The project stops living in its folder: it stays open, stored in the app only, and the folder is left
    // as it is. A remembered-but-paused folder is unlinkable too: that is how the user says "stop offering
    // it". On the desktop the choice is remembered, so the next edit does not hand it a new folder.
    enabled: (ctx) => ctx.state.linkedFolder !== null || ctx.state.pausedFolder !== null || ctx.state.folderPath !== null,
    run: ({ store }) => unlinkProjectFolder(store),
  },
  {
    id: 'file.showProjectFolder',
    label: 'Show Project Folder',
    group: 'File',
    shellOnly: true,
    enabled: (ctx) => ctx.state.folderPath !== null,
    run: ({ state }) => {
      if (state.folderPath !== null) void getOipProjectApi()?.reveal(state.folderPath)
    },
  },

  // ── Edit ────────────────────────────────────────────────────────────────────────────────────────
  // These carry `keys`, not `accelerator`: the app's own keydown already binds them, so a menu that
  // registered the same chord would fire the command twice.
  {
    id: 'edit.undo',
    label: 'Undo',
    group: 'Edit',
    keys: 'edit.undo',
    enabled: (ctx) => !ctx.state.readOnly && ctx.store.canUndo,
    run: ({ store }) => store.undo(),
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    group: 'Edit',
    keys: 'edit.redo',
    enabled: (ctx) => !ctx.state.readOnly && ctx.store.canRedo,
    run: ({ store }) => store.redo(),
  },
  {
    id: 'edit.cut',
    label: 'Cut',
    group: 'Edit',
    keys: 'edit.cut',
    enabled: (ctx) => !ctx.state.readOnly && hasSelection(ctx),
    run: ({ store }) => store.cutSelection(),
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    group: 'Edit',
    keys: 'edit.copy',
    enabled: hasSelection,
    run: ({ store }) => store.copySelection(),
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    group: 'Edit',
    keys: 'edit.paste',
    enabled: (ctx) => !ctx.state.readOnly,
    run: ({ store }) => store.paste(),
  },
  {
    id: 'edit.duplicate',
    label: 'Duplicate',
    group: 'Edit',
    keys: 'edit.duplicate',
    enabled: (ctx) => !ctx.state.readOnly && hasSelection(ctx),
    run: ({ store }) => store.duplicateSelection(),
  },
  {
    // every property of one part onto the selected parts of its type (store/storeProperties.ts); the Inspector's
    // row menu copies one property at a time. Name, transform and tags stay each part's own.
    id: 'edit.copyProperties',
    label: 'Copy Properties',
    group: 'Edit',
    enabled: (ctx) => propertiesSource(ctx.state) !== null,
    disabledReason: () => t(MSG_COPY_PROPERTIES_ONE),
    run: ({ store }) => copyProperties(store),
  },
  {
    id: 'edit.pasteProperties',
    label: 'Paste Properties',
    group: 'Edit',
    enabled: (ctx) => !ctx.state.readOnly && canPasteProperties(ctx.state),
    disabledReason: (ctx) => {
      if (ctx.state.readOnly) return null
      const clip = ctx.state.propertyClipboard
      return clip ? t(MSG_PASTE_PROPERTIES_KIND, { kind: clip.kindLabel }) : t(MSG_PASTE_PROPERTIES_EMPTY)
    },
    run: ({ store }) => pasteProperties(store),
  },
  {
    // A part's tag names the PLC it goes to (`Cell2::%IX0.0`, core/io/controllerTag.ts). This rewrites that name on
    // every tag of the selection at once, so a copied cell goes to a second PLC in one step and one undo.
    id: 'edit.assignController',
    label: 'Assign to Controller…',
    group: 'Edit',
    enabled: (ctx) => editable(ctx) && ctx.state.packageEdit === null && hasTags(ctx.state.scene, ctx.state.selectedIds),
    run: ({ ui }) => ui.showAssignController(),
  },
  {
    id: 'edit.delete',
    label: 'Delete',
    group: 'Edit',
    keys: 'edit.delete',
    // in guard-openings mode Delete means the selected opening, never the conveyor being edited
    enabled: (ctx) => !ctx.state.readOnly && (ctx.state.sideGuardMode ? ctx.state.selectedGuardOpening !== null : hasSelection(ctx)),
    run: ({ store, state }) => (state.sideGuardMode ? void store.removeSelectedGuardOpening() : store.deleteSelection()),
  },
  {
    id: 'edit.guardOpenings',
    label: 'Edit Guard Openings',
    group: 'Edit',
    keys: 'edit.sideGuards',
    enabled: (ctx) => !ctx.state.readOnly && (ctx.state.sideGuardMode || guardOpeningsTarget(ctx.state) !== null),
    disabledReason: (ctx) => (ctx.state.readOnly ? null : t(MSG_GUARD_OPENINGS_NO_TARGET)),
    run: ({ store }) => void store.toggleSideGuardMode(),
  },
  {
    id: 'edit.selectAll',
    label: 'Select All Parts',
    group: 'Edit',
    enabled: (ctx) => ctx.state.scene.parts.length > 0,
    run: ({ store, state }) => store.selectMany(state.scene.parts.map((p) => p.id)),
  },

  // ── A custom part's own actions ─────────────────────────────────────────────────────────────────
  // On the part's Scene dock row (its icons and right-click menu), the Inspector's header and, for Edit Behavior,
  // its catalog card, which all render these rather than keep copies of what each does and when. They act on
  // targetPart(): the part a surface names (runCommandOn), else the selection's.
  {
    // "Part editor", not "scene": a scene is a project's 3D world, and this is a workspace for one part
    id: 'part.openScene',
    label: 'Open Part Editor',
    group: 'Edit',
    enabled: (ctx) => {
      const part = targetPart(ctx)
      return part !== null && ctx.state.focusedPartId !== part.id
    },
    run: (ctx) => {
      const part = targetPart(ctx)
      if (!part) return
      if (ctx.controller) ctx.controller.openPartScene(part.id)
      else ctx.store.enterPartFocus(part.id)
    },
  },
  {
    id: 'part.closeScene',
    label: 'Close Part Editor',
    group: 'Edit',
    enabled: (ctx) => ctx.state.focusedPartId !== null,
    run: ({ controller, store }) => (controller ? controller.closePartScene() : store.exitPartFocus()),
  },
  {
    id: 'part.editBehavior',
    label: 'Edit Behavior…',
    group: 'Edit',
    // open in a view-only link too: reading a script is harmless, and the store refuses the edits
    enabled: (ctx) => targetPackage(ctx) !== null,
    run: (ctx) => {
      const pkg = targetPackage(ctx)
      if (pkg) ctx.store.openBehaviorEditor(pkg)
    },
  },
  {
    // a variant beside the original, never in place of it (controller.saveAsNewPart, docs/part-sources.md "Variants")
    id: 'part.saveAsNew',
    label: 'Save as New Part',
    group: 'Edit',
    enabled: (ctx) => !!ctx.controller && !ctx.state.readOnly && targetPackage(ctx) !== null,
    run: (ctx) => {
      const pkg = targetPackage(ctx)
      const id = pkg && ctx.controller ? ctx.controller.saveAsNewPart(pkg) : null
      const made = id ? ctx.store.getState().userPackages.find((p) => p.id === id) : undefined
      if (made) ctx.store.flashViewportHint(t(MSG_SAVED_AS_NEW, { name: made.name }))
    },
  },
  {
    // to the listed library, as a pull request under the author's GitHub account (docs/part-libraries.md, "Publishing").
    // Only a part of this project's own library, and never the project's own oip.* parts, which oip-web publishes.
    id: 'part.publish',
    label: 'Publish to Part Library…',
    group: 'Edit',
    enabled: (ctx) => {
      const id = targetPackage(ctx)
      return id !== null && !id.startsWith('oip.') && ctx.state.userPackages.some((p) => p.id === id)
    },
    run: (ctx) => {
      const id = targetPackage(ctx)
      if (id) ctx.ui.showPublishPart(id)
    },
  },
  {
    // a part this project made or changed, onto the parts shelf for other projects to place (docs/parts-shelf.md). A stock
    // built-in is in every project already. Asks first, and over a different shelf version lists what changes there.
    id: 'part.putOnShelf',
    label: 'Put on Shelf…',
    group: 'Edit',
    shellOnly: true,
    enabled: (ctx) => !ctx.state.readOnly && getShelfApi() !== null && shelvablePart(ctx) !== undefined,
    run: (ctx) => {
      const part = shelvablePart(ctx)
      if (part) void import('./parts/shelfActions').then((a) => a.putPartOnShelf(ctx.store, part)).catch(warnFailed('part.putOnShelf'))
    },
  },
  {
    id: 'part.openExternal',
    label: 'Open in External Editor',
    group: 'Edit',
    enabled: (ctx) => {
      const pkg = targetPackage(ctx)
      return pkg !== null && canOpenExternal(pkg)
    },
    disabledReason: () => (DESKTOP_SHELL ? null : t(MSG_EXTERNAL_DESKTOP_ONLY)),
    run: (ctx) => {
      const pkg = targetPackage(ctx)
      if (!pkg) return
      // nowhere on every surface to print beside, so a failure (no editor, an unwritable folder) flashes over the viewport
      void openExternal(pkg, ctx.store).then((err) => {
        if (err) ctx.store.flashViewportHint(t(MSG_OPEN_SCRIPT_FAILED, { error: err }))
      }).catch((e: unknown) => ctx.store.flashViewportHint(t(MSG_OPEN_SCRIPT_FAILED, { error: errorText(e) })))
    },
  },
  {
    id: 'part.reveal',
    label: 'Reveal in Folder',
    group: 'Edit',
    shellOnly: true,
    // only a part whose files are in the project folder
    enabled: (ctx) => partScriptDir(ctx) !== null && !!getOipPartsApi()?.revealPart,
    run: (ctx) => {
      const dir = partScriptDir(ctx)
      const reveal = getOipPartsApi()?.revealPart
      if (!dir || !reveal) return
      void reveal(dir).then((err) => {
        if (err) ctx.store.flashViewportHint(t(MSG_OPEN_SCRIPT_FAILED, { error: err }))
      }).catch((e: unknown) => ctx.store.flashViewportHint(t(MSG_OPEN_SCRIPT_FAILED, { error: errorText(e) })))
    },
  },

  // ── Simulation ──────────────────────────────────────────────────────────────────────────────────
  {
    id: 'sim.run',
    label: 'Run',
    group: 'Simulation',
    accelerator: 'F5',
    webKeys: 'sim.playPause',
    enabled: (ctx) => !!ctx.controller && !ctx.state.running,
    run: ({ controller }) => controller?.run(),
  },
  {
    id: 'sim.pause',
    label: 'Pause',
    group: 'Simulation',
    accelerator: 'F6',
    webKeys: 'sim.playPause',
    enabled: (ctx) => !!ctx.controller && ctx.state.running,
    run: ({ controller }) => controller?.togglePause(),
  },
  {
    // One fixed physics step, with the PLC scans due in it, so a sensor edge or a one-scan pulse can be watched
    // happen. Paused only: running, the loop is already stepping.
    id: 'sim.step',
    label: 'Step',
    group: 'Simulation',
    accelerator: 'F7',
    webKeys: 'sim.step',
    enabled: (ctx) => !!ctx.controller && ctx.state.running && ctx.state.paused,
    // stopped needs no reason of its own: the toolbar already says the run is stopped
    disabledReason: (ctx) => (ctx.state.running && !ctx.state.paused ? t(MSG_STEP_PAUSE_FIRST) : null),
    run: ({ controller }) => controller?.step(),
  },
  {
    id: 'sim.stop',
    label: 'Stop',
    group: 'Simulation',
    accelerator: 'Shift+F5',
    webKeys: 'sim.stop',
    enabled: (ctx) => !!ctx.controller && ctx.state.running,
    run: ({ controller }) => controller?.stop(),
  },
  {
    // Loads the program as it is now into the running sim without resetting the world. It restarts the program
    // (its variables, timers and steps start over; there is no online change), so it runs only when asked, not on
    // every keystroke. Enabled only when the running program is out of date (editor/program/programReload.ts), so the PLC
    // dock's button lights up exactly when the text on screen is not what runs. No chord: Ctrl/Cmd-Enter in the code editor reaches it (StEditor).
    id: 'sim.reloadProgram',
    label: 'Reload PLC Program',
    group: 'Simulation',
    enabled: (ctx) => ctx.controller?.programOutOfDate ?? false,
    disabledReason: ({ controller }) => {
      // no controller yet (boot) reads as stopped; a null blocker means running, so the program is up to date
      const blocker = controller ? controller.programReloadBlocker : 'stopped'
      if (blocker === 'stopped') return t(MSG_RELOAD_STOPPED)
      if (blocker === 'external') return t(MSG_RELOAD_EXTERNAL)
      if (blocker === 'partScene') return t(MSG_RELOAD_PART_SCENE)
      const failure = controller?.programAttachFailure ?? null
      if (failure === 'previous') return t(MSG_RELOAD_FAILED_PREVIOUS)
      if (failure === 'none') return t(MSG_RELOAD_FAILED_NONE)
      return t(MSG_RELOAD_CURRENT)
    },
    run: ({ controller }) => controller?.reloadProgram(),
  },
  {
    // The way out of a commissioning session in one move: every forced variable is the program's again from its
    // next scan. The palette and the toolbar's forced count (ForcesStatus.tsx) run it. Not in the native menu:
    // forces change without the app re-rendering, so a native menu item's enablement would go stale.
    id: 'sim.releaseForces',
    label: 'Release All Forces',
    group: 'Simulation',
    enabled: (ctx) => Object.keys(ctx.controller?.plcForces ?? {}).length > 0,
    run: ({ controller }) => controller?.releasePlcForces(),
  },
  {
    // No chord: this is a deliberate, occasional action, and a command with neither
    // `keys` nor `accelerator` still reaches the palette and the native menu (which is the point of
    // the registry). Enablement is the count, so a project with no tests greys the item out rather
    // than opening an empty verdict list.
    id: 'sim.runTests',
    label: 'Run Project Tests',
    group: 'Simulation',
    enabled: (ctx) => ctx.state.testCount > 0,
    run: ({ ui }) => ui.runTests(),
  },
  {
    // Wiring a part to a PLC's I/O point is what handing the line to a real controller takes, and doing it by
    // hand is the grunt work this exists to remove: one command for the whole scene, one undo step back.
    id: 'sim.assignIo',
    label: 'Assign I/O Addresses',
    group: 'Simulation',
    enabled: (ctx) => editable(ctx) && readsProgram(ctx) && !byName(ctx) && ctx.state.scene.parts.length > 0,
    disabledReason: ioDisabledReason,
    run: ({ store }) => void ioAssign().then((m) => m.runIoAssignment(store)).catch(warnFailed('sim.assignIo')),
  },
  {
    // Where the program runs: here, or on a real PLC that Play hands the scene's I/O to (Modbus TCP either way round,
    // or OPC UA). The organizer's Controller node and the toolbar's link status open the same dialog; this is the way
    // in for someone who searches the palette for "PLC", "Modbus" or "OPC", and the name says it lists every controller.
    id: 'sim.externalPlc',
    label: 'PLC Controllers…',
    group: 'Simulation',
    run: ({ ui }) => ui.showControllerProperties(),
  },
  {
    // Not folded into Run Project Tests. That command is disabled when a project carries
    // no tests, and a project with no tests is exactly where an unseated part is most likely AND least
    // likely to be noticed. This one needs no tests and no running sim - it reads geometry already in
    // memory - so its only requirement is that there is something to check. The check itself is one of the
    // Problems dock's (its Layout rows), so this brings that dock forward rather than drawing a verdict of its own.
    id: 'sim.checkLayout',
    label: 'Check Layout',
    group: 'Simulation',
    enabled: (ctx) => ctx.state.scene.parts.length > 0,
    run: ({ store }) => store.revealPanel('problems'),
  },
  {
    id: 'sim.pilot',
    label: 'Pilot Mode',
    group: 'Simulation',
    keys: 'pilot.enter',
    run: ({ store, state }) => (state.mode === 'pilot' ? store.exitPilot() : store.enterPilot()),
  },
  {
    // The owner asks everyone in the shared project to watch its run (docs/live-share.md); also on the chip and the people list
    id: 'sim.spotlight',
    label: 'Spotlight Me',
    group: 'Simulation',
    enabled: () => isRoomOwner() && !getCollabSnapshot().spotlight,
    disabledReason: () => t(MSG_SPOTLIGHT_OWNER),
    run: () => setSpotlight(true),
  },
  {
    id: 'sim.stopSpotlight',
    label: 'Stop Spotlight',
    group: 'Simulation',
    enabled: () => isRoomOwner() && getCollabSnapshot().spotlight,
    run: () => setSpotlight(false),
  },
  // One per rung rather than one "cycle" command: see SIM_SPEEDS. No chords - the ladder is five
  // deep and the toolbar button already owns the quick walk through it (click / Shift+click).
  ...SIM_SPEEDS.map(
    (v): Command => ({
      id: speedCommandId(v),
      label: `Speed: ${v}×${SPEED_NOTE[v] ?? ''}`,
      group: 'Simulation',
      enabled: (ctx) => !!ctx.controller,
      run: ({ controller }) => controller?.setTimeScale(v),
    }),
  ),

  // ── View ────────────────────────────────────────────────────────────────────────────────────────
  {
    // Only the scene, for a projector (components/PresentOverlay.tsx), fullscreen, which only a click can ask for
    id: 'view.present',
    label: 'Present',
    group: 'View',
    run: ({ store }) => {
      store.setState({ presenting: true })
      void document.documentElement.requestFullscreen?.()?.catch(() => {})
    },
  },
  {
    id: 'view.distractionFree',
    label: 'Distraction Free Mode',
    group: 'View',
    keys: 'view.distractionFree',
    run: ({ store }) => store.toggleDistractionFree(),
  },
  {
    id: 'view.resetLayout',
    label: 'Reset Panel Layout',
    group: 'View',
    run: ({ ui }) => ui.resetLayout(),
  },
  {
    // Annotations are on by default (a placed note is content, not a preference), so this exists for the
    // two times you want them gone: when a note sits over the thing it annotates, and for a clean shot.
    // Enablement is the count, so a scene with no notes greys the item out instead of offering a toggle
    // that appears to do nothing.
    id: 'view.annotations',
    label: 'Show Annotations',
    group: 'View',
    enabled: (ctx) => ctx.state.scene.parts.some((p) => p.type === 'annotation'),
    run: ({ store }) => store.toggleShowNotes(),
  },
  // The viewport toolbar's display toggles and the Settings read-out, here so a palette search finds them
  {
    id: 'view.grid',
    label: 'Show Grid',
    group: 'View',
    run: ({ store }) => store.toggleGrid(),
  },
  {
    id: 'view.flowArrows',
    label: 'Show Flow Arrows',
    group: 'View',
    keys: 'view.flowArrows',
    run: ({ store }) => store.toggleFlowArrows(),
  },
  {
    id: 'view.stats',
    label: 'Show Performance Read-out',
    group: 'View',
    run: ({ store }) => store.toggleShowStats(),
  },
  {
    // The camera is remembered per scene (editor/store/storePrefs viewport state), so this is Reset Panel
    // Layout's counterpart: the way back from a view left somewhere useless, without hunting for a
    // framing by hand. Forgets the remembered pose too, so the scene reopens on its opening view.
    id: 'view.resetCamera',
    label: 'Reset View',
    group: 'View',
    enabled: (ctx) => !!ctx.controller,
    run: ({ controller }) => controller?.resetCamera(),
  },
  {
    // No toolbar button: the view you want orthographic is an axis view, and clicking an orbit-gizmo
    // axis ball already switches to it (and back once you orbit off). This is for the rarer explicit,
    // sticky orthographic from any angle - found here or on its chord, not worth a toolbar slot.
    id: 'view.projection',
    label: 'Toggle Perspective / Orthographic',
    group: 'View',
    keys: 'view.projection',
    run: ({ store }) => store.toggleProjection(),
  },
  // The orbit gizmo's axis balls, for whoever has no numpad (a laptop) or wants the view by name
  axisView('view.front', 'Front View'),
  axisView('view.rear', 'Rear View'),
  axisView('view.right', 'Right View'),
  axisView('view.left', 'Left View'),
  axisView('view.top', 'Top View'),
  axisView('view.bottom', 'Bottom View'),
  {
    id: 'view.commandPalette',
    label: 'Command Palette…',
    group: 'View',
    keys: 'ui.commands',
    run: ({ ui }) => ui.showCommandPalette(),
  },
  {
    // The PLC, Controller and Problems docks start as background tabs behind the Parts catalog, so
    // without these they are discoverable only by noticing a tab you were not looking for. No chord:
    // each is opened now and then, and the bottom dock's tab strip is the fast path once you
    // know it is there. Listed in the strip's order.
    id: 'view.plc',
    label: 'PLC',
    group: 'View',
    run: ({ store }) => store.revealPanel('st'),
  },
  {
    id: 'view.problems',
    label: 'Problems',
    group: 'View',
    run: ({ store }) => store.revealPanel('problems'),
  },
  {
    id: 'view.watch',
    label: 'Watch',
    group: 'View',
    run: ({ store }) => store.revealPanel('watch'),
  },
  {
    // The preferences half of the same dialog the ? chord opens on its keyboard tab. No chord of its
    // own: it is opened rarely, and every OS puts it in a menu rather than on a key.
    id: 'view.settings',
    label: 'Settings…',
    group: 'View',
    run: ({ ui }) => ui.showSettings(),
  },
  {
    // the part libraries (docs/part-libraries.md): getting parts this project does not have, beside the Parts dock's
    // button. Adding one changes the project's library, so a view-only link cannot
    id: 'file.getParts',
    label: 'Get Parts…',
    group: 'File',
    enabled: ({ state }) => !state.readOnly,
    run: ({ ui }) => ui.showGetParts(),
  },

  // ── Help ────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'help.shortcuts',
    label: 'Keyboard Shortcuts',
    group: 'Help',
    keys: 'ui.shortcuts',
    run: ({ ui }) => ui.showShortcuts(),
  },
  {
    // Whether an AI agent may drive this editor over MCP (the shell's agent door, docs/agent-tools.md). The
    // switch lives in Settings > Agent connections, where people look for an on/off choice; this opens it there.
    id: 'help.agentConnections',
    label: 'Agent Connections…',
    group: 'Help',
    shellOnly: true,
    run: ({ ui }) => {
      requestAgentDoorReveal()
      ui.showSettings()
    },
  },
  {
    // The tour had exactly one way in: a toolbar icon, hidden on the mobile layout and easy to miss on
    // the desktop one. Everything else this row offers is also in the menu; this was the entry point
    // that existed only as a button, which is the wrong shape for the thing that teaches the app.
    // No chord: it opens its own scene, so a stray keystroke should not start it.
    id: 'help.tutorial',
    label: 'Tutorial: Build Your First Line',
    group: 'Help',
    // the tour builds and tags parts as it goes, so it needs a scene it is allowed to edit
    enabled: (ctx) => !ctx.state.readOnly,
    run: () => requestTutorial(),
  },
  {
    // The browser's door to the installed app (desktopLink.ts): in a room the app joins the same room; solo the project
    // is handed over and opens there as a copy of its own. Says where to get the app when none opens.
    id: 'help.openInDesktop',
    label: 'Open in Desktop App',
    group: 'Help',
    webOnly: true,
    run: ({ store }) => openInDesktopApp(store),
  },
  {
    // what that notice offers, and the palette's way to the download
    id: 'help.getDesktopApp',
    label: 'Get the Desktop App',
    group: 'Help',
    webOnly: true,
    run: () => void window.open(DESKTOP_DOWNLOAD_URL, '_blank', 'noopener'),
  },
]

// ── The i18n transform ────────────────────────────────────────────────────────────────────────────
// Every label goes through core/i18n, and this is the only way `commands` is built, so a new command
// cannot ship an untranslatable label by forgetting a call. That is why this is here and not a lint rule.
//
// Message ids are derived from command ids, which are unique (commands.test.ts asserts it) and stable
// (the native menu dispatches by them), so the message ids are too. Rewording an English label never
// orphans its translations, which is why the key is not the English text.
//
// `label` becomes a getter, not a resolved string. Every surface still reads `cmd.label` unchanged, but
// the read is live: installing a locale after boot re-labels the toolbar, the "⋯" overflow, the scene
// tree's context menu and the palette with nothing to re-register. The desktop menubar is the one
// exception - main.cjs holds a snapshot from desktopMenuModel() - so a locale change must re-post it.

const labelMessageId = (commandId: string): MessageId => `command.${commandId}.label`

function localizeCommand(def: Command): Command {
  const mid = defineMessage(labelMessageId(def.id), def.label)
  return {
    ...def,
    get label(): string {
      return t(mid)
    },
  }
}

export const COMMANDS: readonly Command[] = COMMAND_DEFS.map(localizeCommand)

// Section headings, shared by the palette's group chips and the desktop menubar's section titles: one
// message each, because they name the same thing on two surfaces. 'Window' carries no commands of its
// own (Electron owns that submenu) but still needs its title translated.
const GROUP_MESSAGES: Readonly<Record<string, MessageId>> = Object.fromEntries(
  (['File', 'Edit', 'Simulation', 'View', 'Window', 'Help'] as const).map((g) => [
    g,
    defineMessage(`menu.section.${g}`, g),
  ]),
)

/** The display heading for a command group / desktop menu section. The group value stays identity (it
 *  keys the grouping); this is the only form a surface should render. An undeclared section falls back
 *  to its own name, so an addition reads sensibly before it is declared. */
export function groupLabel(group: string): string {
  const mid = GROUP_MESSAGES[group]
  return mid === undefined ? group : t(mid)
}

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]))

/** The command with this id, or undefined. */
export function getCommand(id: string): Command | undefined {
  return BY_ID.get(id)
}

// ── The live context ──────────────────────────────────────────────────────────────────────────────
// App publishes this every render; everything else reads it. Null before the editor mounts (and in
// unit tests until one is installed), which every entry point below treats as "nothing to run".

let live: CommandCtx | null = null

/** App publishes the current store/controller/state/ui here on each render. */
export function setCommandCtx(ctx: CommandCtx | null): void {
  live = ctx
}

/** Would this command do anything right now? Unknown ids and a missing context read as disabled. */
export function commandEnabled(id: string): boolean {
  const cmd = BY_ID.get(id)
  if (!cmd || !live) return false
  return cmd.enabled ? cmd.enabled(live) : true
}

/**
 * Why a command is greyed out, or null when it is available (or has no command-specific reason -
 * the surface then falls back to its own global explanation). See {@link Command.disabledReason}.
 */
export function commandDisabledReason(id: string): string | null {
  const cmd = BY_ID.get(id)
  if (!cmd || !live || commandEnabled(id)) return null
  return cmd.disabledReason?.(live) ?? null
}

/**
 * Run a command by id. A disabled command is a no-op rather than an error: the same call arrives from
 * a button, a menu item and a native menu whose enabled flag is one IPC hop stale, and none of those
 * should be able to bypass the rule the button obeys.
 */
export function runCommand(id: string): void {
  const cmd = BY_ID.get(id)
  if (!cmd || !live || !commandEnabled(id)) return
  cmd.run(live)
}

/**
 * {@link commandEnabled} and {@link runCommand} for a part command whose subject a surface names (a Scene dock row's
 * icons act on that row's part, selected or not; a catalog card on its package). Every other command ignores it.
 */
export function commandEnabledOn(id: string, target: CommandTarget): boolean {
  const cmd = BY_ID.get(id)
  if (!cmd || !live) return false
  return cmd.enabled ? cmd.enabled({ ...live, target }) : true
}

export function runCommandOn(id: string, target: CommandTarget): void {
  const cmd = BY_ID.get(id)
  if (!cmd || !live || !commandEnabledOn(id, target)) return
  cmd.run({ ...live, target })
}

/** A command arriving from the native menu, by the accelerator or the item clicked. */
export function runMenuCommand(id: string): void {
  runCommand(id)
}

/** The commands a surface should offer, in registry order. `shell` includes the desktop-only ones. */
export function visibleCommands({ shell }: { shell: boolean }): readonly Command[] {
  return COMMANDS.filter((c) => (shell ? !c.webOnly : !c.shellOnly))
}

// ── Chords, for the surfaces that display them ────────────────────────────────────────────────────

/**
 * The chord to print beside a command on this surface, or '' when it has none. In the desktop app it is the
 * native menu's accelerator, which the menu binds. In the browser, which has no menu, it is the keymap action the
 * app binds instead ({@link Command.webKeys}), because F5 there reloads the page.
 */
export function commandChord(cmd: Command, desktop: boolean = DESKTOP_SHELL): string {
  if (cmd.accelerator && (desktop || !cmd.webKeys)) return acceleratorHint(cmd.accelerator)
  return primaryKey(cmd.webKeys ?? cmd.keys)
}

const KEY_LABELS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Slash: '/',
  Period: '.',
  Comma: ',',
  Minus: '-',
  Equal: '=',
}

/**
 * One chord of a keymap action as an Electron accelerator ('CmdOrCtrl+Shift+Z'), or null when the key
 * has no accelerator spelling. Conservative, because Electron logs and drops an accelerator it
 * can't parse, so an unmapped key is better shown as no hint at all than as a wrong one.
 */
export function acceleratorFor(action: KeyActionId): string | null {
  const chord = activeBinding(action)?.keys[0]
  if (!chord) return null
  const parts = chord.split('+')
  const key = parts.pop() ?? ''
  const mods = parts.map((m) => ({ ctrl: 'CmdOrCtrl', shift: 'Shift', alt: 'Alt', meta: 'Cmd' })[m]).filter(Boolean)
  if (mods.length !== parts.length) return null
  const named =
    /^Key([A-Z])$/.exec(key)?.[1] ??
    /^Digit(\d)$/.exec(key)?.[1] ??
    KEY_LABELS[key] ??
    (/^(F\d{1,2}|Delete|Backspace|Escape|Tab|Enter|Space|Home|End|PageUp|PageDown)$/.test(key) ? key : null)
  return named ? [...mods, named].join('+') : null
}

// ── The desktop menu ──────────────────────────────────────────────────────────────────────────────
// Structure lives here, beside the commands, so a menu can't name an action that doesn't exist. Main
// only renders it: `command` items dispatch back by id, `role` items are Electron's own (reload, zoom,
// window), and `shell` items are the handful main owns outright because they never touch the document.

export type MenuNode =
  | { command: string }
  | { separator: true }
  | { role: string; label?: string; accelerator?: string }
  | { shell: 'recent' | 'quit' | 'docs' | 'github' | 'issues' | 'updates' | 'licenses' | 'about' }

export interface MenuSection {
  label: string
  /**
   * Electron role for a whole submenu (help), instead of `items` - or, with `items`, the submenu's own role: `window`
   * marks it as macOS's Window menu, which the platform fills with the list of open windows.
   */
  role?: string
  items?: MenuNode[]
}

export const DESKTOP_MENU: readonly MenuSection[] = [
  {
    label: 'File',
    items: [
      // the project's own block, then its file round trip, in the project menu's order (ProjectMenu.tsx), so the two
      // surfaces read alike; the PLC program's commands are a block of their own, not mixed in with the project's
      { command: 'file.newProject' },
      { command: 'file.projects' },
      { command: 'file.renameProject' },
      { command: 'file.save' },
      { separator: true },
      { command: 'file.importProject' },
      { command: 'file.exportProject' },
      { command: 'file.copyRoom' },
      { separator: true },
      { command: 'file.openDemo' },
      { separator: true },
      { command: 'file.importPlc' },
      { command: 'file.exportPlcSt' },
      { command: 'file.exportPlcXml' },
      { separator: true },
      { command: 'file.openProject' },
      // main renders this one: it owns the list (apps/desktop/folderRegistry.cjs)
      { shell: 'recent' },
      { command: 'file.saveProject' },
      { command: 'file.showProjectFolder' },
      { separator: true },
      { command: 'file.getParts' },
      { separator: true },
      { shell: 'quit' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { command: 'edit.undo' },
      { command: 'edit.redo' },
      { separator: true },
      { command: 'edit.cut' },
      { command: 'edit.copy' },
      { command: 'edit.paste' },
      { command: 'edit.duplicate' },
      { command: 'edit.copyProperties' },
      { command: 'edit.pasteProperties' },
      { command: 'edit.delete' },
      { separator: true },
      { command: 'edit.selectAll' },
      { command: 'edit.guardOpenings' },
    ],
  },
  {
    label: 'Simulation',
    items: [
      { command: 'sim.run' },
      { command: 'sim.pause' },
      { command: 'sim.step' },
      { command: 'sim.stop' },
      { command: 'sim.reloadProgram' },
      { command: 'sim.externalPlc' },
      { separator: true },
      { command: 'sim.pilot' },
      { separator: true },
      // Listed, not cycled: a menu that changes a setting without showing which one is current is a
      // menu you have to click and then go look at the toolbar to read. The rungs carry their own
      // values instead. (No radio tick: the model is pushed once at startup and only {id: enabled}
      // moves after, so a checked flag here would be stale the moment the speed changed.)
      ...SIM_SPEEDS.map((v) => ({ command: speedCommandId(v) })),
    ],
  },
  {
    label: 'View',
    items: [
      { command: 'view.commandPalette' },
      { command: 'view.plc' },
      { command: 'view.problems' },
      { command: 'view.watch' },
      { command: 'view.settings' },
      { command: 'view.distractionFree' },
      { command: 'view.resetLayout' },
      { separator: true },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { separator: true },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { separator: true },
      { role: 'togglefullscreen' },
    ],
  },
  {
    // Spelled out rather than Electron's `windowMenu` role, whose Close item claims Ctrl+W, the browser's and
    // many editors' close-tab chord. Close keeps a chord, one step further away. What the role gave macOS stays:
    // `window` keeps the list of open windows (a popped-out ladder is found and raised there), and Zoom and
    // Bring All to Front are its items; main drops those two elsewhere (MAC_ONLY_ROLES).
    label: 'Window',
    role: 'window',
    items: [
      { role: 'minimize' },
      { role: 'zoom' },
      { separator: true },
      { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
      { separator: true },
      { role: 'front' },
    ],
  },
  {
    label: 'Help',
    items: [
      { command: 'help.shortcuts' },
      { command: 'help.tutorial' },
      { command: 'help.agentConnections' },
      { separator: true },
      { shell: 'docs' },
      { shell: 'github' },
      { shell: 'issues' },
      { shell: 'updates' },
      { shell: 'licenses' },
      { shell: 'about' },
    ],
  },
]

/** One menu item as main needs it: what to draw, what to send back, and who owns the chord. */
export interface MenuModelItem {
  type: 'command' | 'separator' | 'role' | 'shell'
  id?: string
  label?: string
  role?: string
  accelerator?: string
  /** false → main displays the accelerator but must NOT register it (the app's keydown owns that key) */
  register?: boolean
  enabled?: boolean
}

export interface MenuModelSection {
  label: string
  role?: string
  items?: MenuModelItem[]
}

/**
 * DESKTOP_MENU resolved against the registry - labels, accelerators and current enablement - as the
 * plain data main.cjs builds its Menu from. Sent once on mount; enablement afterwards rides the
 * cheaper {id: boolean} channel (see menuEnablement).
 */
export function desktopMenuModel(): MenuModelSection[] {
  return DESKTOP_MENU.map((section) => ({
    label: groupLabel(section.label),
    ...(section.role ? { role: section.role } : {}),
    ...(section.items
      ? {
          items: section.items.map((node): MenuModelItem => {
            if ('separator' in node) return { type: 'separator' }
            if ('role' in node) return { type: 'role', role: node.role, ...(node.label ? { label: node.label } : {}), ...(node.accelerator ? { accelerator: node.accelerator } : {}) }
            if ('shell' in node) return { type: 'shell', id: node.shell }
            const cmd = BY_ID.get(node.command)
            if (!cmd) return { type: 'separator' } // commands.test.ts makes this unreachable
            const accelerator = cmd.accelerator ?? (cmd.keys ? acceleratorFor(cmd.keys) : null)
            return {
              type: 'command',
              id: cmd.id,
              label: cmd.label,
              ...(accelerator ? { accelerator, register: !!cmd.accelerator } : {}),
              enabled: commandEnabled(cmd.id),
            }
          }),
        }
      : {}),
  }))
}

/** {id: enabled} for every command the desktop menu shows - the payload main flips its items with. */
export function menuEnablement(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const section of DESKTOP_MENU) {
    for (const node of section.items ?? []) {
      if ('command' in node) out[node.command] = commandEnabled(node.command)
    }
  }
  return out
}
