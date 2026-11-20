import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import {
  commsTags,
  controllerFor,
  declaresConfiguration,
  defaultController,
  parseDocument,
  topLevelStatements,
  type DocumentEdit,
  type StBlock,
  type TagRename,
  type WatchInstance,
  watchInstances,
  watchScopes,
} from '../../../plc'
import type { Controller } from '../../../core/controller'
import { dialectRefusal, foreignDialectNote, isKnownDialect } from '../../../core/dialect'
import { resolveKeyAction } from '../../../core/keymap'
import { askName } from '../../nameDialog'
import { commandDisabledReason, commandEnabled, runCommand } from '../../commands'
import { commitControllerEdit } from '../../program/controllerCommit'
import { getCollabContext, subscribeCollab } from '../../../collab/session'
import type { EditorController } from '../../controller'
import type { EditorState, EditorStore } from '../../store/store'
import { dockPanelTitle } from '../../dockLayout'
import { blockAt, blockOffset, blockStarts } from '../../program/stReveal'
import type { StCodeEditorHandle } from './StCodeEditor'
import { StFileReport, type StFileReportData } from './StFileReport'
import { controllerDiagnostics } from '../../../plc'
import { readLadder } from '../../../plc/ladder/ladderRungs'
import { ladderMarks, ladderRoutineOf, mixesLanguages, NO_LADDER, openingFace, sameLadderMarks, type LadderMarks } from '../../program/ladderMarks'
import type { TagScope } from '../../../plc/tags'
import { typeNamesOf, type OrganizerFacts } from '../../program/plcOrganizer'
import { PanelLadder, PanelOrganizer, renameDeclaration, type PlcFace, type PlcPanelCtx } from './plcPanelParts'
import { usePlcPanelWindow } from './plcPanelWindow'
import { usePlcFaults } from './plcFaults'
import { PlcFileMenu } from './PlcFileMenu'
import { providePlcReading } from '../../program/plcReading'
import { CheckIcon, CopyIcon, DockIcon, ExternalLinkIcon, FoldIcon, MaximizeIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'
import { ContextMenu, type MenuItem } from '../inspector/menu'
import { IS_MAC, primaryKey } from '../../keyHint'
import { JumpHistory } from '../../program/jumpHistory'
import { activeClipboard } from '../../dialogHost'
import { addToWatchList, resolveWatch, tabWatchListKey } from '../../program/plcWatchList'
import { canEditDisplay, displayedValues, displayListFull, setDisplayed } from '../../program/displayValues'
import { MAX_DISPLAY_VALUES } from '../../../core/scene/sceneDisplay'

const M = defineMessages('stEditor', {
  viewOnlyLink: 'Disabled on a view-only link',
  needsDesktop: 'Editing the program needs a desktop layout. This sheet shows it running',
  nothingToRename: 'Nothing to rename here',
  nothingToRenameDetail: "Put the caret on a name (a variable's declaration, or any use of it) and press F2 again.",
  theController: 'the controller',
  renameTitle: 'Rename {name}',
  renameIntro: "Every use of it in {where} follows, and so does the scene's wiring.",
  rename: 'Rename',
  notRenamed: '{name} was not renamed',
  noDefinition: 'No definition here',
  noDefinitionDetail: 'Put the caret on a name the program declares (a variable, a member, a block, a function or a type) and press {keys} again.',
  goToDefinition: 'Go to definition',
  goToDefinitionOf: 'Go to definition of {name}',
  goBack: 'Go back',
  goForward: 'Go forward',
  foldDeclarations: 'Fold all declarations',
  foldDeclarationsHint: 'Collapse every VAR section, TYPE and STRUCT, leaving the statements',
  unfoldAll: 'Unfold all',
  notRunning: 'The program is not running',
  reloadAttached:
    'Your edits are not running yet. Reload restarts the program with them (Ctrl/Cmd-Enter): its timers, counters and steps start over, the scene carries on',
  reloadIdle: 'No program is running. Reload starts the one on screen (Ctrl/Cmd-Enter)',
  reload: 'Reload',
  hideOrganizer: 'Hide the organizer: the program as a tree of tasks, programs and types',
  showOrganizer: 'Show the organizer: the program as a tree of tasks, programs and types',
  organizer: 'Organizer',
  addNameToWatch: 'Add {name} to Watch',
  showNameOnDisplays: 'Show {name} on displays',
  hideNameOnDisplays: 'Stop showing {name} on displays',
  showOnDisplays: 'Show on displays',
  showOnDisplaysHint: "Put its live value beside the scene on the project's displays",
  displayFull: 'A display lists at most {count} values. Take one off to add another.',
  addToWatch: 'Add to Watch',
  addToWatchHint: 'Follow its live value in the Watch dock',
  addToWatchNone: 'Right-click a variable to watch it',
  forceName: 'Force {name}',
  forceHint: 'Hold it at its current value across scans until released, whatever the program writes',
  releaseName: 'Release {name}',
  releaseHint: 'Let the program write it again',
  notForced: '{name} was not forced',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  pasteRefused: 'The browser did not hand over the clipboard',
  pasteRefusedDetail: 'Press {keys} in the code to paste instead.',
  programView: 'Program view',
  textTitle: 'The program as Structured Text',
  text: 'Text',
  ladderTitle: "The program's LADDER sections, drawn as rungs",
  ladder: 'Ladder',
  returnToDock: 'Put the PLC panel back in the main window',
  popoutDocked: 'Open the PLC panel in a window of its own (drag it to another monitor)',
  resizeOrganizer: 'Resize the organizer',
  copyProgram: 'Copy the program as plain-text Structured Text',
  overrunTitle:
    "A task's interval is shorter than the simulator can scan at this step rate, so scans were dropped and PLC timers lag sim time. Lengthen the task interval, or raise the step rate, for steady timing.",
  overruns: {
    one: '{count} scan overrun. Lengthen the task interval for steady timing',
    other: '{count} scan overruns. Lengthen the task interval for steady timing',
  },
  showTasks: 'Show tasks',
  showFault: 'Show where it faulted',
  unboundTags: "Unbound tags (set a part's “PLC tag” to match): {tags}",
  unwiredTags: "Wired to nothing in the program (typo on the part's “PLC tag”?): {tags}",
  unconnected: {
    one: '{count} tag not connected between the program and the parts -',
    other: '{count} tags not connected between the program and the parts -',
  },
  showInProblems: 'Show in Problems',
  externalPlc:
    'An external PLC runs this project when you press Play (Controller Properties), so the program here does not run.',
  viewOnlyTip: 'This is the program driving the scene. Press Play and live values appear inline beside each variable.',
  tip: 'Tip: wire devices by setting their “PLC tag” in the Inspector, then press Play. Operate buttons with C / click. Live values show inline beside each variable while running.',
  dragToMove: 'Drag to move · click to collapse',
  maximizeTitle: 'Maximize (Esc to restore)',
  maximize: 'Maximize panel',
  popoutTitle: 'Open in a separate window (drag it to another monitor)',
  popout: 'Pop out to a window',
  dockTitle: 'Dock this panel into the layout',
  dock: 'Dock panel',
  dragToResize: 'Drag to resize',
})

// LAZY: the rung editor is a sizeable chunk that nobody needs before the PLC panel's Ladder view is opened, and the
// build budgets what loads before the first frame (scripts/lib/eager-js.mjs, eager JS)
// LAZY for the same reason, and it was the single biggest thing in that budget that did not belong there: the text
// editor drags CodeMirror in with it (view + state + language + autocomplete + search + lint + commands + lezer,
// ~330 KB raw / ~95 KB brotli as measured by `npm run eager-census`), and none of it can be used before
// a reader opens the PLC panel. The handle is reached through `editorRef.current?.` everywhere, with the persisted
// source as the fallback, so the frames before the chunk lands behave exactly like the frames before mount did.
const StCodeEditor = lazy(() => import('./StCodeEditor').then((m) => ({ default: m.StCodeEditor })))
// (the organizer tree beside the code and the ladder face are lazy too: plcPanelParts.tsx)

/** Which face to open a program on, and on which ladder section: the POU its controller runs first decides
 *  (ladderMarks.ts `openingFace`), so a controller that runs a ladder opens on rungs. Read every time, never
 *  remembered (see PlcFace). */
function openingFaceOf(source: string, controller: Controller | null): { face: PlcFace; routine: number | null } {
  const o = openingFace(source, parseDocument(source).blocks, controller)
  return { face: o.ladder ? 'ladder' : 'text', routine: o.routine }
}

/** How long the organizer waits after an edit before re-deriving its ladder marks; the delay the inline linter waits to
 *  re-check the program, for the same reason (stLang.ts). `ladderMarks` parses, so it cannot ride a keystroke. */
const LADDER_MARK_DELAY_MS = 250

/** the view's spatial toolbar, which draws ABOVE the floating window on purpose (see its z-index in styles.css) */
interface StEditorProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
  /** when docked, the panel fills its dock slot (no floating window chrome) */
  docked?: boolean
  /**
   * Read-the-program surface: the code, its POU index and the PLC status, with every command
   * that WRITES dropped. This is the mobile PLC sheet (App), where the program runs on Play
   * but a phone keyboard is no way to author ST.
   *
   * Not `store.setReadOnly` - that flag is the collaborative view-only link and
   * gates scene edits too, so borrowing it for a layout would quietly make a tablet unable to
   * edit its own scene. This prop only ever narrows THIS panel.
   */
  viewOnly?: boolean
  /** floating-only: dock the panel into the layout */
  onDock?: () => void
  /** floating-only: blow the panel up to fill the shell below the toolbar (dockLayout.maximized).
   *  Restoring returns it to this floating window, so it's a zoom, not a relocation. */
  onMaximize?: () => void
  /** floating-only: hand the panel to an OS window of its own, which can live on another
   *  monitor. Closing that window brings it back where it came from (see App). */
  onPopout?: () => void
  /** floating-only: the element the window must stay inside (App passes the 3D view, so the window never covers a
   *  dock). The browser window when absent. */
  boundsRef?: { readonly current: HTMLElement | null }
  /** docked: pop the panel out into a window of its own (the floating panel has onPopout for the same) */
  onPopoutDocked?: () => void
  /** in a window of its own: put the panel back in the dock it came from */
  onReturnToDock?: () => void
}

const panel: CSSProperties = {
  position: 'fixed',
  display: 'flex',
  flexDirection: 'column',
  background: 'light-dark(#f7f7f8, #1f2023)',
  border: '1px solid var(--line-soft)',
  borderRadius: 8,
  boxShadow: '0 6px 24px light-dark(rgba(0, 0, 0, 0.16), rgba(0,0,0,0.4))',
  color: 'var(--text-strong)',
  font: '12px ui-sans-serif, system-ui, sans-serif',
  zIndex: 30,
  overflow: 'hidden',
}
const header: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'light-dark(#eeeff1, #26282c)', cursor: 'grab', userSelect: 'none', touchAction: 'none' }
// the body fills the panel; the editor grows (flex:1) while the controls keep their
// natural size (flexShrink:0), so the buttons stay put and the editor takes the rest
// (--plc-pad-top: 0 in a popped-out desktop window, whose header row is its title bar and so sits on the top edge)
const body: CSSProperties = { padding: 'var(--plc-pad-top, 10px) 10px 10px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, overflow: 'hidden' }
// the editor + its floating copy affordance share a positioning context so the icon can pin
// to the top-right corner of the CodeMirror surface (inset from the scrollbar/gutter)
const editorWrap: CSSProperties = { position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
// the copy icon is pinned to the code, not to the panel, so it lives in here with the editor
// rather than in editorWrap - otherwise the header row above would slide under it
const editorHostWrap: CSSProperties = { position: 'relative', display: 'flex', flex: 1, minHeight: 0 }
const editorHost: CSSProperties = { width: '100%', flex: 1, minHeight: 0 }
// The one row of chrome over the code: the organizer's toggle, then Reload / File at its right end. The commands had a row
// of their own under the code once, 48px of a docked panel whose code is the thing short of height.
const headerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexShrink: 0,
  borderBottom: '1px solid var(--divider)',
  background: 'light-dark(#f4f4f5, #212327)',
}
// The organizer and the code, side by side under the header row. Relative, so a narrow panel can draw the organizer
// OVER the code instead (see `narrow`).
const workRow: CSSProperties = { position: 'relative', display: 'flex', flex: 1, minHeight: 0 }
const codeCol: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }
// a program this build cannot read, said over it for as long as it is on screen, not only when Play refuses it
const dialectBanner: CSSProperties = { flexShrink: 0, padding: '4px 8px', color: 'var(--warn)', background: 'light-dark(#f4f4f5, #212327)', borderBottom: '1px solid var(--divider)' }
// a status line's way to the dock that fixes it
const linkBtn: CSSProperties = { border: 'none', background: 'transparent', color: 'light-dark(#276cdc, #8ab4f8)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }

/**
 * The program's file commands, behind the controls row's File button. They are COMMANDS (commands.ts), the same ones the File menu
 * and the palette run, so what greys one out greys out all of them; a row of four buttons of their own took the height
 * a docked panel's code needs. The hints are this panel's longer word on each.
 */

/** The block ladder section `routine` stands in: the POU a sheet opened on it is showing. */
function routineBlock(source: string, blocks: StBlock[], routine: number): number {
  const start = readLadder(source)[routine]?.start
  return start === undefined ? -1 : blockAt(blockStarts(source, blocks), start)
}

/** kinds+names, the only change that alters the organizer's index - text edits inside a block do not. */
const blockSignature = (blocks: StBlock[]): string => blocks.map((b) => `${b.kind}:${b.name}`).join('|')

/**
 * The organizer's place in the panel: shown or not, and how wide, remembered per browser. A convenience, so a storage
 * that throws (a private window, blocked site data) just means the defaults.
 */
interface OrganizerPref {
  open: boolean
  width: number
}
const ORGANIZER_KEY = 'oip-web/plc-organizer'
const ORGANIZER_WIDTH = { min: 150, max: 420, initial: 220 }
/** Below this the panel cannot hold the organizer beside the code: it is drawn over the code, and a pick closes it. */
const NARROW_BELOW = 560
function readOrganizerPref(): OrganizerPref {
  try {
    const v = JSON.parse(localStorage.getItem(ORGANIZER_KEY) ?? 'null') as Partial<OrganizerPref> | null
    const width = typeof v?.width === 'number' && Number.isFinite(v.width) ? v.width : ORGANIZER_WIDTH.initial
    return { open: typeof v?.open === 'boolean' ? v.open : true, width: Math.min(ORGANIZER_WIDTH.max, Math.max(ORGANIZER_WIDTH.min, width)) }
  } catch {
    return { open: true, width: ORGANIZER_WIDTH.initial }
  }
}
function saveOrganizerPref(p: OrganizerPref): void {
  try {
    localStorage.setItem(ORGANIZER_KEY, JSON.stringify(p))
  } catch {
    // not remembered: the next visit opens on the defaults
  }
}

/** What the organizer's task section shows: the table the program runs from, and what is wrong with it. */
interface TableFacts {
  /** the scene's own table, or the default one a program with none runs from */
  shown: Controller
  /** the code declares its own CONFIGURATION, which then decides the tasks */
  ownConfiguration: boolean
  /** the running table's own problems (the program's go to the gutter) */
  problems: string[]
}
/** Parses (twice, with the check), so it is for a quiet period after an edit, not a keystroke. */
function tableFactsOf(source: string, controller: Controller | null, scanMs: number, defaultName: string): TableFacts {
  const running = controllerFor(source, controller, scanMs)
  return {
    shown: controller ?? defaultController(source, scanMs),
    ownConfiguration: !controller && declaresConfiguration(source),
    problems: running ? controllerDiagnostics(source, running, { defaultName }).controller : [],
  }
}
const sameTableFacts = (a: TableFacts, b: TableFacts): boolean =>
  a.ownConfiguration === b.ownConfiguration && a.problems.join('\n') === b.problems.join('\n') && JSON.stringify(a.shown) === JSON.stringify(b.shown)
const sameTypeNames = (a: ReadonlyMap<number, readonly string[]>, b: ReadonlyMap<number, readonly string[]>): boolean =>
  JSON.stringify([...a]) === JSON.stringify([...b])

// always-visible (touch has no hover) but dimmed until hover/copy so it never competes with the
// code; the wrapper's :hover lift is done inline via onPointer events would be heavier, so we keep
// it at a readable resting opacity. Copying confirms by swapping the glyph to a checkmark.
const copyIcon: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 22,
  zIndex: 1,
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  borderRadius: 4,
  border: '1px solid var(--line-soft)',
  background: 'light-dark(rgba(238, 239, 241, 0.82), rgba(38,40,44,0.82))',
  color: 'light-dark(#282b2f, #cfd2d6)',
  cursor: 'pointer',
  opacity: 0.55,
  font: '13px ui-sans-serif, system-ui, sans-serif',
}
// docked: fill the dock slot instead of floating (the DockSlot tab strip supplies the title)
const dockRoot: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
  background: 'light-dark(#f7f7f8, #1f2023)',
  color: 'var(--text-strong)',
  font: '12px ui-sans-serif, system-ui, sans-serif',
  overflow: 'hidden',
}
const dockBtn: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'light-dark(#282b2f, #cfd2d6)',
  cursor: 'pointer',
  padding: '0 4px',
  font: '13px ui-sans-serif, system-ui, sans-serif',
}
// the status lines under the code: capped and scrolled, or in a short docked panel a long list of bind warnings
// pushes the code editor down to no height at all
const controls: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, maxHeight: '40%', overflowY: 'auto' }
// the commands at the header row's right end (marginLeft: auto keeps them there whatever stands to their left)
const commandGroup: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flex: 'none', marginLeft: 'auto', padding: '3px 6px' }
// sized to the toggle beside them, so the row stays one control tall
const btn: CSSProperties = { padding: '2px 12px', borderRadius: 3, border: '1px solid var(--line-soft)', background: 'var(--control)', color: 'var(--text-strong)', cursor: 'pointer', font: 'inherit' }
// Reload, lit: the running program is not the text on screen. Dimmed otherwise, explicitly: `btn` names its own colour,
// which beats the browser's disabled look, so a disabled button in it reads exactly like an enabled one.
// (the whole `border`, not borderColor: React warns when a re-render swaps a longhand against `btn`'s shorthand)
// (its own text colour: `btn`'s --text-strong is near-black in the light theme, unreadable on this green)
const reloadLit: CSSProperties = { background: '#1f6f3a', border: '1px solid #2f8a4f', color: 'light-dark(#ffffff, #e6e6e6)' }
const reloadIdle: CSSProperties = { opacity: 0.45, cursor: 'default' }
// a grip in the bottom-right corner; two diagonal ticks drawn with a gradient
const grip: CSSProperties = {
  position: 'absolute',
  right: 2,
  bottom: 2,
  width: 16,
  height: 16,
  cursor: 'nwse-resize',
  touchAction: 'none',
  background: 'linear-gradient(135deg, transparent 0 7px, light-dark(#a0a4aa, #5b5f66) 7px 8px, transparent 8px 10px, light-dark(#a0a4aa, #5b5f66) 10px 11px, transparent 11px)',
}

export function StEditor({ store, state, controller, docked = false, viewOnly = false, onDock, onMaximize, onPopout, boundsRef, onPopoutDocked, onReturnToDock }: StEditorProps): ReactElement {
  // the floating window (plcPanelWindow.ts)
  const { geom, collapsed, floatRef, header: headerDrag, grip: gripDrag } = usePlcPanelWindow(docked, boundsRef)
  // position + size persist together; default clears the top-left spatial toolbar
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The result of the last file crossing the import/export door (or of a program command), kept OUT of `error`.
   *
   * Two reasons it cannot share that state. A note about what a target may not carry is not an
   * error - the file is fine - and `error` is mirrored wholesale from the PLC status on every
   * attach/detach/rebind (see the effect below), so anything parked there is wiped at a moment
   * that has nothing to do with the transfer. An IMPORT FAILURE rides here too for that second
   * reason: "could not import cell.xml, here is why" is the one message that must survive the
   * next attach, since the reader is about to go and act on it.
   *
   * It is a list, not a line: the importers name each construct the subset cannot hold along
   * with what to do about it, and StFileReport draws them as a checklist. And it lives in the
   * store (state.stFileReport), not here: the transfers are commands the File menu and the palette
   * run while this panel may not be mounted (editor/program/stFileTransfer.ts). The store stamps each
   * report's id, the key that resets the checklist's ticks.
   */
  const report = state.stFileReport
  const showReport = (r: Omit<StFileReportData, 'id'>): void => store.showStFileReport(r)
  const [unbound, setUnbound] = useState<string[]>([])
  const [unwired, setUnwired] = useState<string[]>([]) // scene tags the program never names (typo?)
  const [warnings, setWarnings] = useState<string[]>([]) // soft bind issues (type/duplicate)
  const [attached, setAttached] = useState(false)
  // cumulative scan overruns since the running program started. The scan interleaves with the
  // physics steps in the sim worker, so this only climbs when the cycle time is set below what
  // one physics step can drain (sim/plcHost.ts) - the cue to raise scan time
  const [overruns, setOverruns] = useState(0)
  // which instance's values the code shows for a PROGRAM that runs as several, by type upper-cased: picked on the
  // organizer's instance rows or the chip on the PROGRAM's header (plc/watchScope.ts). Not the document's: a view.
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({})
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const [pickInstance] = useState(() => (type: string, instance: string) => setPicked((was) => ({ ...was, [type.toUpperCase()]: instance })))
  // collaborative room binding (null in solo mode): the shared ST Y.Text + its CodeMirror
  // extension. In a room CodeMirror binds STRAIGHT to the shared text (that's what makes
  // co-editing work); the store mirrors it so everything else has one place to read. Followed, not read once: Share
  // can take a solo tab into a room without a reload (editor/roomEntry.ts), and the code editor then remounts on it.
  const collab = useSyncExternalStore(subscribeCollab, getCollabContext)
  // the program to seed the editor with, read once on mount - from the store, which the boot path
  // has already loaded from whichever document owns it (project, room, demo)
  const [initialSource] = useState(() => store.getState().stProgram)
  const ctrlRef = useRef(controller)
  ctrlRef.current = controller
  // What hears a force set or released. Kept here and fed from the controller once there is one: a subscriber that
  // arrives before the viewport makes the controller (the Devices list, memoised once) would otherwise never hear one.
  const forceListeners = useRef(new Set<() => void>())
  useEffect(() => controller?.onPlcForces(() => { for (const cb of forceListeners.current) cb() }), [controller])
  // ...and what hears a program attach or detach, relayed the same way
  const statusListeners = useRef(new Set<() => void>())
  useEffect(() => controller?.onProgramStatus(() => { for (const cb of statusListeners.current) cb() }), [controller])
  // CodeMirror owns the buffer; sourceRef mirrors it for the run/attach handlers
  const editorRef = useRef<StCodeEditorHandle>(null)
  const sourceRef = useRef(initialSource)
  // the POU index the organizer lists; see refreshBlocks for why it is not recomputed per render
  const [blocks, setBlocks] = useState<StBlock[]>(() => parseDocument(initialSource).blocks)
  const blockSigRef = useRef(blockSignature(blocks))
  // Where each block starts in the CURRENT text. Kept apart from `blocks`, whose text goes stale while typing inside a
  // block leaves the signature alone, and refreshed on every edit, so a cursor move or a scroll never parses.
  const startsRef = useRef(blockStarts(initialSource, blocks))
  // the block the reader is in, whose row the organizer marks: the text editor's reading position while the text shows
  // (onReadingPosition), the POU opened while the rungs do - the hidden text editor's cursor says nothing about those
  const [activeBlock, setActiveBlock] = useState(() => {
    const o = openingFaceOf(initialSource, store.getState().controller)
    return o.face === 'ladder' && o.routine !== null ? routineBlock(initialSource, blocks, o.routine) : -1
  })
  // Which POUs hold a ladder and which ARE one: the organizer's language tags, and what opening a POU opens.
  // Re-derived on a quiet period after an edit rather than per keystroke (`scheduleMarks`) - it parses the whole
  // program, which is 12x the cost of the block split beside it.
  const [marks, setMarks] = useState<LadderMarks>(() => ladderMarks(initialSource, blocks))
  // ...and whether the code outside every POU has statements, which decides what its row and the task table say about
  // it (taskTree.ts). Parses too, so it rides the same quiet period, as do the names a TYPE block's row reads and the
  // task table the organizer shows (with its problems, which take the checker).
  const [bodyRuns, setBodyRuns] = useState(() => topLevelStatements(initialSource))
  const [typeNames, setTypeNames] = useState<ReadonlyMap<number, readonly string[]>>(() => typeNamesOf(blocks))
  const [tableFacts, setTableFacts] = useState(() => tableFactsOf(initialSource, store.getState().controller, store.getState().stScanMs, store.getState().externalPlc.mainName))
  // The ladder view draws from React state, which the text view has none of (a keystroke must not
  // re-render this panel), so the source is mirrored into state ONLY while the ladder is what is showing.
  // The face the panel opens on is its main POU's (`openingFace`), so a controller that runs a ladder opens on rungs.
  const [opening] = useState(() => openingFaceOf(initialSource, store.getState().controller))
  const [view, setViewState] = useState<PlcFace>(opening.face)
  const viewRef = useRef(view)
  const [ladderSource, setLadderSource] = useState(initialSource)
  // a section the organizer asked the ladder view to show; first, the one the panel opened on
  const [revealRoutine, setRevealRoutine] = useState<number | null>(opening.routine)
  const setView = (v: PlcFace): void => {
    viewRef.current = v
    setViewState(v)
    if (v === 'ladder') setLadderSource(editorRef.current?.getValue() ?? sourceRef.current)
  }
  // The organizer beside the code: whether it is shown and how wide (remembered), and whether the panel is too narrow to
  // hold it beside the code, when it is drawn OVER the code instead and starts closed.
  const [organizer, setOrganizer] = useState(readOrganizerPref)
  const [narrow, setNarrow] = useState(false)
  const narrowRef = useRef(narrow)
  narrowRef.current = narrow
  const [overlayOpen, setOverlayOpen] = useState(false)
  const organizerShown = narrow ? overlayOpen : organizer.open
  const workRef = useRef<HTMLDivElement>(null)
  // bumped to bring the organizer's Tasks into view (Problems, and this panel's own "Show tasks" links)
  const [revealTasks, setRevealTasks] = useState(0)
  // A code reveal that came before the lazy text editor did: a jump from a background tab mounts this panel, and the
  // editor's chunk lands after it, so the store's replay of the request finds no editor yet. Served on its onReady.
  const pendingReveal = useRef<number | null>(null)
  // the same for a dock-tab click's focus request (store.focusStCode)
  const pendingFocus = useRef(false)
  // the File command menu: placed by its top edge (opening down from ⋯, which sits in the header row) or, when a short
  // dock leaves no room below, by its bottom edge
  // the attach error is the controller table's, so the line under the code points at the organizer's tasks
  const [errorInController, setErrorInController] = useState(false)
  // Two independent reasons the program can't be written from here: a collaborative view-only
  // link (state.readOnly, which gates the scene too) and this panel being the read-only mobile
  // sheet. They disable the same controls but for different reasons, so the disabled tooltips
  // say which one is in force.
  // A program written for a dialect this build does not have (core/dialect.ts): shown, kept byte for byte, never read
  // as IEC - so nothing here may write it, and neither the lint nor the ladder has anything true to say about it.
  const foreignDialect = isKnownDialect(state.stDialect) ? null : (state.stDialect ?? null)
  const readOnly = state.readOnly || viewOnly || foreignDialect !== null
  const readOnlyNote = state.readOnly
    ? t(M.viewOnlyLink)
    : foreignDialect !== null
      ? foreignDialectNote(foreignDialect)
      : t(M.needsDesktop)
  // latest scene, read lazily by the editor's tag autocomplete
  const stateRef = useRef(state)
  stateRef.current = state
  // The PROGRAMs the scene's stored controller runs, for marking the rows of those it does not. With no stored table
  // every PROGRAM runs (the default table), or the code's own CONFIGURATION decides, so nothing is marked.
  const scheduled = useMemo(
    () => (state.controller ? new Set(state.controller.programs.flatMap((p) => (p.type === undefined ? [] : [p.type.toUpperCase()]))) : null),
    [state.controller],
  )
  // the Text/Ladder switch, only while some POU has both faces (see PlcFace)
  const showViewSwitch = mixesLanguages(marks)
  const facts: OrganizerFacts = useMemo(() => ({ marks, bodyRuns, typeNames, scheduled }), [marks, bodyRuns, typeNames, scheduled])

  // Hand a keystroke to the store, which owns the program and decides where it is kept (solo:
  // localStorage + the project doc; room: the shared Y.Text). setStProgram does not
  // broadcast back - this editor produced the change and owns its own buffer.
  const persistSource = (src: string): void => {
    sourceRef.current = src
    store.setStProgram(src)
    refreshBlocks(src)
    if (viewRef.current === 'ladder') setLadderSource(src)
  }

  /** A ladder edit: the whole program back with the rungs reprinted in it. Through the text editor, as ONE ordinary
   *  edit there, so it is a step in the same undo history and reaches a room through the same binding as typing. */
  const applyLadderEdit = (next: string): void => {
    if (editorRef.current) editorRef.current.edit(next) // its change listener persists
    else persistSource(next)
  }

  /**
   * Re-derive the organizer's ladder marks (and the rest of what it shows that takes a parse) once the typing stops. They cannot ride `refreshBlocks` the way the block
   * split does - `ladderMarks` parses the program - and they do not need to: the set of POUs that hold ladder
   * changes when someone writes or deletes a section, not continuously, so a quarter-second lag behind the text is
   * invisible. The timer carries no state of its own: it reads the editor's current buffer and re-splits it, so a
   * fire that lands between an edit and its render still marks the blocks of the text it measured.
   */
  const marksTimer = useRef(0)
  const scheduleMarks = (): void => {
    window.clearTimeout(marksTimer.current)
    marksTimer.current = window.setTimeout(() => {
      const src = editorRef.current?.getValue() ?? sourceRef.current
      const next = ladderMarks(src, parseDocument(src).blocks)
      // an unchanged set keeps the old object, so a pause in typing does not re-render the organizer
      setMarks((cur) => (sameLadderMarks(cur, next) ? cur : next))
      setBodyRuns(topLevelStatements(src)) // a boolean: the same answer re-renders nothing
      const names = typeNamesOf(parseDocument(src).blocks)
      setTypeNames((cur) => (sameTypeNames(cur, names) ? cur : names))
      const s = store.getState()
      const table = tableFactsOf(src, s.controller, s.stScanMs, s.externalPlc.mainName)
      setTableFacts((cur) => (sameTableFacts(cur, table) ? cur : table))
      // The last ladder went (an undo, a delete in the text): a sheet with nothing on it is no face of this program.
      // NO_LADDER by identity means the program does not even spell LADDER; a merely EMPTY set can be a program that
      // does not lex this moment (a half-typed comment, perhaps a peer's), and that must not throw the reader off the
      // sheet.
      if (next === NO_LADDER && viewRef.current === 'ladder') setView('text')
    }, LADDER_MARK_DELAY_MS)
  }
  useEffect(() => () => window.clearTimeout(marksTimer.current), [])

  // Re-derive the POU index, but re-RENDER only when the set of blocks actually changed. Typing
  // inside a block re-splits (cheap: one pass over the source) and produces the same signature,
  // so a keystroke does not churn React.
  const refreshBlocks = (src: string): void => {
    scheduleMarks() // every path that re-derives the index re-derives its marks; the early return below is the split's
    const next = parseDocument(src).blocks
    startsRef.current = blockStarts(src, next)
    const sig = blockSignature(next)
    if (sig === blockSigRef.current) return
    blockSigRef.current = sig
    setBlocks(next)
  }

  /** The program as the reader sees it now: the editor's buffer, or the persisted source before the editor lands. */
  const currentSource = (): string => editorRef.current?.getValue() ?? sourceRef.current

  /** Scroll block `i` into view (see `blockOffset` for why positions are searched, not stored). */
  const gotoBlock = (i: number): void => {
    editorRef.current?.revealOffset(blockOffset(currentSource(), blocks, i))
  }

  /**
   * Apply a structural edit from the organizer: New / Rename / Delete.
   *
   * ONE document replacement, through the same editor + persistSource path a keystroke takes.
   * That is what makes these ordinary edits rather than a second way to change a program: Ctrl-Z
   * undoes them, a room replicates them, and nothing downstream has to learn a new event. The
   * blocks are re-derived from the edit's OWN source rather than from `blocks`, which React has
   * not re-rendered yet at this point.
   */
  const applyBlockEdit = (edit: DocumentEdit, reveal = true): void => {
    if (edit.source === sourceRef.current) return // refused (e.g. the program body); leave the buffer alone
    editorRef.current?.setValue(edit.source)
    persistSource(edit.source)
    if (reveal) editorRef.current?.revealOffset(blockOffset(edit.source, parseDocument(edit.source).blocks, edit.index))
  }

  /** A controller table edit, the organizer's or a PROGRAM rename's: one undo step with the code and the wiring
   *  (editor/program/controllerCommit.ts), with the renamed tags reported under the code. `source` is the code with the edit
   *  already in it, when the edit changed the code too. */
  const applyController = (next: Controller, renames: TagRename[], label: string, source?: string): void => {
    const renamed = commitControllerEdit(store, next, renames, label, source)
    if (renamed) showReport(renamed)
  }

  /**
   * Open block `i` in its own face. The view follows the POU: its language decides which face opens, not what the panel
   * last showed. Read from the buffer rather than from `marks`, which lags typing by LADDER_MARK_DELAY_MS - a click is
   * once, so it can afford the parse that a keystroke cannot.
   */
  const openBlock = (i: number): void => {
    // the organizer marks the block the reader is in, which the text editor reports as its cursor moves; the ladder face
    // moves no cursor, so the block opened is marked here (a text jump reports the same block a moment later)
    setActiveBlock(i)
    const src = currentSource()
    const from = blockOffset(src, blocks, i)
    const to = i + 1 < blocks.length ? blockOffset(src, blocks, i + 1) : src.length
    const sections = readLadder(src)
    const routine = sections.findIndex((r) => r.start >= from && r.start < to)
    if (viewRef.current === 'ladder') {
      // already on the sheet: a block drawn there is scrolled to, anything else is text, so the view follows
      if (routine >= 0) return setRevealRoutine(routine)
      setView('text')
    } else if (routine >= 0 && sections[routine]!.whole) {
      // a ladder POU reached from the text: raise its sheet, scrolled to it. Only a WHOLE one - a section standing
      // inside ST would take the statements around it off screen, and those are part of the POU that was opened.
      // The text cursor stays where the reader left it, as it does for a jump within the sheet above.
      setView('ladder')
      return setRevealRoutine(routine)
    }
    gotoBlock(i)
  }

  /** The PROGRAM called `name` that just landed, shown in its own face: a ladder program on the sheet, where its first
   *  rung is waiting. The store has already handed this editor the new code (onStProgramEdit). */
  const showLanded = (name: string): void => {
    const src = store.getState().stProgram
    const landed = parseDocument(src).blocks
    const i = landed.findIndex((b) => b.kind === 'programPou' && b.name.toUpperCase() === name.trim().toUpperCase())
    const routine = i >= 0 ? ladderRoutineOf(src, landed, i) : null
    if (routine !== null) {
      setView('ladder')
      setRevealRoutine(routine)
    } else if (i >= 0) {
      if (viewRef.current === 'ladder') setView('text')
      editorRef.current?.revealOffset(blockOffset(src, landed, i))
    }
  }

  // Everything the organizer does to the program. Its rows are views over the text and the table, so each command is
  // one of the edits above: nothing it holds is a second copy of the program.

  // The table the organizer shows changes with the store's controller and scan time as well as with the code: a table
  // edit commits both, but a retime of the default table changes only the scan time.
  useEffect(() => {
    const table = tableFactsOf(currentSource(), state.controller, state.stScanMs, state.externalPlc.mainName)
    setTableFacts((cur) => (sameTableFacts(cur, table) ? cur : table))
    // currentSource reads refs; only the store's half of the table is a dependency
  }, [state.controller, state.stScanMs])

  // Beside the code when the panel has the width for it, over the code when it does not. Measured on the row the two
  // share, so a docked, floating, popped-out and phone panel all decide the same way.
  useLayoutEffect(() => {
    const el = workRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const w = el.clientWidth
      if (w > 0) setNarrow(w < NARROW_BELOW)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const setOrganizerPref = (next: OrganizerPref): void => {
    setOrganizer(next)
    saveOrganizerPref(next)
  }
  const toggleOrganizer = (): void => {
    if (narrow) setOverlayOpen((o) => !o)
    else setOrganizerPref({ ...organizer, open: !organizer.open })
  }
  /** The scope an offset stands in: the POU around it, else the controller (whose tags the top-level code declares). */
  const scopeAtOffset = (offset: number): TagScope => {
    const b = blocks[blockAt(startsRef.current, offset)]
    return b && (b.kind === 'programPou' || b.kind === 'functionBlock' || b.kind === 'function') && b.name !== '' ? { kind: 'pou', name: b.name } : { kind: 'controller' }
  }

  /**
   * Rename the declaration under the caret - F2, what this app already means Rename by (core/keymap.ts
   * `edit.rename`, the scene tree's chord for the same act).
   *
   * The refactor a text editor has and a VAR block needs: renaming by hand means finding every use, and the scene's
   * parts are wired to the variable's NAME, so a hand-edited rename leaves them pointing at one that no longer exists.
   * The commit carries the wiring (plcPanelParts.tsx `renameDeclaration`).
   */
  const renameAtCaret = (): void => {
    if (readOnly) return
    const at = editorRef.current?.caret()
    if (!at?.word) {
      // a key that appears to do nothing is worse than one that says what it wanted
      showReport({ headline: t(M.nothingToRename), detail: t(M.nothingToRenameDetail), items: [], tone: 'warn', keepOnEdit: false })
      return
    }
    const scope = scopeAtOffset(at.offset)
    const where = scope.kind === 'pou' ? scope.name : t(M.theController)
    void askName({ title: t(M.renameTitle, { name: at.word }), intro: t(M.renameIntro, { where }), initial: at.word, confirmLabel: t(M.rename) }).then((to) => {
      if (to === null || to.trim() === '' || to.trim() === at.word) return
      return renameDeclaration(ctx, scope, at.word!, to.trim()).then((why) => {
        if (why !== null) showReport({ headline: t(M.notRenamed, { name: at.word! }), detail: why, items: [], tone: 'warn', keepOnEdit: false })
      })
    }).catch((e) => console.warn('[oip] rename failed:', e))
  }

  // where each Go to definition left from (program/jumpHistory.ts)
  const jumps = useRef(new JumpHistory())
  /** Step back to where the last jump left from, or forward again. */
  const stepJump = (dir: 'back' | 'forward'): void => {
    const from = editorRef.current?.caret()?.offset
    if (from === undefined) return
    const to = dir === 'back' ? jumps.current.goBack(from) : jumps.current.goForward(from)
    if (to !== null) editorRef.current?.revealOffset(to)
  }

  /** Move the caret to where the name under it is declared (plc/tags.ts `definitionAt`). */
  const goToDefinitionAt = (offset: number): void => {
    void import('../../../plc/tags').then(({ definitionAt }) => {
      const at = definitionAt(currentSource(), offset)
      if (at !== null) {
        jumps.current.jumped(offset)
        editorRef.current?.revealOffset(at)
      } else showReport({ headline: t(M.noDefinition), detail: t(M.noDefinitionDetail, { keys: primaryKey('edit.goToDefinition') ?? '' }), items: [], tone: 'warn', keepOnEdit: false })
    }).catch((e) => console.warn('[oip] go to definition failed:', e))
  }

  const showText = (offset: number): void => {
    setView('text')
    editorRef.current?.revealOffset(offset)
  }
  // what the running controller faulted on, drawn on the ladder sheet too (plcFaults.ts)
  const faults = usePlcFaults({ controller, ladderSource, face: view, showText })
  // the fault's own message is the error line (the controller reports it as the program's status); what this adds is
  // WHERE it happened - but only while the panel still shows the program it happened in, since an edit moves every
  // offset after it
  const faultAt = faults.faults?.fault?.offset
  const showFault = faultAt !== undefined && faults.faults?.source === (view === 'ladder' ? ladderSource : currentSource())

  // What the organizer and the ladder reach the panel through (plcPanelParts.tsx): its doors, and nothing else. Built
  // per render, so whatever they call is this render's.
  const ctx: PlcPanelCtx = {
    store,
    state,
    controller,
    currentSource,
    ladderSource,
    applyLadderEdit,
    applyBlockEdit,
    applyController,
    blocks,
    activeBlock,
    facts,
    table: tableFacts,
    readOnly,
    readOnlyNote,
    live: attached && state.running,
    face: view,
    setFace: setView,
    openBlock,
    gotoBlock,
    showText,
    revealRoutine,
    onRevealedRoutine: () => setRevealRoutine(null),
    revealTasks,
    faults,
    onPicked: narrow ? () => setOverlayOpen(false) : undefined,
    showReport,
    showLanded,
    watch: () => ctrlRef.current?.plcWatch,
    monitored: picked,
    pickInstance,
    forces: () => ctrlRef.current?.plcForces ?? {},
    aliases: () => ctrlRef.current?.plcAliases ?? new Map(),
    force: (key) => (ctrlRef.current ? ctrlRef.current.forcePlcValue(key) : t(M.notRunning)),
    releaseForce: (key) => ctrlRef.current?.releasePlcForces(key),
    onForces: (cb) => {
      forceListeners.current.add(cb)
      return () => forceListeners.current.delete(cb)
    },
    onProgramStatus: (cb) => {
      statusListeners.current.add(cb)
      return () => statusListeners.current.delete(cb)
    },
    toggleBit: (key) => ctrlRef.current?.togglePlcBit(key) ?? false,
    // (NOT `?? 'not running'`: a write that WORKED answers null)
    writeLive: (key, text) => (ctrlRef.current ? ctrlRef.current.writePlcValue(key, text) : t(M.notRunning)),
    addToWatch: (name) => addToWatch(name),
    tags: () => commsTags(stateRef.current.scene.parts),
    undo: () => editorRef.current?.undo(),
    redo: () => editorRef.current?.redo(),
  }

  /** Bring the organizer's Tasks into view: the controller table's problems and this panel's "Show tasks" links. */
  const showTasks = (): void => {
    if (narrowRef.current) setOverlayOpen(true)
    else
      setOrganizer((cur) => {
        if (cur.open) return cur
        const next = { ...cur, open: true }
        saveOrganizerPref(next)
        return next
      })
    setRevealTasks((n) => n + 1)
  }
  // showTasks reads refs and state updaters only, so the first render's is as good as any
  useEffect(() => store.onRevealStOrganizer(showTasks), [store])
  // where the reader is, for the agent's get_context (plcReading.ts); read from refs, so it is current when asked
  const readingRef = useRef({ blocks, activeBlock })
  readingRef.current = { blocks, activeBlock }
  useEffect(
    () =>
      providePlcReading(() => {
        const { blocks: bs, activeBlock: i } = readingRef.current
        const block = bs[i]
        const pou = block ? block.name || block.kind : null
        if (viewRef.current === 'ladder') return { face: 'ladder', pou, line: null, word: null }
        const caret = editorRef.current?.caret() ?? null
        const text = currentSource()
        const line = caret ? text.slice(0, caret.offset).split('\n').length : null
        return { face: 'text', pou, line, word: caret?.word ?? null }
      }),
    [],
  )

  /** Add to Watch, from the text's menu or the rungs': onto the project's list, with the Watch dock brought forward. */
  const addToWatch = (name: string): void => {
    const s = stateRef.current
    addToWatchList(tabWatchListKey(s.projectName, s.collab), [name], s.projectName)
    store.revealPanel('watch')
  }

  // The code's right-click menu: Add to Watch for the variable clicked, and the editing items the browser's own menu
  // had, which this one replaces. Shift+right-click still opens the browser's.
  const [textMenu, setTextMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const openTextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.shiftKey || !editorRef.current) return
    e.preventDefault()
    // the menu key fires this with no pointer position: the menu opens at the caret
    const point = e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY }
    const at = editorRef.current.contextAt(point)
    if (!at) return
    const editor = editorRef.current
    // contextAt put the caret at the click, so the name under the caret is the one clicked
    const caret = editor.caret()
    const has = at.selected !== ''
    const later = (fn: () => void) => () => void window.setTimeout(fn, 0)
    // Force / Release: for a variable the running program holds as one value (its watch key), only while it runs
    // read in the POU the click is in, so a block's local is never forced as the program's variable of that name
    const image = ctx.live && at.name !== null ? ctx.watch() : null
    const src = editor.getValue()
    const scoped = image && at.name !== null && caret ? watchScopes(src, watchInstances(src, controllerFor(src, stateRef.current.controller, stateRef.current.stScanMs)), pickedRef.current).keyAt(caret.offset, at.name) : null
    const forceKey = image && scoped !== null ? resolveWatch(scoped, image).key : null
    const forced = forceKey !== null && forceKey in ctx.forces()
    const forceOrRelease = (key: string): void => {
      if (forced) return ctx.releaseForce(key)
      const refused = ctx.force(key)
      if (refused !== null) showReport({ headline: t(M.notForced, { name: key }), detail: refused, items: [], tone: 'warn', keepOnEdit: false })
    }
    const copyText = (): Promise<boolean> =>
      (activeClipboard()?.writeText(at.selected) ?? Promise.reject(new Error('no clipboard'))).then(
        () => true,
        () => false,
      )
    setTextMenu({
      x: at.at.x,
      y: at.at.y,
      items: [
        {
          label: at.name !== null ? t(M.addNameToWatch, { name: at.name }) : t(M.addToWatch),
          testid: 'st-add-to-watch',
          disabled: at.name === null,
          title: t(at.name !== null ? M.addToWatchHint : M.addToWatchNone),
          onClick: later(() => at.name !== null && addToWatch(at.name)),
        },
        // the project's displays (program/displayValues.ts): beside Add to Watch, which is the reader's own list
        (() => {
          const shown = at.name !== null && displayedValues(stateRef.current).includes(at.name)
          const full = !shown && displayListFull(stateRef.current)
          return {
            label: at.name !== null ? t(shown ? M.hideNameOnDisplays : M.showNameOnDisplays, { name: at.name }) : t(M.showOnDisplays),
            testid: 'st-show-on-displays',
            disabled: at.name === null || !canEditDisplay(stateRef.current) || full,
            title: at.name === null ? t(M.addToWatchNone) : full ? t(M.displayFull, { count: MAX_DISPLAY_VALUES }) : t(M.showOnDisplaysHint),
            onClick: later(() => at.name !== null && setDisplayed(store, at.name, !shown)),
          }
        })(),
        ...(forceKey !== null
          ? [{ label: t(forced ? M.releaseName : M.forceName, { name: forceKey }), testid: 'st-force', title: t(forced ? M.releaseHint : M.forceHint), onClick: later(() => forceOrRelease(forceKey)) }]
          : []),
        {
          label: caret?.word ? t(M.goToDefinitionOf, { name: caret.word }) : t(M.goToDefinition),
          testid: 'st-go-to-definition',
          keys: primaryKey('edit.goToDefinition'),
          disabled: !caret?.word,
          onClick: later(() => caret && goToDefinitionAt(caret.offset)),
        },
        { label: t(M.goBack), testid: 'st-go-back', keys: primaryKey('edit.jumpBack'), disabled: !jumps.current.canGoBack(), onClick: later(() => stepJump('back')) },
        { label: t(M.goForward), testid: 'st-go-forward', keys: primaryKey('edit.jumpForward'), disabled: !jumps.current.canGoForward(), onClick: later(() => stepJump('forward')) },
        { label: '-', onClick: () => {} },
        { label: t(M.cut), testid: 'st-cut', keys: primaryKey('edit.cut'), disabled: readOnly || !has, title: readOnly ? readOnlyNote : undefined, onClick: later(() => void copyText().then((ok) => ok && editor.replaceSelection('', 'delete.cut')).catch((e) => console.warn('[oip] cut failed:', e))) },
        { label: t(M.copy), testid: 'st-copy', keys: primaryKey('edit.copy'), disabled: !has, onClick: later(() => void copyText()) },
        {
          label: t(M.paste),
          testid: 'st-paste',
          keys: primaryKey('edit.paste'),
          disabled: readOnly,
          title: readOnly ? readOnlyNote : undefined,
          onClick: later(() => {
            const clip = activeClipboard()
            void (clip ? clip.readText() : Promise.reject(new Error('no clipboard'))).then(
              (text) => editor.replaceSelection(text, 'input.paste'),
              () => showReport({ headline: t(M.pasteRefused), detail: t(M.pasteRefusedDetail, { keys: primaryKey('edit.paste') ?? '' }), items: [], tone: 'warn', keepOnEdit: false }),
            )
          }),
        },
        { label: t(M.selectAll), testid: 'st-select-all', onClick: later(() => editor.selectAll()) },
        { label: '-', onClick: () => {} },
        { label: t(M.foldDeclarations), testid: 'st-fold-declarations', title: t(M.foldDeclarationsHint), onClick: later(() => editor.foldDeclarations()) },
        { label: t(M.unfoldAll), testid: 'st-unfold-all', onClick: later(() => editor.unfoldAll()) },
      ],
    })
  }


  // the divider between the organizer and the code: drag to resize, remembered on release
  const orgResize = useRef<{ sx: number; bw: number } | null>(null)
  const onOrgResizeDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    orgResize.current = { sx: e.clientX, bw: organizer.width }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onOrgResizeMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const r = orgResize.current
    if (!r) return
    const width = Math.min(ORGANIZER_WIDTH.max, Math.max(ORGANIZER_WIDTH.min, r.bw + e.clientX - r.sx))
    setOrganizer((cur) => ({ ...cur, width }))
  }
  const onOrgResizeUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    orgResize.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setOrganizer((cur) => (saveOrganizerPref(cur), cur))
  }

  // A click on this panel's dock tab: take the keyboard, but only in the text view. The ladder sheet and the organizer
  // keep their own keys, and focus decides whether a key edits the program or drives the viewport.
  useEffect(
    () =>
      store.onFocusStCode(() => {
        if (viewRef.current !== 'text') return
        if (editorRef.current) editorRef.current.focus()
        else pendingFocus.current = true
      }),
    [store],
  )

  // "Go to the line" from outside this panel (the Problems dock clicking a compile error). Only a
  // MOUNTED editor can answer, which is exactly why it is a subscription and not a prop: docked,
  // floating and popped-out instances all subscribe, and whichever is on screen serves the request.
  // The offset lands in the face of the POU it falls in, as opening a row does: inside a ladder POU the sheet comes up,
  // scrolled to it (where a rung shows its own problem), anywhere else the text, at the line.
  useEffect(
    () =>
      store.onRevealStOffset((offset) => {
        const src = editorRef.current?.getValue() ?? sourceRef.current
        const all = parseDocument(src).blocks
        const routine = ladderRoutineOf(src, all, blockAt(blockStarts(src, all), offset))
        if (routine !== null) {
          setView('ladder')
          setRevealRoutine(routine)
          return
        }
        if (viewRef.current === 'ladder') setView('text')
        if (editorRef.current) editorRef.current.revealOffset(offset)
        else pendingReveal.current = offset
      }),
    [store],
  )

  // Poll the live variable image while a program is running (it changes every scan, independent of store updates, so
  // it can't ride the normal React subscription). It feeds the editor's inline value overlays; the cleanup clears them
  // when monitoring ends (the sim stops, or a runtime fault drops the program). The program instances go with the
  // image: the `x` written in a PROGRAM is published as its instance's `Main.x` (plc/watchScope.ts). They are read
  // again only when the text changes.
  useEffect(() => {
    if (!attached || !state.running) return
    let instancesOf = ''
    let instances: WatchInstance[] = []
    // what was last pushed: the image is replaced when new values arrive (sim/client.ts), so the same image, instances
    // and pick mean nothing new to draw, and a push rebuilds every inline value of the program. Pushed again after a
    // second regardless, for an editor view made since the last push (it starts with no values).
    let pushed: { w: object; instances: WatchInstance[]; picked: object; at: number } | null = null
    const id = setInterval(() => {
      const w = ctrlRef.current?.plcWatch
      // only while the text is the face: under the rungs the editor is hidden. The face coming back finds another
      // image than the last one pushed, and pushes.
      if (w && viewRef.current === 'text') {
        const src = sourceRef.current
        if (src !== instancesOf) {
          instancesOf = src
          instances = watchInstances(src, controllerFor(src, stateRef.current.controller, stateRef.current.stScanMs))
        }
        const picked = pickedRef.current
        const now = performance.now()
        if (!pushed || pushed.w !== w || pushed.instances !== instances || pushed.picked !== picked || now - pushed.at > 1000) {
          pushed = { w, instances, picked, at: now }
          editorRef.current?.setWatchValues(w, instances, picked, pickInstance)
        }
      }
      setOverruns(ctrlRef.current?.plcScanStats?.overruns ?? 0)
    }, 120)
    return () => {
      clearInterval(id)
      editorRef.current?.setWatchValues({})
      setOverruns(0)
    }
  }, [attached, state.running])

  // The controller owns the PLC lifecycle now (attaches on the sim run edge in run(), detaches
  // in stop()) so logic runs on Play in any layout - including phones, where this panel isn't
  // mounted. Here we just mirror its attach status into local state for the bindings/error
  // readout and the monitor overlay below.
  useEffect(() => {
    if (!controller) return
    const sync = (): void => {
      const st = controller.programStatus
      setAttached(st.attached)
      setUnbound(st.unbound)
      setUnwired(st.unwired)
      setWarnings(st.warnings)
      setError(st.error)
      setErrorInController(st.errorInController ?? false)
    }
    sync()
    return controller.onProgramStatus(sync)
  }, [controller])

  // A wholesale program replacement (scene import, project scene switch, demo, New) swaps this
  // editor's buffer to it. In a ROOM we skip the setValue: CodeMirror is bound to the shared
  // Y.Text, the store's sink already replaced that text, and writing the same content again
  // through the binding would round-trip a redundant delete+insert to every peer.
  useEffect(() => {
    return store.onStProgramLoad((src) => {
      sourceRef.current = src
      if (!collab) editorRef.current?.setValue(src)
      refreshBlocks(src) // a wholesale swap is exactly when the POU set changes
      // ...and a program this panel has not shown opens on its own face, as it does on mount (in a room the binding may
      // not have moved the buffer yet, so the sheet is handed the source itself)
      const face = openingFaceOf(src, store.getState().controller)
      setBodyRuns(topLevelStatements(src)) // the organizer names the new program's top-level code now, not a pause later
      setView(face.face)
      if (face.face === 'ladder') setLadderSource(src)
      setRevealRoutine(face.routine)
      setActiveBlock(face.face === 'ladder' && face.routine !== null ? routineBlock(src, parseDocument(src).blocks, face.routine) : -1)
      setError(null)
      setErrorInController(false)
      setUnbound([])
    })
  }, [store, collab])

  // A program edit (the organizer's table and program commands, an import) or its undo changed the code: apply it
  // without a step in CodeMirror's own history, so Ctrl+Z there cannot take back the code and leave the table or the
  // wiring (store.commitProgram). In a room the shared Y.Text has already moved the buffer.
  useEffect(() => {
    return store.onStProgramEdit((src) => {
      sourceRef.current = src
      if (!collab) editorRef.current?.applyEdit(src)
      refreshBlocks(src)
      // ...and the sheet, which draws from state rather than from the buffer: this edit did not come through the
      // editor's own onChange, so nothing else would tell it (a routine deleted in the organizer, an undone table edit)
      if (viewRef.current === 'ladder') setLadderSource(src)
    })
  }, [store, collab])

  // Keep the floating window inside the 3D view: on mount (the stored rect may come from a bigger screen or a bigger
  // view), on expand (a title bar parked at the bottom must not open onto the dock), and whenever the view changes
  // size (a dock resized or collapsed, the browser window resized). A layout effect, so a misplaced frame is never
  // painted. The fit is not saved: the stored rect stays the one the user placed, and the next load fits it afresh.
  // A collapsed window is drawn as its title bar alone, so that is the height it is fitted by (here and in the drag).
  // copy the program source to the clipboard as plain-text ST (a portable, no-lock-in
  // export; clean round-trip into a real PLC runtime is the goal, not yet a guarantee)
  const copy = (): void => {
    void navigator.clipboard?.writeText(sourceRef.current).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      },
      () => {}, // clipboard blocked (permissions/insecure context): no-op
    )
  }

  // Ctrl/Cmd-Enter in the code. Stopped, it starts the sim, which attaches the program: in a browser F5 is the page's,
  // so this is the only key that runs it. Running, it does what the Reload button does. Both are commands,
  // so a disabled one is a no-op here too; the controller owns the attach and reports back through programStatus.
  const run = (): void => runCommand(stateRef.current.running ? 'sim.reloadProgram' : 'sim.run')


  // Every command that writes the program or the scene, at the right end of the header row. The read-only sheet drops
  // them rather than disabling them, and the ⧉ copy icon keeps the text one tap from leaving.
  //
  // No Run and no Stop: the toolbar's transport starts and stops the sim, and Play attaches the program. What this panel
  // adds is Reload, the edited program into a RUNNING sim without resetting the world, lit only while the text on
  // screen is not what runs (commands.ts `sim.reloadProgram`), so the button is also the sign that it is not.
  const reloadEnabled = commandEnabled('sim.reloadProgram')
  const commandsEl = !viewOnly && (
    <div style={commandGroup}>
      <button
        data-testid="st-reload"
        style={{ ...btn, ...(reloadEnabled ? reloadLit : reloadIdle) }}
        disabled={!reloadEnabled}
        onClick={() => runCommand('sim.reloadProgram')}
        title={
          !reloadEnabled
            ? (commandDisabledReason('sim.reloadProgram') ?? '')
            : attached
              ? t(M.reloadAttached)
              : t(M.reloadIdle)
        }
      >
        {t(M.reload)}
      </button>
      {/* the demo, the way IN and the two export targets, behind one button (PlcFileMenu.tsx) */}
      <PlcFileMenu style={{ ...btn, padding: '2px 8px' }} readOnly={state.readOnly} readOnlyNote={readOnlyNote} />
    </div>
  )

  // data-plc-panel: whether the PLC panel holds the focus, wherever this is mounted (dialogHost.ts `plcHasFocus`)
  const bodyEl = (
    <div style={body} data-plc-panel="">
          <div style={editorWrap}>
            {/* The header row: the organizer's toggle, the Text/Ladder switch and the panel's commands.
                The Text/Ladder switch shows only while some POU holds a LADDER section among
                statements, the one POU with two faces. Everywhere else a POU is ONE language and
                opening it in the organizer opens it in that one (openBlock), so a switch would only
                ever offer the face of a DIFFERENT POU. The way to the text from a sheet is an ST
                POU, or a ladder POU's "Show as text" for its rung text. */}
            <div style={headerRow} data-testid="plc-header" data-titlebar="">
              <div className="plc-organizer-toggle-wrap">
                <button
                  type="button"
                  className="plc-organizer-toggle"
                  data-testid="plc-organizer-toggle"
                  aria-pressed={organizerShown}
                  title={t(organizerShown ? M.hideOrganizer : M.showOrganizer)}
                  onClick={toggleOrganizer}
                >
                  {t(M.organizer)}
                </button>
              </div>
              {showViewSwitch && (
                <div className="plc-view-switch" role="group" aria-label={t(M.programView)}>
                  <button data-testid="plc-view-text" aria-pressed={view === 'text'} title={t(M.textTitle)} onClick={() => setView('text')}>
                    {t(M.text)}
                  </button>
                  <button data-testid="plc-view-ladder" aria-pressed={view === 'ladder'} title={t(M.ladderTitle)} onClick={() => setView('ladder')}>
                    {t(M.ladder)}
                  </button>
                </div>
              )}
              {/* docked: open the panel in a window of its own; in that window: put it back. Only ever on a click -
                  a window nobody asked for is a surprise, and a browser may refuse one. */}
              {(onPopoutDocked || onReturnToDock) && (
                <button
                  type="button"
                  className="plc-window"
                  data-testid="plc-window"
                  aria-pressed={onReturnToDock !== undefined}
                  onClick={() => (onReturnToDock ? onReturnToDock() : onPopoutDocked?.())}
                  title={t(onReturnToDock ? M.returnToDock : M.popoutDocked)}
                >
                  {onReturnToDock ? <DockIcon /> : <ExternalLinkIcon size="1em" />}
                </button>
              )}
              {commandsEl}
            </div>
            {foreignDialect !== null && (
              <div style={dialectBanner} role="status" data-testid="st-foreign-dialect">
                ⚠ {dialectRefusal(foreignDialect)}
              </div>
            )}
            {/* The organizer beside the code: the program as a tree (PlcOrganizer). Opening an entry moves the VIEW
                only - one CodeMirror document over the whole program, so the shared Y.Text binding and the undo
                history behave exactly as they would for typing - and every command it has is a single document
                replacement through the same path, or one table commit through the store. */}
            <div ref={workRef} style={workRow}>
              {organizerShown && (
                <>
                  <div className={`org-col${narrow ? ' overlay' : ''}`} style={narrow ? undefined : { width: organizer.width }} data-testid="plc-organizer-col">
                    <PanelOrganizer ctx={ctx} />
                  </div>
                  {narrow ? (
                    <div className="org-scrim" onClick={() => setOverlayOpen(false)} />
                  ) : (
                    <div
                      className="org-resizer"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t(M.resizeOrganizer)}
                      onPointerDown={onOrgResizeDown}
                      onPointerMove={onOrgResizeMove}
                      onPointerUp={onOrgResizeUp}
                    />
                  )}
                </>
              )}
              <div style={codeCol}>
                {view === 'ladder' && <PanelLadder ctx={ctx} />}
                {/* the text editor stays MOUNTED under the ladder: it owns the buffer, its undo history and a room's binding */}
                <div
                  style={view === 'ladder' ? { ...editorHostWrap, display: 'none' } : editorHostWrap}
                  onContextMenu={openTextMenu}
                  // In the capture phase: CodeMirror binds Alt+arrow itself and would take the press first.
                  onKeyDownCapture={(e) => {
                    const action = resolveKeyAction(e, 'editor')
                    if (action !== 'edit.jumpBack' && action !== 'edit.jumpForward') return
                    // on a Mac a chord of Option alone is text entry (Option+arrow moves by a word)
                    if (IS_MAC && e.altKey && !e.ctrlKey && !e.metaKey) return
                    e.preventDefault()
                    e.stopPropagation()
                    stepJump(action === 'edit.jumpBack' ? 'back' : 'forward')
                  }}
                  onKeyDown={(e) => {
                    // (resolved, never compared: core/keymap.ts owns which chord means Rename and Go to definition)
                    const action = resolveKeyAction(e, 'editor')
                    if (action !== 'edit.rename' && action !== 'edit.goToDefinition') return
                    e.preventDefault()
                    e.stopPropagation()
                    if (action === 'edit.rename') renameAtCaret()
                    else {
                      const at = editorRef.current?.caret()
                      if (at) goToDefinitionAt(at.offset)
                    }
                  }}
                >
                  <Suspense fallback={null}>
                    <StCodeEditor
                      key={collab ? 'room' : 'solo'}
                      ref={editorRef}
                      // in a room CodeMirror binds to the shared text, so it starts from exactly that text
                      initialValue={collab ? collab.ytext.toString() : initialSource}
                      onChange={(v) => {
                        persistSource(v) // persist every edit so a reload restores it
                        // the downloaded file is a snapshot of the text as it WAS, so the moment the text
                        // moves on, saying "Exported foo.st" is stale. An IMPORT report survives: its
                        // items are the reasons to be editing in the first place (keepOnEdit).
                        store.dismissStFileReport({ staleOnly: true })
                      }}
                      getTags={() => commsTags(stateRef.current.scene.parts)}
                      getProgram={() => ({ controller: stateRef.current.controller, scanMs: stateRef.current.stScanMs })}
                      getDefaultPlc={() => stateRef.current.externalPlc.mainName}
                      lints={foreignDialect === null}
                      onUndo={() => store.undoProgramEditAt(editorRef.current?.getValue() ?? sourceRef.current)}
                      onRedo={() => store.redoProgramEditAt(editorRef.current?.getValue() ?? sourceRef.current)}
                      onRun={run}
                      collabExtension={collab?.stExtension}
                      readOnly={readOnly}
                      onReadingPosition={(offset) => {
                        if (viewRef.current === 'text') setActiveBlock(blockAt(startsRef.current, offset))
                      }}
                      onReady={() => {
                        // A program swapped in (onStProgramLoad) or edited from the organizer (onStProgramEdit) while
                        // this chunk was still loading reached sourceRef but no buffer, so the editor opened on the text
                        // the panel MOUNTED with, and its first keystroke wrote that stale text back over the program.
                        // Catch it up outside the undo history, as if it had opened on it. In a room the Y.Text owns it.
                        if (!collab) editorRef.current?.applyEdit(sourceRef.current)
                        const at = pendingReveal.current
                        pendingReveal.current = null
                        if (at !== null && viewRef.current === 'text') editorRef.current?.revealOffset(at)
                        else if (pendingFocus.current && viewRef.current === 'text') editorRef.current?.focus()
                        pendingFocus.current = false
                      }}
                      style={editorHost}
                    />
                  </Suspense>
                  {/* portable plain-text ST export (no-lock-in goal); pinned in the editor corner rather
                      than a toolbar button so the control row stays focused on Reload */}
                  <button
                    style={{ ...copyIcon, opacity: copied ? 1 : copyIcon.opacity, color: copied ? 'light-dark(#1d8135, #7bd88f)' : copyIcon.color }}
                    onClick={copy}
                    onPointerEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onPointerLeave={(e) => (e.currentTarget.style.opacity = copied ? '1' : '0.55')}
                    aria-label={t(M.copyProgram)}
                    title={t(M.copyProgram)}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                  </button>
                  {textMenu && <ContextMenu x={textMenu.x} y={textMenu.y} items={textMenu.items} onClose={() => setTextMenu(null)} />}
                </div>
              </div>
            </div>
          </div>
          <div style={controls}>
            {overruns > 0 && (
              <div style={{ color: 'var(--warn)' }} title={t(M.overrunTitle)}>
                {/* program size has no part in it: the scan runs on sim time, so only the interval and the step rate
                    decide (sim/plcHost.ts shortestHeldIntervalSec), and the Problems dock warns about it before Run */}
                ⚠ {t(M.overruns, { count: overruns })}
                {/* the interval is a task's, in the organizer beside the code */}
                {' - '}
                <button data-testid="st-overrun-show-tasks" style={linkBtn} onClick={showTasks}>
                  {t(M.showTasks)}
                </button>
              </div>
            )}
            {error && (
              <div style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }} data-testid="st-error">
                ⚠ {error}
                {errorInController && (
                  <>
                    {' - '}
                    <button data-testid="st-error-show-tasks" style={linkBtn} onClick={showTasks}>
                      {t(M.showTasks)}
                    </button>
                  </>
                )}
              </div>
            )}
            {showFault && (
              <div style={{ color: 'var(--danger)' }}>
                <button data-testid="st-fault-show" style={linkBtn} onClick={() => faults.show(faultAt)}>
                  {t(M.showFault)}
                </button>
              </div>
            )}
            {/* What the last file did on the way in or out, as a CHECKLIST. A note about what a
                target may not carry means the file is fine, so it stays out of the red the
                compiler uses - but it is a list of things to go and fix, so it is not a line of
                prose either. Keyed by report id: a new file starts with nothing ticked. */}
            {report && <StFileReport key={report.id} report={report} onDismiss={() => store.dismissStFileReport()} />}
            {viewOnly ? (
              // the mobile sheet has no Problems dock to hand the tags to, so it keeps the list
              <>
                {unbound.length > 0 && (
                  <div style={{ color: 'var(--warn)' }}>{t(M.unboundTags, { tags: unbound.join(', ') })}</div>
                )}
                {unwired.length > 0 && (
                  <div style={{ color: 'var(--warn)' }}>{t(M.unwiredTags, { tags: unwired.join(', ') })}</div>
                )}
              </>
            ) : (
              unbound.length + unwired.length > 0 && (
                // The tags are listed in the Problems dock, which says for each one what is missing and selects the
                // parts involved; this line only says that there are some, and takes you there with the warnings
                // shown (the dock hides them by default, so a plain reveal would open onto "0 errors").
                <div style={{ color: 'var(--warn)' }} data-testid="st-unconnected" title={[...unbound, ...unwired].join(', ')}>
                  ⚠ {t(M.unconnected, { count: unbound.length + unwired.length })}{' '}
                  <button
                    data-testid="st-show-in-problems"
                    style={linkBtn}
                    onClick={() => {
                      store.setProblemsShowWarnings(true)
                      store.revealPanel('problems')
                    }}
                  >
                    {t(M.showInProblems)}
                  </button>
                </div>
              )
            )}
            {/* Said while stopped too, not only in the run's own warning below: this is where the program gets written,
                and Play will not run it. Only where Play can hand over at all (the desktop app); problems.ts notes the same. */}
            {!state.running && (controller?.externalPlcAvailable ?? false) && state.externalPlc.enabled && (
              <div style={{ color: 'var(--warn)' }} data-testid="st-external-plc">
                ⚠ {t(M.externalPlc)}
              </div>
            )}
            {warnings.map((w) => (
              <div key={w} style={{ color: 'var(--warn)' }}>⚠ {w}</div>
            ))}
            {/* the authoring tip names keys and the Inspector's wiring field, neither of which a
                read-only sheet can act on; it says what this surface DOES do instead. The tip is for
                an empty panel: once there is code, the lines it took belong to the code. */}
            {(viewOnly || state.stProgram.trim() === '') && (
              <div style={{ color: 'light-dark(#787c81, #7d8186)' }}>
                {viewOnly
                  ? t(M.viewOnlyTip)
                  : t(M.tip)}
              </div>
            )}
          </div>
        </div>
  )

  // docked: the DockSlot tab strip supplies the title + the Float action
  if (docked) return <div style={dockRoot}>{bodyEl}</div>

  return (
    <div ref={floatRef} data-floating="st" style={{ ...panel, left: geom.x, top: geom.y, width: geom.w, height: collapsed ? undefined : geom.h }}>
      <div style={header} {...headerDrag} title={t(M.dragToMove)}>
        <strong>⠿ {dockPanelTitle('st')} {attached && state.running ? '▶' : ''}</strong>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {onMaximize && (
            <button
              style={dockBtn}
              title={t(M.maximizeTitle)}
              aria-label={t(M.maximize)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onMaximize()
              }}
            >
              <MaximizeIcon />
            </button>
          )}
          {onPopout && (
            <button
              style={dockBtn}
              title={t(M.popoutTitle)}
              aria-label={t(M.popout)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onPopout()
              }}
            >
              <ExternalLinkIcon size="1em" />
            </button>
          )}
          {onDock && (
            <button
              style={dockBtn}
              title={t(M.dockTitle)}
              aria-label={t(M.dock)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onDock()
              }}
            >
              <DockIcon />
            </button>
          )}
          <span><FoldIcon closed={collapsed} /></span>
        </span>
      </div>
      {!collapsed && bodyEl}
      {!collapsed && (
        <div style={grip} {...gripDrag} title={t(M.dragToResize)} />
      )}
    </div>
  )
}
