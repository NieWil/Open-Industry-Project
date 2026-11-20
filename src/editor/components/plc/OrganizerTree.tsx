import { memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, forwardRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react'
import type { Controller } from '../../../core/controller'
import { resolveKeyAction } from '../../../core/keymap'
import { addTask, moveProgram, programsOnTask, removeProgram, removeTask, scheduleProgram, type DeviceTags, type TagRename } from '../../../plc'
import type { TaskTree, TaskTreeGroup, TaskTreeProgram, TaskTreeTask } from '../../../plc/taskTree'
import { DeviceTagsDialogChunk } from './deviceTagsChunk'
import { forcedDeviceIds } from '../../program/plcForces'
import { ContextMenu, type MenuItem } from '../inspector/menu'
import { FoldIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('organizer', {
  plcDefaultSimulated: 'default · simulated',
  plcDefaultExternal: 'default · external PLC',
  plcSimulated: 'simulated',
  plcExternal: 'external PLC',
  plcHint: '{name}: its tasks and the program instances on them. Double-click for Controller Properties',
  plcNoProgram: 'Runs on a PLC outside the app.',
  plcUnlisted: 'not set up',
  plcUnlistedNote: 'Not one of the project\'s controllers yet, so nothing runs its tasks.',
  plcSetUp: 'Set up',
  plcSetUpHint: 'Open Controller Properties, where {name} is added to the project and given where it runs',
  exportSt: 'Export {name}\'s Program (.st)',
  exportXml: 'Export {name}\'s Program (PLCopen XML)',
  exportHint: 'Download what goes onto {name}: its tasks, the program instances on them and the POUs they use',
  newTaskOn: 'New Task on {name}',
  everyStep: 'Every step',
  everyStepHint: 'On no task: run once every physics step, after the periodic tasks',
  tableInCode: 'These tasks are written in the code (its CONFIGURATION): edit them there, or move them into the organizer first',
  newProgramName: 'Name of the new {language} program',
  newProgramBadge: 'A new {language} program',
  controller: 'Controller',
  controllerHint: 'Where the program runs: here in the simulator, or on an external PLC. Double-click for its properties',
  properties: 'Properties',
  undoStopRunning: 'Stop running {name}',
  undoRun: 'Run {name}',
  undoReorder: 'Reorder {name}',
  undoRemoveTask: 'Remove task {name}',
  undoAddTask: 'Add task',
  showCode: 'Show code',
  runEarlier: 'Run earlier',
  runEarlierHint: 'Run it earlier when tasks come due together at one priority',
  runLater: 'Run later',
  runLaterHint: 'Run it later when tasks come due together at one priority',
  stopRunning: 'Stop running',
  stopTopLevelHint: 'Stop running the code outside every PROGRAM. Its variables stay in the program',
  stopProgramHint: 'Stop running it. Its PROGRAM stays in the code',
  runOn: 'Run on {task}',
  runEveryStep: 'Run every step',
  scheduleHint: 'An instance of it, on the first task',
  runsTopLevel: 'Runs the top-level code. Click for its code, double-click for its properties',
  runsTopLevelMissing: 'Runs the top-level code, which the code does not have. Click for its code, double-click for its properties',
  runsProgram: 'Runs PROGRAM {type}. Click for its code, double-click for its properties',
  runsProgramMissing: 'Runs PROGRAM {type}, which the code does not have. Click for its code, double-click for its properties',
  unscheduledHint: 'No task runs it. Click for its code',
  missingHint: 'The table names a PROGRAM the code does not have',
  missing: 'missing',
  runItOn: 'Run it on {task}',
  runItEveryStep: 'Run it every step',
  run: 'Run',
  taskBusy: {
    one: '{task} still runs {programs}: move it to another task, or stop running it, first.',
    other: '{task} still runs {programs}: move them to another task, or stop running them, first.',
  },
  delete: 'Delete',
  deleteTaskHint: 'Remove this task. One that still runs programs stays until they are moved',
  taskHint: 'Runs every {interval} ms of simulated time, at priority {priority} (0 is the highest). Double-click for its properties',
  interval: '{interval} ms',
  runsNothing: 'Runs nothing yet',
  notRunningHint: 'In the code, and run by no task',
  notRunning: 'Not running',
  tasks: 'Tasks',
  newTask: 'New task',
  newTaskHint: 'A new periodic task',
  problems: { one: '{count} problem', other: '{count} problems' },
  addTaskHint: 'Add a periodic task',
  addTask: 'Add a task',
  missingTask: 'Missing task',
  missingTaskHint: 'Bound to a task the controller does not have, so the program will not run until they are moved',
  devices: 'Devices',
  noDevices: 'No parts with PLC tags in the scene yet.',
  deviceHintOn: {
    one: 'Comms on: {wired} of {count} tag field wired. Click to select, double-click for its tags',
    other: 'Comms on: {wired} of {count} tag fields wired. Click to select, double-click for its tags',
  },
  deviceHintOff: {
    one: 'Comms OFF: {wired} of {count} tag field wired. Click to select, double-click for its tags',
    other: 'Comms OFF: {wired} of {count} tag fields wired. Click to select, double-click for its tags',
  },
  deviceHint: {
    one: '{wired} of {count} tag field wired. Click to select, double-click for its tags',
    other: '{wired} of {count} tag fields wired. Click to select, double-click for its tags',
  },
  commsOn: 'Comms on',
  commsOff: 'Comms off',
  noTagsWired: 'no tags wired',
  commsOffShort: 'comms off',
  forced: 'forced',
  forcedHint: 'A tag of this device is forced: the running program holds it until released',
  deviceTagsHint: 'Its tags, to copy and edit',
  deviceTags: 'tags…',
  organizer: 'Program organizer',
  new: '+ New',
})

// The PLC panel's organizer: the program as a TREE beside the code, the way PLC programming tools generally show a
// project: the Controller node, the Tasks with the program instances each one runs, what runs on no task, below them the
// program's own groups (POUs by kind, data types, global variables), and last the scene's Devices.
//
// This file is the tree and how it behaves: folding, the right-click menus, the name fields, the Tasks section and every
// edit of the controller table (core/controller.ts, through controllerEdits.ts), and the Devices section. What hangs
// in it from the program text - the rows under the Controller node and below Tasks, what a program's row is called and
// its menu, the Properties dialogs - is PlcOrganizer.tsx's, handed in as `OrganizerContent`.
//
// Presentation only: every entry is a view over the program text and the controller table, and every command is one
// of the panel's edits. A delete is not asked about: undo takes it back. The state here is what is folded, which name
// field is open, and which menu or dialog is up - and the last of those is held apart from the tree (Popups), so that
// opening a menu over a tree of hundreds of rows renders the menu, not the rows.

/** What the tree offers the rows hung in it: how they fold, open menus and dialogs, and name things. */
export interface TreeCtx {
  readOnly: boolean
  readOnlyNote: string
  /** the controller table cannot be edited from here: read-only, or the tasks are written in the code */
  tableLocked: boolean
  /** a table command's tooltip: `what` it does, or why it is not available */
  tableTitle: (what: string) => string
  isFolded: (key: string, startsClosed?: boolean) => boolean
  toggle: (key: string) => void
  openMenu: (e: ReactMouseEvent, items: MenuItem[]) => void
  /** a menu opened from a button, below it */
  menuBelow: (e: ReactMouseEvent<HTMLElement>, items: MenuItem[]) => void
  /** a dialog over the tree; `render` is given the function that closes it */
  openDialog: (render: (close: () => void) => ReactNode) => void
  /** why the last command could not be done, under Tasks (null clears it) */
  setNote: (note: string | null) => void
  /** an edit of the controller table, with the tags it renames */
  editTable: (next: Controller, renames: TagRename[], label: string) => void
  /** a row was picked: the tree closes when it is an overlay */
  picked: () => void
  /** the in-place name field of row `key` */
  rename: {
    active: (key: string) => boolean
    /** open it on `value`; `commit` renames and says why it could not, or null */
    begin: (key: string, value: string, commit: (to: string) => string | null) => void
    /** the field, while it is open on `key` */
    field: (key: string, opts: { testid: string; label: string }) => ReactNode
  }
  /** "+ program" under task `task` (under no task: where the Programs group draws its field, `draftField(undefined)`) */
  addProgram: (kind: string, task?: string) => void
  /** the name field of a program being added under `task`, while there is one */
  draftField: (task: string | undefined) => ReactNode
}

/** The items the tree builds for a row, for the content to lay out in its own order among its own. */
export interface ProgramMenuParts {
  showCode: MenuItem
  properties: MenuItem
  runEarlier: MenuItem
  runLater: MenuItem
  stopRunning: MenuItem
}
export interface TaskMenuParts {
  properties: MenuItem
  delete: MenuItem
}

/** What hangs in the tree from the program text (PlcOrganizer.tsx). Every function is asked on each render of the tree. */
export interface OrganizerContent {
  /** "+ New" over the tree: its tooltip and its items */
  newMenu: (ctx: TreeCtx) => { title: string; items: MenuItem[] }
  /** the Controller node's menu items after Properties, and what hangs under it */
  controllerMenu: (ctx: TreeCtx) => MenuItem[]
  controllerChildren: (ctx: TreeCtx) => ReactNode
  /** under Tasks when the tasks are written in the code (its CONFIGURATION), in place of the table's tree */
  ownConfiguration: (ctx: TreeCtx) => ReactNode
  /** a task's menu, from the tree's parts */
  taskMenu: (t: TaskTreeTask, parts: TaskMenuParts, ctx: TreeCtx) => MenuItem[]
  /** a program being added: the name it would take (null: it cannot, and the panel has said why), and adding it */
  suggestProgram: (kind: string) => string | null
  addProgram: (name: string, kind: string, task?: string) => string | null
  /** the language a program of `kind` is written in, shown on its name field while it is being named ("ST", "LD"), so
   *  the choice made in the menu is still on screen when the name is typed */
  draftLanguage: (kind: string) => { tag: string; name: string; ladder: boolean }
  program: {
    /** what an instance's row reads, and the word after it (": Merge", "top-level code"), if any */
    label: (p: TaskTreeProgram) => string
    kind: (p: TaskTreeProgram) => string | null
    /** the block it runs, for Show code, or -1 */
    block: (p: TaskTreeProgram) => number
    /** show block `index`'s code */
    open: (index: number) => void
    /** the row's menu, from the tree's parts; `scheduled` false for a program on the unscheduled list */
    menu: (p: TaskTreeProgram, parts: ProgramMenuParts & { schedule: MenuItem }, scheduled: boolean) => MenuItem[]
    /** why it cannot stop running (the one that runs the statements outside every PROGRAM), or null */
    pinned: (p: TaskTreeProgram) => string | null
    /** a click on a running instance also makes it the one whose live values the code shows */
    monitor: (p: TaskTreeProgram) => void
    /** for a PROGRAM that runs as several instances, the badge on the one whose values the code shows; else null */
    shown: (p: TaskTreeProgram) => { label: string; title: string } | null
  }
  /** what the unscheduled list holds: PROGRAM types, and null for the code outside every PROGRAM */
  unscheduled: (tree: TaskTree) => (string | null)[]
  /** the groups below Tasks */
  groups: (ctx: TreeCtx) => ReactNode
  taskDialog: (index: number, close: () => void, ctx: TreeCtx) => ReactNode
  programDialog: (index: number, close: () => void, ctx: TreeCtx) => ReactNode
}

/**
 * The scene's parts that speak tags, for the Devices section: the list, and what its rows DO.
 *
 * `setTag` / `setComms` are the Inspector's own field edits (one part's params), so wiring a tag from here is an
 * ordinary document edit: it undoes, saves and replicates like one made in the Inspector. The panel supplies all of
 * it (components/plc/plcDevices.ts `useOrganizerDevices`), and the object must be stable across renders: it is a prop of
 * the memoized `Popups`, which is what keeps opening a device's tags from re-rendering a tree of hundreds of tags.
 */
/** Forcing a device's tags from its dialog, while the program runs (EditorController.forcePlcValue). */
export interface DeviceForcing {
  /** the running program's watch key for a tag a part names; null when there is none to force (stopped, a direct
   *  address, a name the program does not have) */
  keyOf: (tag: string) => string | null
  forces: () => Readonly<Record<string, number | boolean>>
  onForces: (cb: () => void) => () => void
  force: (key: string) => string | null
  release: (key: string) => void
  /** told when a program attaches or detaches (Play, Stop, a reload); returns an unsubscribe */
  onProgramStatus: (cb: () => void) => () => void
}

export interface OrganizerDevices {
  list: readonly DeviceTags[]
  /** select the part in the scene */
  select: (id: string) => void
  setTag: (id: string, key: string, value: string) => void
  setComms: (id: string, on: boolean) => void
  /** force a tag from the device's dialog while the program runs; absent where nothing runs a program */
  forcing?: DeviceForcing
  /** the scene cannot be written (a view-only link); not the tree's `readOnly`, which also stands for a
   *  program this build may not edit (core/dialect.ts): that gates the program text, and a part's wiring is not program text */
  readOnly: boolean
}

export interface OrganizerTreeProps {
  content: OrganizerContent
  /** the scene's controllers, for the Tasks section's heading per controller: the default one's name, and each other
   *  one with whether the simulator runs it (core/scene/scenePlcs.ts) */
  plcs?: { defaultName: string; defaultSimulated: boolean; named: readonly { name: string; simulated: boolean }[] }
  /** the table the program runs from: the scene's own, or the default one a program with none runs from */
  controller: Controller
  /** that table as a tree (plc/taskTree.ts) */
  tree: TaskTree
  /** the tasks are written in the code (its own CONFIGURATION), so they are text, not table rows: the content's
   *  `ownConfiguration` stands in their place */
  ownConfiguration: boolean
  /** the table's own problems (plc controllerDiagnostics), shown under Tasks */
  problems: readonly string[]
  readOnly: boolean
  readOnlyNote: string
  /** bumped to bring the Tasks section into view, unfolded (Problems and the panel's "Open tasks" links) */
  revealTasks: number
  /** the block the reader is in, kept in view (`data-block-index` on its row); -1 for none */
  activeBlock?: number
  /** drawn over the code in a narrow panel: a pick closes it */
  onPicked?: () => void
  /** the scene's devices, under the program's groups; omitted where there is no scene to show (a test harness) */
  devices?: OrganizerDevices
  /** Controller Properties */
  onControllerProperties: () => void
  editController: (next: Controller, renames: TagRename[], label: string) => void
  /** download one controller's program (null: the default one): what goes onto that PLC */
  onExportController?: (plc: string | null, target: 'iec-text' | 'plcopen-xml') => void
}

/** A row's keydown for the keymap's Rename (keymap.ts edit.rename, F2 by default): `act` when it is pressed. The event
 *  stops here: the scene tree's own F2 listens on the window, and would rename the selected part too. */
export function onRenameKey(act: () => void): (e: ReactKeyboardEvent) => void {
  return (e) => {
    if (resolveKeyAction(e, 'editor') !== 'edit.rename') return
    e.preventDefault()
    e.stopPropagation()
    act()
  }
}

/** Keep `el` inside `box`'s scrolled view, moving `box` only: scrollIntoView would scroll the dock's ancestors too. */
function keepInView(box: HTMLElement | null, el: Element | null | undefined): void {
  if (!box || !el) return
  const b = box.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (r.top < b.top) box.scrollTop -= b.top - r.top + 4
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4
}

/** A name field that commits on Enter and on blur. Enter on a refused name keeps it open with the reason under it; a
 *  blur lets go, because a field that refuses to close is a trap. Escape drops it. */
export function NameField({ value, testid, label, error, onChange, onCommit, onCancel }: {
  value: string
  testid: string
  label: string
  error: string | null
  onChange: (v: string) => void
  onCommit: (fromBlur: boolean) => void
  onCancel: () => void
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null)
  // opens focused with its text selected, so a suggested name is replaced by typing. Explicit, not autoFocus: opening
  // it from a context menu unmounts the menu in the same commit, and which of the two gets the focus is not to be
  // left to chance
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="org-input"
      data-testid={testid}
      aria-label={label}
      aria-invalid={error !== null || undefined}
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onCommit(true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        // preventDefault: the commit reveals the code, which focuses the editor while Enter is still down, and the key
        // would type a newline there - an edit of its own that the next Ctrl+Z takes back instead of this one
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(false)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

interface PopupsHandle {
  menu: (x: number, y: number, items: MenuItem[]) => void
  dialog: (render: (close: () => void) => ReactNode) => void
  /** a device's tags, by the part's id */
  device: (id: string) => void
}

/** The menu and the dialog open over the tree. Apart from it, so that opening one renders this and not every row. */
const Popups = memo(
  forwardRef<PopupsHandle, { devices?: OrganizerDevices }>(function Popups({ devices }, ref) {
    const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
    const [dialog, setDialog] = useState<{ render: (close: () => void) => ReactNode } | null>(null)
    // the device whose tags are open, by ID and not by value: the dialog shows the tag it was just given, which means
    // reading the part out of the current list on every render, not the one captured when it opened
    const [deviceOpen, setDeviceOpen] = useState<string | null>(null)
    useImperativeHandle(ref, () => ({ menu: (x, y, items) => setMenu({ x, y, items }), dialog: (render) => setDialog({ render }), device: (id) => setDeviceOpen(id) }), [])
    const device = deviceOpen === null ? undefined : devices?.list.find((d) => d.id === deviceOpen)
    return (
      <>
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        {dialog?.render(() => setDialog(null))}
        {device && devices && (
          <DeviceTagsDialogChunk.Component
            device={device}
            readOnly={devices.readOnly}
            onSetTag={(key, value) => devices.setTag(device.id, key, value)}
            onSetComms={(on) => devices.setComms(device.id, on)}
            forcing={devices.forcing}
            onClose={() => setDeviceOpen(null)}
          />
        )}
      </>
    )
  }),
)

/** The devices with a tag field on a forced variable, re-read when a force is set or released. */
function useForcedDevices(devices: OrganizerDevices | undefined): ReadonlySet<string> {
  const forcing = devices?.forcing
  const list = devices?.list
  const [rev, setRev] = useState(0)
  useEffect(() => (forcing ? forcing.onForces(() => setRev((n) => n + 1)) : undefined), [forcing])
  // (rev: a force set or released changes the answer without changing the list)
  return useMemo(() => (forcing && list ? forcedDeviceIds(list, forcing.forces(), forcing.keyOf) : new Set<string>()), [forcing, list, rev])
}

export function OrganizerTree(props: OrganizerTreeProps): ReactElement {
  const { content, controller, tree, ownConfiguration, problems, readOnly, readOnlyNote, revealTasks, activeBlock = -1, onPicked, devices, onControllerProperties, editController } = props
  const forcedDevices = useForcedDevices(devices)
  const tableLocked = readOnly || ownConfiguration

  const rootRef = useRef<HTMLDivElement>(null)
  const tasksRef = useRef<HTMLDivElement>(null)
  const popups = useRef<PopupsHandle>(null)
  // what is folded; a node that starts closed (a program's tag list) is listed here when it has been opened
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const isFolded = (key: string, startsClosed = false): boolean => folded.has(key) !== startsClosed
  const toggle = (key: string): void =>
    setFolded((f) => {
      const next = new Set(f)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const openMenu = (e: ReactMouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    e.stopPropagation()
    popups.current?.menu(e.clientX, e.clientY, items)
  }
  const menuBelow = (e: ReactMouseEvent<HTMLElement>, items: MenuItem[]): void => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    popups.current?.menu(r.left, r.bottom + 2, items)
  }
  const openDialog = (render: (close: () => void) => ReactNode): void => popups.current?.dialog(render)

  // the row whose name is being edited, and a PROGRAM being added (its name is asked first, so the add is one edit)
  const [renaming, setRenaming] = useState<{ key: string; value: string; error: string | null } | null>(null)
  const renameCommit = useRef<((to: string) => string | null) | null>(null)
  const [drafting, setDrafting] = useState<{ kind: string; task?: string; value: string; error: string | null } | null>(null)
  // A commit unmounts the field, and the blur that fires then must not find the draft still there and add it twice.
  const draftingRef = useRef(drafting)
  draftingRef.current = drafting
  const renamingRef = useRef(renaming)
  renamingRef.current = renaming
  // why the last table command could not be done (a task that still runs programs)
  const [note, setNote] = useState<string | null>(null)

  // Problems, and the panel's own "Open tasks" links, ask for the tasks, which are the default controller's
  useEffect(() => {
    if (revealTasks === 0) return
    setFolded((f) => {
      if (!f.has('controller')) return f
      const next = new Set(f)
      next.delete('controller')
      return next
    })
    // (the tree's own window: in a popped-out panel the main window may be minimised, and its frames stop)
    const win = rootRef.current?.ownerDocument.defaultView ?? window
    win.requestAnimationFrame(() => {
      const box = rootRef.current
      const at = tasksRef.current
      if (box && at) box.scrollTop += at.getBoundingClientRect().top - box.getBoundingClientRect().top - 4
    })
  }, [revealTasks])

  // keep the reader's block on screen as they move through the code
  useLayoutEffect(() => {
    if (activeBlock < 0) return
    keepInView(rootRef.current, rootRef.current?.querySelector(`[data-block-index="${activeBlock}"]`))
  }, [activeBlock])

  const picked = (): void => onPicked?.()
  const tableTitle = (what: string): string => (readOnly ? readOnlyNote : ownConfiguration ? t(M.tableInCode) : what)
  const editTable = (next: Controller, renames: TagRename[], label: string): void => {
    setNote(null)
    editController(next, renames, label)
  }

  // ---- names ------------------------------------------------------------------------------------------------------

  const commitRename = (fromBlur: boolean): void => {
    const r = renamingRef.current
    const commit = renameCommit.current
    if (!r || !commit) return
    renamingRef.current = null
    const why = commit(r.value)
    if (why === null) return setRenaming(null)
    if (fromBlur) {
      setRenaming(null)
      return setNote(why)
    }
    renamingRef.current = { ...r, error: why }
    setRenaming({ ...r, error: why })
  }
  const addProgram = (kind: string, task?: string): void => {
    setNote(null)
    const name = content.suggestProgram(kind)
    if (name === null) return
    setFolded((f) => {
      const next = new Set(f)
      next.delete(task === undefined ? 'programs' : `task:${task}`)
      return next
    })
    setDrafting({ kind, ...(task !== undefined ? { task } : {}), value: name, error: null })
  }
  const commitDraft = (fromBlur: boolean): void => {
    const d = draftingRef.current
    if (!d) return
    draftingRef.current = null
    const why = content.addProgram(d.value, d.kind, d.task)
    if (why === null || fromBlur) {
      setDrafting(null)
      if (why !== null) setNote(why)
      else picked()
      return
    }
    draftingRef.current = { ...d, error: why }
    setDrafting({ ...d, error: why })
  }
  const draftField = (task: string | undefined): ReactNode => {
    if (!drafting || drafting.task !== task) return null
    const lang = content.draftLanguage(drafting.kind)
    return (
      <div className="org-row org-edit-row" data-lang={lang?.tag}>
        <span className="org-icon" aria-hidden="true">
          ▤
        </span>
        <NameField
          value={drafting.value}
          testid="org-new-program-name"
          label={t(M.newProgramName, { language: lang.name })}
          error={drafting.error}
          onChange={(v) => setDrafting({ ...drafting, value: v, error: null })}
          onCommit={commitDraft}
          onCancel={() => {
            draftingRef.current = null
            setDrafting(null)
          }}
        />
        <span className={`org-lang${lang.ladder ? ' ld' : ''}`} data-testid="org-new-program-lang" title={t(M.newProgramBadge, { language: lang.name })}>
          {lang.tag}
        </span>
        {drafting.error && (
          <div className="org-error" role="alert" data-testid="org-note">
            ⚠ {drafting.error}
          </div>
        )}
      </div>
    )
  }

  const ctx: TreeCtx = {
    readOnly,
    readOnlyNote,
    tableLocked,
    tableTitle,
    isFolded,
    toggle,
    openMenu,
    menuBelow,
    openDialog,
    setNote,
    editTable,
    picked,
    rename: {
      active: (key) => renaming?.key === key,
      begin: (key, value, commit) => {
        if (readOnly) return
        setNote(null)
        renameCommit.current = commit
        setRenaming({ key, value, error: null })
      },
      field: (key, { testid, label }) =>
        renaming?.key !== key ? null : (
          <>
            <NameField
              value={renaming.value}
              testid={testid}
              label={label}
              error={renaming.error}
              onChange={(v) => setRenaming({ ...renaming, value: v, error: null })}
              onCommit={commitRename}
              onCancel={() => {
                renamingRef.current = null
                setRenaming(null)
              }}
            />
            {renaming.error && (
              <div className="org-error" role="alert" data-testid="org-note">
                ⚠ {renaming.error}
              </div>
            )}
          </>
        ),
    },
    addProgram,
    draftField,
  }

  // ---- tasks ------------------------------------------------------------------------------------------------------

  const openProgramProps = (index: number): void => openDialog((close) => content.programDialog(index, close, ctx))
  const openTaskProps = (index: number): void => openDialog((close) => content.taskDialog(index, close, ctx))

  /** A program: an instance under the task that runs it (`scheduled`), or one on the list no task runs. */
  const programRow = (p: TaskTreeProgram, scheduled: boolean): ReactElement => {
    const index = content.program.block(p)
    const open = (): void => {
      if (scheduled) content.program.monitor(p)
      if (index < 0) return
      content.program.open(index)
      picked()
    }
    const pinned = content.program.pinned(p)
    const shown = scheduled ? content.program.shown(p) : null
    const stop = (): void => editTable(removeProgram(controller, p.index), [], t(M.undoStopRunning, { name: p.name }))
    const run = (): void => editTable(scheduleProgram(controller, p.type), [], t(M.undoRun, { name: p.type ?? content.program.label(p) }))
    const firstTask = controller.tasks[0]?.name
    const parts: ProgramMenuParts & { schedule: MenuItem } = {
      showCode: { label: t(M.showCode), disabled: index < 0, onClick: open },
      properties: { label: t(M.properties), testid: 'org-program-properties', disabled: !scheduled, onClick: () => openProgramProps(p.index) },
      runEarlier: { label: t(M.runEarlier), disabled: !scheduled || tableLocked || p.index === 0, title: tableTitle(t(M.runEarlierHint)), onClick: () => editTable(moveProgram(controller, p.index, -1), [], t(M.undoReorder, { name: p.name })) },
      runLater: { label: t(M.runLater), disabled: !scheduled || tableLocked || p.index === controller.programs.length - 1, title: tableTitle(t(M.runLaterHint)), onClick: () => editTable(moveProgram(controller, p.index, 1), [], t(M.undoReorder, { name: p.name })) },
      stopRunning: {
        label: t(M.stopRunning),
        testid: 'org-unschedule',
        disabled: !scheduled || tableLocked || pinned !== null,
        title: pinned ?? tableTitle(t(p.type === null ? M.stopTopLevelHint : M.stopProgramHint)),
        onClick: stop,
      },
      schedule: { label: firstTask ? t(M.runOn, { task: firstTask }) : t(M.runEveryStep), testid: 'org-schedule-item', disabled: scheduled || tableLocked, title: tableTitle(t(M.scheduleHint)), onClick: run },
    }
    const key = scheduled ? `prog:${p.index}:${p.name}` : `unrun:${p.type ?? ''}`
    const isActive = index >= 0 && index === activeBlock
    const kind = content.program.kind(p)
    return (
      <div
        key={key}
        className={`org-row org-program${isActive ? ' active' : ''}${scheduled ? '' : ' idle'}`}
        role="treeitem"
        tabIndex={0}
        data-testid={scheduled ? 'org-program' : 'org-unscheduled'}
        data-program={scheduled ? p.name : (p.type ?? '')}
        title={
          scheduled
            ? p.type === null
              ? t(p.exists ? M.runsTopLevel : M.runsTopLevelMissing)
              : t(p.exists ? M.runsProgram : M.runsProgramMissing, { type: p.type })
            : t(M.unscheduledHint)
        }
        onClick={open}
        onDoubleClick={() => scheduled && openProgramProps(p.index)}
        onContextMenu={(e) => openMenu(e, content.program.menu(p, parts, scheduled))}
        onKeyDown={(e) => {
          // F2: its Properties, where a program is renamed (and its PROGRAM in the code with it)
          if (scheduled && !readOnly) onRenameKey(() => openProgramProps(p.index))(e)
          if (e.defaultPrevented || e.key !== 'Enter' || index < 0) return
          open()
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <span className="org-name">{content.program.label(p)}</span>
        {kind !== null && <span className="org-kind">{kind}</span>}
        {shown && (
          <span className="org-kind" data-testid="org-monitored" title={shown.title}>
            {shown.label}
          </span>
        )}
        {!p.exists && (
          <span className="org-kind warn" title={t(M.missingHint)}>
            {t(M.missing)}
          </span>
        )}
        {!scheduled && !tableLocked && (
          <button
            type="button"
            className="org-btn"
            data-testid="org-schedule"
            title={firstTask ? t(M.runItOn, { task: firstTask }) : t(M.runItEveryStep)}
            onClick={(e) => {
              e.stopPropagation()
              run()
            }}
          >
            {t(M.run)}
          </button>
        )}
      </div>
    )
  }

  const deleteTask = (task: TaskTreeTask): void => {
    const next = removeTask(controller, task.index)
    if (!next) {
      const running = programsOnTask(controller, task.index)
      return setNote(t(M.taskBusy, { count: running.length, task: task.name, programs: running.join(', ') }))
    }
    editTable(next, [], t(M.undoRemoveTask, { name: task.name }))
  }

  const taskNode = (task: TaskTreeTask): ReactElement => {
    const key = `task:${task.name}`
    const closed = folded.has(key)
    const parts: TaskMenuParts = {
      properties: { label: t(M.properties), testid: 'org-task-properties', onClick: () => openTaskProps(task.index) },
      delete: {
        label: t(M.delete),
        testid: 'org-task-delete',
        disabled: tableLocked,
        title: tableTitle(t(M.deleteTaskHint)),
        onClick: () => deleteTask(task),
      },
    }
    return (
      <div key={key} className="org-task" data-testid="org-task" data-task={task.name}>
        <div
          className="org-head task"
          role="treeitem"
          tabIndex={0}
          aria-expanded={!closed}
          title={t(M.taskHint, { interval: task.intervalMs, priority: task.priority })}
          onClick={() => toggle(key)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            openTaskProps(task.index)
          }}
          onContextMenu={(e) => openMenu(e, content.taskMenu(task, parts, ctx))}
          onKeyDown={(e) => e.key === 'Enter' && openTaskProps(task.index)}
        >
          <span className="org-fold" aria-hidden="true">
            <FoldIcon closed={closed} />
          </span>
          <span className="org-icon" aria-hidden="true">
            ◷
          </span>
          <span className="org-title">{task.name}</span>
          <span className="org-kind" data-testid="org-task-interval">
            {t(M.interval, { interval: task.intervalMs })}
          </span>
        </div>
        {!closed && (
          <div className="org-children">
            {task.programs.length === 0 && drafting?.task !== task.name && <div className="org-empty">{t(M.runsNothing)}</div>}
            {task.programs.map((p) => programRow(p, true))}
            {draftField(task.name)}
          </div>
        )}
      </div>
    )
  }

  /** A group of instances that belong to no task of the table: every step, or a task that is gone. */
  const looseGroup = (key: string, icon: string, title: string, hint: string, rows: TaskTreeProgram[]): ReactElement | null => {
    if (rows.length === 0) return null
    const closed = folded.has(key)
    return (
      <div className="org-task" data-testid={`org-${key}`}>
        <div className="org-head task" role="button" tabIndex={0} aria-expanded={!closed} title={hint} onClick={() => toggle(key)} onKeyDown={(e) => e.key === 'Enter' && toggle(key)}>
          <span className="org-fold" aria-hidden="true">
            <FoldIcon closed={closed} />
          </span>
          <span className="org-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="org-title">{title}</span>
        </div>
        {!closed && <div className="org-children">{rows.map((p) => programRow(p, true))}</div>}
      </div>
    )
  }

  // what nothing runs: PROGRAMs no instance runs, and the code outside every PROGRAM when no instance runs it
  const unrun = content.unscheduled(tree)
  const unscheduledGroup = unrun.length > 0 && (
    <div className="org-task" data-testid="org-not-running">
      <div className="org-head task" role="button" tabIndex={0} aria-expanded={!folded.has('unrun')} title={t(M.notRunningHint)} onClick={() => toggle('unrun')} onKeyDown={(e) => e.key === 'Enter' && toggle('unrun')}>
        <span className="org-fold" aria-hidden="true">
          <FoldIcon closed={folded.has('unrun')} />
        </span>
        <span className="org-icon" aria-hidden="true">
          ▢
        </span>
        <span className="org-title">{t(M.notRunning)}</span>
      </div>
      {!folded.has('unrun') && <div className="org-children">{unrun.map((type) => programRow({ index: -1, name: type ?? '', type, exists: true }, false))}</div>}
    </div>
  )

  // ---- the controllers --------------------------------------------------------------------------------------------

  /**
   * One controller, owning its tasks and the program instances on them: IEC's resource. The default controller's node
   * also holds the code outside every POU, which is its own, and what concerns the whole table: its problems, an
   * instance on a task the table lacks, and the PROGRAMs nothing runs. A PLC outside the app runs no program here, and
   * says so. With one controller there is one node, so adding another adds a sibling and moves nothing.
   */
  const controllerNode = (g: TaskTreeGroup): ReactElement => {
    const isDefault = g.plc === null
    const several = tree.groups.length > 1
    const name = isDefault ? (props.plcs?.defaultName ?? t(M.controller)) : g.plc!
    const key = isDefault ? 'controller' : `plc:${g.plc}`
    const closed = folded.has(key)
    const entry = isDefault ? undefined : props.plcs?.named.find((c) => c.name.toLowerCase() === g.plc!.toLowerCase())
    // a controller only a task names, which the project does not list: nothing runs it, so the node claims no setup
    const unlisted = !isDefault && props.plcs !== undefined && entry === undefined
    const simulated = isDefault ? (props.plcs?.defaultSimulated ?? true) : (entry?.simulated ?? false)
    // a lone controller says where it runs as the runs-on line always has; beside others it is also the default one
    const kind = unlisted
      ? t(M.plcUnlisted)
      : !isDefault
        ? t(simulated ? M.plcSimulated : M.plcExternal)
        : several
          ? t(simulated ? M.plcDefaultSimulated : M.plcDefaultExternal)
          : t(simulated ? M.plcSimulated : M.plcExternal)
    const addTaskHere = (): void => editTable(addTask(controller, g.plc ?? undefined), [], t(M.undoAddTask))
    const menu: MenuItem[] = [
      { label: t(M.properties), testid: isDefault ? 'org-controller-properties' : 'org-plc-properties', onClick: onControllerProperties },
      { label: t(M.newTaskOn, { name }), testid: isDefault ? 'org-controller-new-task' : 'org-plc-new-task', disabled: tableLocked, title: tableTitle(t(M.newTaskHint)), onClick: addTaskHere },
      ...(isDefault ? content.controllerMenu(ctx) : []),
      // beside other controllers each PLC takes a download of its own; alone, the File menu's export is the whole program
      ...(props.onExportController && several && !ownConfiguration && (g.tasks.some((k) => k.programs.length > 0) || g.continuous.length > 0)
        ? [
            { label: '-', onClick: () => {} },
            { label: t(M.exportSt, { name }), testid: 'org-export-st', title: t(M.exportHint, { name }), onClick: () => props.onExportController!(g.plc, 'iec-text') },
            { label: t(M.exportXml, { name }), testid: 'org-export-xml', title: t(M.exportHint, { name }), onClick: () => props.onExportController!(g.plc, 'plcopen-xml') },
          ]
        : []),
    ]
    const tasks = (
      <>
        {g.tasks.map(taskNode)}
        {looseGroup(isDefault ? 'every-step' : `every-step-${g.plc}`, '⟳', t(M.everyStep), t(M.everyStepHint), g.continuous)}
      </>
    )
    return (
      <div
        key={key}
        className="org-section"
        data-testid={isDefault ? 'org-group' : 'org-plc'}
        data-group={isDefault ? 'controller' : undefined}
        data-plc={g.plc ?? ''}
        role="group"
        aria-label={name}
      >
        <div
          className="org-head top"
          role="treeitem"
          tabIndex={0}
          aria-expanded={!closed}
          data-testid={isDefault ? 'org-controller' : 'org-plc-head'}
          title={isDefault ? t(M.controllerHint) : t(M.plcHint, { name })}
          onClick={() => toggle(key)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onControllerProperties()
          }}
          onContextMenu={(e) => openMenu(e, menu)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            e.stopPropagation()
            onControllerProperties()
          }}
        >
          <span className="org-fold" aria-hidden="true">
            <FoldIcon closed={closed} />
          </span>
          {/* i18n-ok: the controller's name, as the tags spell it */}
          <span className="org-title">{name}</span>
          <span className="org-kind" data-testid={isDefault ? 'org-controller-runs-on' : 'org-plc-kind'} data-unlisted={unlisted || undefined}>
            {kind}
          </span>
          {isDefault && problems.length > 0 && (
            <span className="org-problem-count" data-testid="org-problem-count" title={problems.join('\n')}>
              {t(M.problems, { count: problems.length })}
            </span>
          )}
          {!tableLocked && (
            <button
              type="button"
              className="org-btn"
              data-testid={isDefault ? 'org-new-task' : 'org-plc-new-task-button'}
              title={t(M.newTaskOn, { name })}
              aria-label={t(M.newTaskOn, { name })}
              onClick={(e) => {
                e.stopPropagation()
                addTaskHere()
              }}
            >
              +
            </button>
          )}
        </div>
        {!closed && (
          <div className="org-children">
            {isDefault && content.controllerChildren(ctx)}
            {isDefault ? (
              <div ref={tasksRef} data-testid="org-group" data-group="tasks" role="group" aria-label={t(M.tasks)}>
                {problems.map((m) => (
                  <div key={m} className="org-error" role="alert" data-testid="org-problem">
                    ⚠ {m}
                  </div>
                ))}
                {note && (
                  <div className="org-error" role="alert" data-testid="org-note">
                    ⚠ {note}
                  </div>
                )}
                {ownConfiguration ? (
                  content.ownConfiguration(ctx)
                ) : (
                  <>
                    {tasks}
                    {looseGroup('missing-task', '⚠', t(M.missingTask), t(M.missingTaskHint), tree.lost)}
                    {unscheduledGroup}
                  </>
                )}
              </div>
            ) : (
              <>
                {unlisted && (
                  <div className="org-error" role="alert" data-testid="org-plc-unlisted">
                    ⚠ {t(M.plcUnlistedNote)}
                    <button type="button" className="org-btn org-inline-btn" data-testid="org-plc-set-up" title={t(M.plcSetUpHint, { name })} onClick={onControllerProperties}>
                      {t(M.plcSetUp)}
                    </button>
                  </div>
                )}
                {tasks}
              </>
            )}
            {!simulated && !unlisted && g.tasks.length === 0 && g.continuous.length === 0 && <div className="org-empty">{t(M.plcNoProgram)}</div>}
          </div>
        )}
      </div>
    )
  }

  // ---- the scene's devices ------------------------------------------------------------------------------------------

  /** The scene's parts that speak tags, by kind: what each is wired to, and the door to its own tags. */
  const devicesSection = (d: OrganizerDevices): ReactElement => {
    const list = d.list
    const closed = folded.has('devices')
    return (
      <div className="org-section" data-testid="org-devices" role="group" aria-label={t(M.devices)}>
        <div className="org-head top" role="button" tabIndex={0} aria-expanded={!closed} onClick={() => toggle('devices')} onKeyDown={(e) => e.key === 'Enter' && toggle('devices')}>
          <span className="org-fold" aria-hidden="true">
            <FoldIcon closed={closed} />
          </span>
          <span className="org-title">{t(M.devices)}</span>
          <span className="org-count">{list.length}</span>
        </div>
        {!closed && (
          <div className="org-children">
            {list.length === 0 && <div className="org-empty">{t(M.noDevices)}</div>}
            {[...new Set(list.map((dev) => dev.kind))].map((kind) => {
              const key = `dev:${kind}`
              const own = list.filter((dev) => dev.kind === kind)
              // a kind starts closed: the header's kinds and counts are the overview, and a scene's devices outnumber
              // the program rows above them
              const kindClosed = isFolded(key, true)
              return (
                <div key={key} className="org-group" data-testid="org-device-kind">
                  <div className="org-head" role="treeitem" tabIndex={0} aria-expanded={!kindClosed} onClick={() => toggle(key)}>
                    <span className="org-fold" aria-hidden="true">
                      <FoldIcon closed={kindClosed} />
                    </span>
                    <span className="org-title">{kind}</span>
                    <span className="org-count">{own.length}</span>
                  </div>
                  {!kindClosed && (
                    <div className="org-children">
                      {own.map((dev) => {
                        const wired = dev.fields.filter((f) => f.value !== '').length
                        return (
                          <div
                            key={dev.id}
                            className="org-row"
                            data-testid="org-device"
                            title={t(!dev.switchable ? M.deviceHint : dev.enabled ? M.deviceHintOn : M.deviceHintOff, { count: dev.fields.length, wired })}
                            onClick={() => d.select(dev.id)}
                            onDoubleClick={() => popups.current?.device(dev.id)}
                          >
                            {/* the switch's state, for a part that declares one; any other part is connected by its named tags */}
                            {dev.switchable && <span className={`org-comms${dev.enabled ? ' on' : ''}`} title={t(dev.enabled ? M.commsOn : M.commsOff)} />}
                            <span className="org-name">{dev.name}</span>
                            {forcedDevices.has(dev.id) && (
                              <span className="org-forced" data-testid="org-device-forced" title={t(M.forcedHint)}>
                                {t(M.forced)}
                              </span>
                            )}
                            <span className="org-kind">{dev.fields.filter((f) => f.value !== '').map((f) => f.value).join(', ') || t(dev.enabled ? M.noTagsWired : M.commsOffShort)}</span>
                            <span className="org-cmds">
                              <button type="button" className="org-btn" data-testid="org-device-tags" title={t(M.deviceTagsHint)} onClick={(e) => { e.stopPropagation(); popups.current?.device(dev.id) }}>
                                {t(M.deviceTags)}
                              </button>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const newMenu = readOnly ? null : content.newMenu(ctx)
  return (
    <div ref={rootRef} className="org-root" data-testid="plc-organizer" role="tree" aria-label={t(M.organizer)}>
      <div className="org-bar">
        {newMenu && (
          <button type="button" className="org-btn" data-testid="org-new" title={newMenu.title} aria-haspopup="menu" onClick={(e) => menuBelow(e, newMenu.items)}>
            {t(M.new)}
          </button>
        )}
      </div>
      {readOnly && (
        <div className="org-empty org-readonly" data-testid="org-readonly">
          {readOnlyNote}
        </div>
      )}
      {tree.groups.map(controllerNode)}
      {content.groups(ctx)}
      {devices && devicesSection(devices)}
      <Popups ref={popups} devices={devices} />
    </div>
  )
}
