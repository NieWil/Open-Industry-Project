import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react'
import { keymapRev, resolveKeyAction, subscribeKeymap } from '../../../core/keymap'
import { primaryKey, withKey } from '../../keyHint'
import type { TagScope } from '../../../plc/tags'
import type { Diagnostic, TagValue } from '../../../plc/types'
import {
  addBranch,
  addLevel,
  addPath,
  addRung,
  branchOf,
  canAddPath,
  elementAt,
  elementRange,
  insertElements,
  insertRungs,
  moveRung,
  removeRange,
  removeRungs,
  removeSelected,
  replaceRung,
  selKind,
  seriesLength,
  setComment,
  stepInstruction,
  isBranch,
  type LadderEdit,
  type LadderSel,
} from '../../../plc/ladder/ladderEdit'
import type { LadderRoutine, Rung, RungElement, RungItem } from '../../../plc/ladder/ladderRungs'
import { crossReference, duplicateDestructive } from '../../../plc/crossRef'
import { devicesForTag, type DeviceTags } from '../../../plc/bindings'
import { CrossRefDialog } from './CrossRefDialog'
import { BoxPicker } from './BoxPicker'
import { completeName } from '../../../plc/ladder/ladderComplete'
import { LADDER, RoutineHead, type PaletteEntry, type Power } from './ladderLeaf'
import { ContextMenu, type MenuItem } from '../inspector/menu'
import { activeClipboard } from '../../dialogHost'
import { fmt } from './ladderWatch'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'
import { withWatchValue } from '../../../core/watchKeys'
import { tNodes } from '../../i18nNodes'
import { FRONT } from './ladderSel'
import type { Sel } from './ladderSel'
import { isEl, useLadderZoom, useRungsInView, useWrapLinks, ZOOM_STEP } from './useLadderSheet'
import { useLadderWatch } from './useLadderWatch'
import { useLadderFind } from './useLadderFind'
import { useLadderDrags } from './useLadderDrags'

const M = defineMessages('ladder', {
  notOneRung: "'{text}' does not read as one rung",
  cannotWrite: 'this view cannot write to the running program',
  operand: 'Operand',
  pinOpenVariable: '{pin}: not connected. Double-click to connect it to a variable',
  pinOpenValue: '{pin}: not connected. Double-click to connect it to a value',
  valueOf: 'Value of {name}',
  liveWritable: "{name} in the running program: double-click to write a value (the program's own next write wins)",
  branchNode: 'Drag to extend or shorten the branch over its neighbors',
  rungRef: 'rung {rung}',
  rungRefOf: 'rung {rung} of section {section}',
  duplicateHere: '{name} is written more than once on this rung every scan. The last one to run decides it',
  duplicateOthers: 'Duplicate destructive reference: {name} is also written on {rungs} every scan. The last one to run decides it',
  rungNumber: 'Click to select the rung, drag to move it, double-click to retype it as text',
  labelHint: 'Label: a jump to it lands on this rung',
  rungText: 'Rung text',
  jumpHint: 'Jump: while this rung is on, the rungs down to {label} are skipped',
  returnHint: 'Return: while this rung is on, the rest of the POU is skipped this scan',
  showElement: 'Show the element this is about',
  noLadder: 'This program has no ladder.',
  noLadderHint: 'Add one from the organizer: + New > Ladder program, or right-click a task > New ladder program.',
  fixRungText: 'Fix the rung text first: "Show as text" on its row in the organizer',
  cut: 'Cut',
  copy: 'Copy',
  copyHint: 'Copy the selected elements (Shift-click selects a run) or rungs, as rung text',
  paste: 'Paste',
  pasteHint: 'Elements go after the selection, rungs below the selected rung',
  delete: 'Delete',
  commentRung: 'Comment Rung',
  moveRungUp: 'Move Rung Up',
  moveRungDown: 'Move Rung Down',
  addBranchLevel: 'Add Branch Level',
  addBranchLevelHint: 'One more level on the selected branch',
  toggleBit: 'Toggle Bit',
  addNameToWatch: 'Add {name} to Watch',
  addToWatch: 'Add to Watch',
  addToWatchHint: 'Follow its live value in the Watch dock',
  toggleBitHint: 'Toggle the BOOL under the selection, once',
  toggleBitIdle: 'Toggle Bit works while the program runs',
  toggleBitForcedHint: 'Hold the forced BOOL under the selection at the opposite value',
  forceName: 'Force {name}',
  forceHint: 'Hold it at its current value across scans until released, whatever the program writes',
  releaseName: 'Release {name}',
  releaseHint: 'Let the program write it again',
  // a mark, not a word: the badge beside a forced operand (a translation may use its own letter)
  forcedMark: 'F',
  forcedTitle: 'Forced: held at {value} until released',
  crossReference: 'Cross Reference',
  crossReferenceHint: 'Everywhere the variable under the selection is used',
  findItem: 'Find…',
  findItemHint: 'Find (and Replace) in the rungs: fields, function names, comments',
  zoom: 'Ladder drawn at {percent}%. Click for 100%',
  dismiss: 'Dismiss',
  idle: '{program} is not running: the Controller runs {running}.',
  idleLive: '{program} is not running, so nothing here is lit: the Controller runs {running}.',
  find: 'Find',
  replaceWith: 'Replace with',
  previousMatch: 'Previous match',
  nextMatch: 'Next match',
  readOnly: 'Read-only',
  replaceHint: 'Replace this match and go to the next',
  replace: 'Replace',
  replaceAllHint: 'Replace every match in the scope, as one undo step',
  replaceAll: 'Replace All',
  showReplace: 'Replace…',
  hideReplace: 'Hide the replace field',
  wholeWordHint: 'Match the whole name: Belt1 is not found in Belt10 or Belt1_Run, and is in Belt1.Run',
  wholeWord: 'Match whole word',
  wrapHint: 'Past the last match, go on from the first (and the other way about)',
  wrap: 'Wrap',
  thisSection: 'This section',
  allSections: 'All sections',
  close: 'Close (Esc)',
  boxPrompt: 'Find a block or function: TON, LIMIT, INT_TO_REAL…',
  addRungHint: 'Add a rung below the selected one',
  addRung: '+ Rung',
  branchHint: 'An empty branch after the selected element (or at the start of the selected rung). Drag its end over neighbors to stretch it; the next element you pick goes on its lower level',
  branch: 'Branch',
  branchLevelHint: 'One more level on the selected branch (select the branch, a level, or anything on one)',
  branchLevel: 'Branch Level',
  insertBoxHint: "Any function block or function, found by typing: this program's own, then the standard library",
  insertBox: 'Block…',
  jumpAddHint: 'End the selected rung in a jump: while it is on, the rungs down to the label are skipped. Type the label it goes to',
  jump: 'Jump',
  labelAddHint: 'Name the selected rung, so a jump can land on it',
  label: 'Label',
  returnAddHint: 'End the selected rung in a RETURN: while it is on, the rest of the POU is skipped this scan',
  return: 'Return',
  paletteHint: '{what}: after the selected element, or at the start of the selected rung or level',
  toggleBitButton: '{what}. A bit the program writes is written back by its next scan, and one it only reads stays until toggled again. A forced bit is held at the new value',
  moreHint: 'Cut, copy, paste, delete, comment, move, cross reference, find: the same menu a right-click on a rung or element opens',
  elementSets: 'Element sets',
  unreadable: 'Part of this section does not read as a rung, so it is shown but cannot be edited here: {message} (line {line}). Fix it in the text: "Show as text" on its row in the organizer.',
  noRungs: 'No rungs. Use “+ Rung”.',
})

/** a line between groups of a menu (inspector/menu.tsx draws a `-` item as one) */
const SEPARATOR: MenuItem = { label: '-', onClick: () => {} }

// The program's ladder, drawn as ladder: the PLC panel's Ladder face.
//
// A view over the text, like the organizer beside it: rungs are read out of the program's one source string, a gesture
// changes them (plc/ladder/ladderEdit.ts, the shared rung core), and they are printed back into it through `onEdit` - an
// ordinary edit to the text, which is why a rung built here saves, undoes and reaches a room's other editors with no
// code of its own. Nothing is kept here but the selection and what is being typed.
//
// The sheet owns the layout, the gestures (selection, the arrow walk, dragging elements, rungs and branch ends, a rung
// too long for the view wrapping underneath) and drawing only what changed. What a leaf is comes from ladderLeaf.tsx
// (`LADDER`): how rungs are read and printed, what a leaf looks like - a contact, a coil or a box - how power passes it,
// and the element bar.
//
// Power flow is recomputed here from the variable image the running program publishes (`getWatch`), through
// `LADDER.powerOut`: a display, not the engine's own answer.

interface LadderViewProps {
  source: string
  /** the whole program back, with the ladder edit in it */
  onEdit: (next: string) => void
  onUndo: () => void
  onRedo: () => void
  /** What is wrong with the program, positioned in `source`. Asked for, not worked out while drawing: checking a
   *  program reads all of it, so the panel asks the program worker (program/programWorkerClient.ts) and the sheet
   *  draws its rungs first and marks the problems when the answer is in. */
  getDiagnostics: (source: string) => Promise<Diagnostic[]>
  /** select the element the problem at this source offset is about, opening its routine (`n` makes each ask new) */
  revealProblem?: { offset: number; n: number } | null
  /** what the running controller faulted on, as problems of the elements it happened in: drawn exactly like an error
   *  the compiler found */
  faults?: readonly Diagnostic[]
  /** the running program's variable image, or nothing when none runs */
  getWatch: () => Readonly<Record<string, TagValue>> | null | undefined
  live: boolean
  readOnly: boolean
  /** the scene's PLC tags, offered while naming an operand */
  getTags: () => string[]
  /** the scene's devices, for the Cross Reference's "which part is wired to this tag" (plc `devicesForTag`); a sheet
   *  with no scene behind it leaves it out and the dialog says nothing about parts */
  getDevices?: () => readonly DeviceTags[]
  /** a routine to scroll to, asked by the organizer; `onRevealedRoutine` once done */
  revealRoutine?: number | null
  /** ...and the rung of it to select (a call the organizer went to), rather than its first */
  revealRung?: number
  onRevealedRoutine?: () => void
  /** the PROGRAMs no task runs (upper case), and what does run, for saying so; absent when every PROGRAM runs */
  idle?: { programs: ReadonlySet<string>; running: string } | null
  /** show a place in the program as text: a declaration pane's "where is this declared" */
  onShowText?: (offset: number) => void
  /** rename a declaration, with the scene's wiring (see `RoutineHeadProps.onRenameTag`); absent = no renaming here */
  onRenameTag?: (scope: TagScope, from: string, to: string) => Promise<string | null>
  /** flip a BOOL of the running program once (Toggle Bit), by its watch key; false when it could not */
  toggleBit?: (key: string) => boolean
  /** write a value typed under an operand into the running program, by its watch key: null when it was written, else why
   *  not (EditorController.writePlcValue) */
  writeLive?: (key: string, text: string) => string | null
  /** the running program's forced variables, by watch key: each operand on one is marked */
  getForces?: () => Readonly<Record<string, number | boolean>>
  /** told when a force is set or released; returns an unsubscribe */
  onForcesChange?: (cb: () => void) => () => void
  /** Add to Watch: put a variable on the Watch dock's list (absent = no such item) */
  onWatch?: (name: string) => void
  /** hold a variable of the running program at its current value, by watch key: null when held, else why not */
  onForce?: (key: string) => string | null
  /** release a forced variable, by watch key */
  onRelease?: (key: string) => void
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A field that is a place (a variable, a member, an element), which a value can be written into - not an expression. */
const PLACE = /^\s*[A-Za-z_][A-Za-z0-9_]*(\s*(\.\s*[A-Za-z_0-9]+|\[[^\]]*\]))*\s*$/

const NO_FAULTS: readonly Diagnostic[] = []

export function LadderView({ revealProblem = null, faults = NO_FAULTS, source, onEdit, onUndo, onRedo, getDiagnostics, getWatch, live: running, readOnly, getTags, getDevices, revealRoutine = null, revealRung, onRevealedRoutine, idle, onShowText, onRenameTag, toggleBit, writeLive, getForces, onForcesChange, onWatch, onForce, onRelease }: LadderViewProps): ReactElement {
  // the program's problems, for the text they were found in: an edit draws without them until its own are in
  const [checked, setChecked] = useState<{ source: string; found: readonly Diagnostic[] } | null>(null)
  const askDiagnostics = useRef(getDiagnostics)
  askDiagnostics.current = getDiagnostics
  useEffect(() => {
    let live = true
    void askDiagnostics.current(source).then(
      (list) => {
        // (none is the answer the sheet already drew: the same list, so the rungs are not read again for it)
        if (live) setChecked({ source, found: list.length > 0 ? list : NO_FAULTS })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [source])
  const problems = checked?.source === source ? checked.found : NO_FAULTS
  const routines = useMemo(() => LADDER.read(source, faults.length > 0 ? [...problems, ...faults] : problems), [source, faults, problems])
  // A PROGRAM drawn here that no task runs is not what is running, so nothing here is lit: its variables would
  // otherwise answer from the program that is running, which shares its names when it is another version of it
  const idleRoutine = routines.find((r) => r.pou !== '' && idle?.running !== undefined && idle.programs.has(r.pou.toUpperCase()))
  const idleProgram = idleRoutine ? idleRoutine.pou : null
  const live = running && idleProgram === null
  // the selection's menu names its chords from the active keymap (they run through it: resolveKeyAction below)
  useSyncExternalStore(subscribeKeymap, keymapRev)
  const [sel, setSelState] = useState<Sel | null>(null)
  // a Shift-click - or Shift + an arrow key - extends the selection from its anchor: along its series for an element,
  // up and down the routine for a rung. `rangeEnd` is the other end's index (an element index, or a rung index).
  const [rangeEnd, setRangeEnd] = useState<number | null>(null)
  const setSel = (s: Sel | null): void => {
    setRangeEnd(null)
    setSelState(s)
  }
  // what was last copied here, and when: for a browser that will not hand the clipboard back (readText denied), and
  // for a paste that follows the copy so closely that the OS clipboard has not caught up with it yet
  const clipRef = useRef<string>('')
  const clipAt = useRef(0)
  const ownClip = (fromEvent: string): string => (clipRef.current !== '' && Date.now() - clipAt.current < 600 ? clipRef.current : fromEvent || clipRef.current)
  // what the last copy here was: a branch level pastes as a new level, elements paste onto the level selected
  const clipKind = useRef<'elements' | 'level' | 'rungs' | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // Ctrl+wheel and the ladder.zoom* keys scale the drawing (useLadderSheet.ts)
  const { zoom, zoomNow, stepZoom } = useLadderZoom(rootRef, scrollRef, zoomRef, routines.length === 0)

  const inView = useRungsInView(scrollRef, routines)

  useWrapLinks(scrollRef, zoomRef, routines.length === 0)

  // Both fields are mirrored in refs: Enter commits and unmounts the field, and the blur that removal fires must not
  // find the draft still there and commit it a second time.
  // `connected`: the field is a pin just connected from its open row (`connect`), which backing out takes off again
  const [editing, setEditingState] = useState<{ at: Sel; field: number; draft: string; leaving?: boolean; connected?: boolean } | null>(null)
  const editingRef = useRef(editing)
  const setEditing = (e: typeof editing): void => {
    editingRef.current = e
    setEditingState(e)
  }
  // why the text just typed was refused, shown until the next keystroke
  const [opError, setOpError] = useState<string | null>(null)
  // Type-ahead (plc/ladder/ladderComplete.ts): the rest of the first name that continues what was
  // typed appears after the caret, selected - so typing on replaces it, and only Enter (or Tab) takes it. `proposal`
  // is where the typed text ends while one is showing; leaving the field any other way keeps the typed text alone.
  const proposal = useRef<number | null>(null)
  const selectProposal = useRef<{ field: HTMLInputElement; from: number; to: number } | null>(null)
  useLayoutEffect(() => {
    const p = selectProposal.current
    selectProposal.current = null
    if (p && p.field.isConnected) p.field.setSelectionRange(p.from, p.to)
  })
  /** A field's new text, with the ending type-ahead proposes for it - only while the author is adding at the end. */
  const withProposal = (e: ChangeEvent<HTMLInputElement>, complete: (typed: string) => string | null): string => {
    const input = e.target
    const typed = input.value
    proposal.current = null
    const kind = (e.nativeEvent as InputEvent).inputType ?? ''
    // a deletion is never answered with a proposal (Backspace would be unable to delete), nor is an edit mid-text
    if (!kind.startsWith('insert') || input.selectionStart !== typed.length) return typed
    const full = complete(typed)
    if (full === null) return typed
    proposal.current = typed.length
    selectProposal.current = { field: input, from: typed.length, to: full.length }
    return full
  }
  /** The text a field is left with when it loses focus: what was typed, without an ending nobody accepted. */
  const withoutProposal = (draft: string): string => (proposal.current === null ? draft : draft.slice(0, proposal.current))
  const [paletteTab, setPaletteTab] = useState(LADDER.palette[0]?.tab ?? '')
  // a rung being retyped as text (double-click on its number)
  // `select`: what to select once the field has the focus (the name a Jump or a Label from the bar needs typed)
  const [textEdit, setTextEditState] = useState<{ at: Sel; draft: string; select?: readonly [number, number] } | null>(null)
  const textEditRef = useRef(textEdit)
  const setTextEdit = (t: typeof textEdit): void => {
    textEditRef.current = t
    setTextEditState(t)
  }
  const [commenting, setCommentingState] = useState<{ routine: number; rung: number; draft: string } | null>(null)
  const commentingRef = useRef(commenting)
  const setCommenting = (c: typeof commenting): void => {
    commentingRef.current = c
    setCommentingState(c)
  }
  // which field of the selected element the keys rest on (a box has several)
  const [focus, setFocus] = useState<{ key: string; field: number } | null>(null)

  // the selection stays on screen: the arrows walk a whole routine, and a selection that left the view is one the next
  // key acts on unseen. `nearest` moves nothing when it is already visible, so a click never jumps.
  const selTrail = sel ? `${sel.routine}/${sel.rung}/${sel.trail.join('.')}` : ''
  useEffect(() => {
    if (!sel) return
    const root = rootRef.current
    const el = sel.trail.length > 0 ? root?.querySelector(`[data-trail="${selTrail}"]`) : root?.querySelector(`[data-routine-index="${sel.routine}"] [data-rung-index="${sel.rung}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selTrail])

  // the organizer asked for a routine: scroll it into view and select its first rung
  useEffect(() => {
    if (revealRoutine === null) return
    const i = revealRoutine < 0 ? routines.length - 1 : revealRoutine
    if (routines[i]) {
      const rung = revealRung !== undefined && revealRung < routines[i].rungs.length ? revealRung : 0
      if (routines[i].rungs.length) setSel({ routine: i, rung, trail: [] })
      // (a frame on: a sheet just opened has not drawn its sections yet; a rung asked for is brought into view by the
      // selection's own scroll, so only the section's top is scrolled to; the sheet's own window, which keeps its
      // frames in a popped-out panel while the main window is minimised)
      if (rung === 0) (rootRef.current?.ownerDocument.defaultView ?? window).requestAnimationFrame(() => rootRef.current?.querySelector(`[data-routine-index="${i}"]`)?.scrollIntoView({ block: 'start' }))
    }
    onRevealedRoutine?.()
  }, [revealRoutine, routines])

  // a problem's line was clicked elsewhere (a fault in the status strip): the element it is about, selected. Keyed on
  // the ask: the routines change with every edit, and an old ask must not select again
  useEffect(() => {
    if (!revealProblem) return
    routines.some((r, ri) =>
      r.rungProblems.some((list, i) => {
        const k = list.findIndex((d) => d.pos.offset === revealProblem.offset)
        if (k < 0) return false
        setSel({ routine: ri, rung: i, trail: r.rungProblemTrails?.[i]?.[k] ?? [] })
        return true
      }),
    )
  }, [revealProblem])

  // the values under the operands while the program runs (useLadderWatch.ts)
  const { setWatch, valueOf, keyOf, roomFor, showsValues, writeValue, forcedOf, heldAt } = useLadderWatch(live, getWatch, source, writeLive, getForces, onForcesChange)

  // a selection the text moved out from under (an undo, a peer's edit) falls back to its rung
  const active = ((): Sel | null => {
    if (!sel) return null
    const r = routines[sel.routine]
    if (!r?.rungs[sel.rung]) return null
    if (selKind(sel) === 'element' && !elementAt(r.rungs, sel)) return { ...sel, trail: [] }
    return sel
  })()
  const selKey = (s: Sel): string => `${s.routine}/${s.rung}/${s.trail.join('.')}`
  const focusedField = active && focus?.key === selKey(active) ? focus.field : 0

  const locked = (r: LadderRoutine | undefined): boolean => readOnly || !r || r.unreadable.length > 0
  const target = routines[active?.routine ?? FRONT]
  const canEdit = !locked(target)

  /** The selected run of elements: from the anchor to the Shift-clicked end, as (first, count). */
  const range = ((): { first: Sel; count: number } | null => {
    if (!active || selKind(active) !== 'element') return null
    const i = active.trail[active.trail.length - 1]!
    const j = rangeEnd ?? i
    return { first: { ...active, trail: [...active.trail.slice(0, -1), Math.min(i, j)] }, count: Math.abs(j - i) + 1 }
  })()
  /** The selected run of rungs: from the anchor rung to the Shift-clicked (or Shift-arrowed) one. */
  const rungRange = ((): { routine: number; first: number; count: number } | null => {
    if (!active || selKind(active) !== 'rung') return null
    const j = rangeEnd ?? active.rung
    return { routine: active.routine, first: Math.min(active.rung, j), count: Math.abs(j - active.rung) + 1 }
  })()
  const rungInRange = (routine: number, rung: number): boolean => !!rungRange && rungRange.routine === routine && rung >= rungRange.first && rung < rungRange.first + rungRange.count
  const inRange = (routine: number, rung: number, trail: number[]): boolean => {
    if (!range || range.first.routine !== routine || range.first.rung !== rung || trail.length !== range.first.trail.length) return false
    const home = range.first.trail.slice(0, -1)
    if (!home.every((n, k) => n === trail[k])) return false
    const i = trail[trail.length - 1]!
    const lo = range.first.trail[range.first.trail.length - 1]!
    return i >= lo && i < lo + range.count
  }

  /** A copy as the clipboard holds it: rung text - a run of elements, or whole rungs each with its `;`. */
  const copyText = (copy: { kind: 'rungs'; rungs: readonly Rung[] } | { kind: 'elements'; elements: readonly RungElement[] }): string =>
    copy.kind === 'elements' ? LADDER.printElements(copy.elements) : copy.rungs.map((x) => `${LADDER.printRung(x)};`).join('\n')
  /** The elements of the selected branch level. */
  const levelElements = (s: Sel): RungElement[] => {
    const r = routines[s.routine]
    const branch = r && elementAt(r.rungs, { rung: s.rung, trail: s.trail.slice(0, -1) })
    return branch && isBranch(branch) ? (branch.paths[s.trail[s.trail.length - 1]!] ?? []) : []
  }
  /** What is selected, as the clipboard holds it: a run of elements, whole rungs, or a branch level. */
  const selectionText = (): string => {
    if (!active) return ''
    const r = routines[active.routine]
    if (!r) return ''
    if (range) return copyText({ kind: 'elements', elements: elementRange(r.rungs, range.first, range.count) })
    if (rungRange) return copyText({ kind: 'rungs', rungs: r.rungs.slice(rungRange.first, rungRange.first + rungRange.count) })
    // a branch level: its elements - or, empty, one space, so a bare leg still copies as something
    if (selKind(active) === 'path') return copyText({ kind: 'elements', elements: levelElements(active) }) || ' '
    return ''
  }
  const kindOfCopy = (): 'elements' | 'level' | 'rungs' => (active && selKind(active) === 'path' ? 'level' : active && selKind(active) === 'rung' ? 'rungs' : 'elements')
  const copySelection = (): string => {
    const text = selectionText()
    if (text === '') return ''
    clipRef.current = text
    clipAt.current = Date.now()
    clipKind.current = kindOfCopy()
    // (the clipboard of the window the sheet is in: a popped-out panel's is its own)
    void activeClipboard()?.writeText(text).catch(() => {})
    return text
  }
  const deleteSelection = (): void => {
    if (range) apply((r, s) => removeRange(r, { rung: s.rung, trail: range.first.trail }, range.count))
    else if (rungRange && rungRange.count > 1) apply((r) => removeRungs(r, rungRange.first, rungRange.count))
    else apply(removeSelected)
  }
  /** Paste: elements after the selection (at the start of a selected rung or level), rungs below the selected rung - and
   *  a copied level (a branch leg, or the one-space clipboard text of a bare one) pasted onto a level or a branch, a
   *  new level below it. */
  const pasteText = (text: string): void => {
    if (!canEdit) return
    const routine = active?.routine ?? FRONT
    const r = routines[routine]
    if (!r) return
    const got = LADDER.parseText(text)
    const ontoLevel = !!active && (selKind(active) === 'path' || isBranch(elementAt(r.rungs, active)))
    const isLevel = text.trim() === '' || (clipKind.current === 'level' && text === clipRef.current)
    if (ontoLevel && isLevel && (got === null || got.kind === 'elements')) {
      const e = addLevel(r.rungs, active!, got?.elements ?? [])
      commit(routine, e.rungs, e.sel ? { ...e.sel, routine } : null)
      return
    }
    if (!got) return
    if (got.kind === 'rungs') {
      const e = insertRungs(r.rungs, rungRange ? rungRange.first + rungRange.count - 1 : active ? active.rung : r.rungs.length - 1, got.rungs)
      commit(routine, e.rungs, e.sel ? { ...e.sel, routine } : null)
      return
    }
    const at = active ?? { routine, rung: r.rungs.length - 1, trail: [] }
    if (at.rung < 0) return
    const from = range ? { ...range.first, trail: [...range.first.trail.slice(0, -1), range.first.trail[range.first.trail.length - 1]! + range.count - 1] } : at
    const e = insertElements(r.rungs, from, got.elements)
    commit(routine, e.rungs, e.sel ? { ...e.sel, routine } : null)
  }
  const pasteFromClipboard = (): void => {
    void (activeClipboard()?.readText?.() ?? Promise.reject(new Error('no clipboard')))
      .catch(() => clipRef.current)
      .then((text) => pasteText(ownClip(text))).catch((e: unknown) => console.warn('[oip] ladder paste failed', e))
  }
  const onCopy = (e: ReactClipboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    const text = selectionText()
    if (text === '') return
    e.preventDefault()
    e.clipboardData.setData('text/plain', text)
    clipRef.current = text
    clipAt.current = Date.now()
    clipKind.current = kindOfCopy()
  }
  const pasteEventSeen = useRef(false)
  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    pasteEventSeen.current = true
    pasteText(ownClip(e.clipboardData.getData('text/plain')))
  }

  /** The selected rung, one place up or down (Ctrl+Up / Ctrl+Down, or the selection's menu). */
  const moveSelectedRung = (by: -1 | 1): void => {
    if (!active) return
    const to = active.rung + by
    if (to < 0 || to >= (routines[active.routine]?.rungs.length ?? 0)) return
    apply((r, s) => moveRung(r, s.rung, by))
  }
  const commit = (routine: number, rungs: readonly Rung[], next: Sel | null): void => {
    onEdit(LADDER.write(source, routine, rungs))
    setSel(next)
  }
  const apply = (edit: (rungs: readonly Rung[], s: LadderSel) => LadderEdit<RungItem>): Sel | null => {
    if (!active || !canEdit) return null
    const e = edit(routines[active.routine]!.rungs, active)
    const next = e.sel ? { ...e.sel, routine: active.routine } : null
    commit(active.routine, e.rungs, next)
    return next
  }

  /** An element from the bar onto the rung, declaring what it needs in the same edit (a block gets an instance of its
   *  own). */
  const insert = (entry: Pick<PaletteEntry, 'key'>): void => {
    if (!canEdit) return
    // with nothing selected an element goes on the last rung, which is the one being built
    const at = active ?? { routine: FRONT, rung: (routines[FRONT]?.rungs.length ?? 0) - 1, trail: [] }
    if (at.rung < 0) return newRung()
    const made = LADDER.insert(source, at.routine, at, entry.key)
    if (!made) return
    const next = made.sel ? { ...made.sel, routine: at.routine } : null
    onEdit(made.source)
    setSel(next)
    // straight on to what it needs named
    if (next && made.field !== null) setEditing({ at: next, field: made.field, draft: '' })
  }

  // Insert Box: the picker over the whole catalogue, for the section the selection is in (its POU decides which of the
  // program's own blocks it may call). Open while it is non-null.
  const [picking, setPicking] = useState<number | null>(null)
  const openPicker = (): void => {
    if (!canEdit) return
    setPicking(active?.routine ?? FRONT)
  }
  const closePicker = (): void => {
    setPicking(null)
    rootRef.current?.focus()
  }
  const boxChoices = useMemo(() => (picking === null ? [] : LADDER.boxes(source, picking)), [picking, source])

  const newRung = (): void => {
    if (!canEdit) return
    const routine = active?.routine ?? FRONT
    const r = routines[routine]
    if (!r) return
    const e = addRung(r.rungs, active ? active.rung : r.rungs.length - 1)
    commit(routine, e.rungs, e.sel ? { ...e.sel, routine } : null)
  }

  /** A pin connected from its open row and then left empty, or backed out of with Escape: taken off again, so trying a
   *  pin and changing one's mind leaves the box as it was (an emptied block pin goes: ladderLeaves.ts `setField`). */
  const disconnect = (ed: { at: Sel; field: number }): void => {
    const wrote = LADDER.writeField(source, ed.at.routine, ed.at, ed.field, '')
    if ('source' in wrote && wrote.source !== source) onEdit(wrote.source)
    rootRef.current?.focus()
  }

  /** A block's open pin row, double-clicked: the pin connected blank (`LADDER.connectPin`) and its field opened to name
   *  it, through the same field every other is typed in. */
  const connect = (at: Sel, pin: string, out: boolean): void => {
    if (!canEdit) return
    const made = LADDER.connectPin(source, at.routine, at, pin, out)
    if (!made || made.field === null) return
    onEdit(made.source)
    setSel(at)
    setEditing({ at, field: made.field, draft: '', connected: true })
  }

  const commitField = (): void => {
    const ed = editingRef.current
    setEditing(null)
    if (!ed) return
    const r = routines[ed.at.routine]
    const el = r && elementAt(r.rungs, ed.at)
    if (!r || !el || isBranch(el) || locked(r)) return
    const text = ed.draft.trim()
    if (ed.connected && text === '') return disconnect(ed)
    const fields = LADDER.fields(el)
    const was = fieldText(el, ed.field) ?? ''
    if (text === was || (text === '' && was === '?')) return
    const wrote = LADDER.writeField(source, ed.at.routine, ed.at, ed.field, text)
    if ('error' in wrote) {
      setOpError(wrote.error)
      if (!ed.leaving) setEditing(ed) // still typing: stay in the field, with the reason
      return
    }
    setOpError(null)
    if (wrote.source !== source) onEdit(wrote.source)
    setSel(ed.at)
    // a box: on to its next blank field
    const blank = fields.findIndex((f, i) => i > ed.field && f === '?')
    const next = blank >= 0 ? blank : null
    if (next !== null) setEditing({ at: ed.at, field: next, draft: '' })
    else rootRef.current?.focus()
  }

  const commitComment = (): void => {
    const c = commentingRef.current
    setCommenting(null)
    const r = c && routines[c.routine]
    if (!c || !r || locked(r) || c.draft.trim() === (r.rungs[c.rung]?.comment ?? '')) return
    commit(c.routine, setComment(r.rungs, c.rung, c.draft), { routine: c.routine, rung: c.rung, trail: [] })
  }

  /** Double-click on a rung's number: the rung as text, to retype whole. */
  const startTextEdit = (at: Sel): void => {
    const r = routines[at.routine]
    if (!r || locked(r) || selKind(at) !== 'rung') return
    setSel(at)
    setTextEdit({ at, draft: LADDER.printRung(r.rungs[at.rung]!) })
  }
  /**
   * Jump, Label and Return from the bar: how the selected rung ends, and what it is called. A
   * RETURN names nothing, so it is set outright. A jump or a label opens the rung as text with its name selected, to be
   * typed over: a jump offers the next label below it (a jump only goes down), a label the first free `L<n>`.
   */
  const addEnd = (kind: 'jump' | 'label' | 'return'): void => {
    if (!active || !canEdit) return
    const r = routines[active.routine]
    const rung = r?.rungs[active.rung]
    if (!r || !rung) return
    const at = { routine: active.routine, rung: active.rung, trail: [] }
    if (kind === 'return') {
      const e = replaceRung(r.rungs, active.rung, rung.elements, { ...(rung.label ? { label: rung.label } : {}), exit: { kind: 'return' } })
      commit(active.routine, e.rungs, at)
      return
    }
    const used = new Set(r.rungs.flatMap((x) => (x.label ? [x.label.toUpperCase()] : [])))
    let n = 1
    while (used.has(`L${n}`)) n++
    const below = r.rungs.slice(active.rung + 1).find((x) => x.label)?.label
    const name = kind === 'jump' ? (rung.exit?.kind === 'jump' ? rung.exit.label : (below ?? `L${n}`)) : (rung.label ?? `L${n}`)
    const draft = LADDER.printRung(kind === 'jump' ? { ...rung, exit: { kind: 'jump', label: name } } : { ...rung, label: name })
    const from = kind === 'jump' ? draft.lastIndexOf(`>>${name}`) + 2 : draft.indexOf(name)
    setSel(at)
    setTextEdit({ at, draft, select: [from, from + name.length] })
  }

  const commitTextEdit = (): void => {
    const te = textEditRef.current
    setTextEdit(null)
    if (!te) return
    const r = routines[te.at.routine]
    if (!r || locked(r)) return
    const text = te.draft.trim().replace(/;\s*$/, '')
    const got = text === '' ? { kind: 'elements' as const, elements: [] } : LADDER.parseText(text)
    // one whole rung comes back when the text has a label or a jump / RETURN on it (ladderRungs.ts parseRungText)
    const one = got?.kind === 'rungs' && got.rungs.length === 1 ? got.rungs[0]! : null
    if (!got || (got.kind !== 'elements' && !one)) {
      setOpError(t(M.notOneRung, { text }))
      return
    }
    const els = one ? one.elements : got.kind === 'elements' ? got.elements : []
    const ends = { ...(one?.label ? { label: one.label } : {}), ...(one?.exit ? { exit: one.exit } : {}) }
    if (LADDER.printRung({ comment: '', elements: els, ...ends }) === LADDER.printRung(r.rungs[te.at.rung]!)) return
    const e = replaceRung(r.rungs, te.at.rung, els, ends)
    commit(te.at.routine, e.rungs, e.sel ? { ...e.sel, routine: te.at.routine } : null)
    rootRef.current?.focus()
  }

  /** The text of field `field` of `el`, or null when there is no such field. */
  const fieldText = (el: RungItem, field: number): string | null => LADDER.fields(el)[field] ?? null

  const startEdit = (at: Sel, field: number): void => {
    const r = routines[at.routine]
    const el = r && elementAt(r.rungs, at)
    if (!el || isBranch(el) || locked(r)) return
    const text = fieldText(el, field)
    if (text === null) return
    setSel(at)
    setEditing({ at, field, draft: text === '?' ? '' : text })
  }

  // ---- Find and Replace (Ctrl+F / Ctrl+H): useLadderFind.ts
  const { finding, setFinding, findQuery, setFindQuery, findWith, setFindWith, findWrap, setFindWrap, findWhole, setFindWhole, findScope, setFindScope, findAt, setFindAt, setFindNote, findInput, found, isFound, findStep, openFind, closeFind, replaceOne, replaceAll, findCount } = useLadderFind({ routines, active, source, onEdit, locked, setSel, setFocus, selKey, rootRef })

  // ---- Cross Reference (Ctrl+E, or the selection's menu): every place the tag under the selection is used (plc/crossRef.ts) ----
  const [xref, setXref] = useState<string | null>(null)
  /** The tag the selection is on: the root name of the focused field of the selected element. */
  const focusedTag = (): string | null => {
    if (!active) return null
    const r = routines[active.routine]
    const el = r && elementAt(r.rungs, active)
    if (!el || isBranch(el)) return null
    const uses = LADDER.refs.uses(el)
    const use = uses.find((u) => u.field === focusedField) ?? uses[0]
    return (use && /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(use.text)?.[1]) ?? null
  }

  // ---- Toggle Bit (Ctrl+T, the selection's menu, or the strip while running) and a value typed into the running program: what an engineer does online.
  //      Both go to the running program between scans (EditorController.togglePlcBit / writePlcValue), never into the
  //      program's text: a variable the program writes itself is overwritten by its next scan, one it only reads keeps it.
  /** The running program's BOOL under the selection's focused field - a contact's or coil's variable, a BOOL pin that
   *  names a place - or null. */
  const toggleTarget = (): { key: string; value: boolean } | null => {
    if (!live || !toggleBit || !active) return null
    const r = routines[active.routine]
    const el = r && elementAt(r.rungs, active)
    if (!el || isBranch(el)) return null
    const uses = LADDER.refs.uses(el)
    const use = uses.find((u) => u.field === focusedField) ?? uses[0]
    if (!use || !PLACE.test(use.text)) return null
    const key = keyOf(use.text)
    const value = valueOf(use.text)
    return key !== null && typeof value === 'boolean' ? { key, value } : null
  }
  /** The variable Add to Watch puts on the list: the place in the selection's focused field, by the running image's
   *  spelling when there is one (a POU's variable under its instance), else as written. */
  const watchTarget = (): string | null => {
    if (!active) return null
    const r = routines[active.routine]
    const el = r && elementAt(r.rungs, active)
    if (!el || isBranch(el)) return null
    const uses = LADDER.refs.uses(el)
    const use = uses.find((u) => u.field === focusedField) ?? uses[0]
    if (!use || !PLACE.test(use.text)) return null
    return keyOf(use.text) ?? use.text.replace(/\s+/g, '')
  }
  /** The variable Force / Release acts on: the place in the selection's focused field, while the program runs and the
   *  running image holds it as one value (its watch key). */
  const forceTarget = (): { key: string; forced: boolean } | null => {
    if (!live || !onForce || !active) return null
    const r = routines[active.routine]
    const el = r && elementAt(r.rungs, active)
    if (!el || isBranch(el)) return null
    const uses = LADDER.refs.uses(el)
    const use = uses.find((u) => u.field === focusedField) ?? uses[0]
    if (!use || !PLACE.test(use.text)) return null
    const key = keyOf(use.text)
    return key !== null ? { key, forced: forcedOf(use.text) } : null
  }
  const forceOrRelease = (target: { key: string; forced: boolean }): void => {
    if (target.forced) {
      onRelease?.(target.key)
      setOpError(null)
    } else setOpError(onForce?.(target.key) ?? null) // a force that worked says nothing, as a write does
  }
  /** The badge beside a forced operand. Drawn over the cell's edge (ladder.css), so a force set or released moves
   *  nothing on the sheet. */
  const forcedBadge = (value: number | boolean | undefined): ReactElement => {
    // (TRUE / FALSE: the IEC literal, as the program spells it)
    const held = t(M.forcedTitle, { value: typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : fmt(value) }) // i18n-ok
    return <span className="ld-forced-badge" data-testid="ld-forced-badge" title={held} aria-label={held}>{t(M.forcedMark)}</span>
  }
  const toggle = (): void => {
    const bit = toggleTarget()
    // shown at once: the frame that carries the new value is a step away, and a second Ctrl+T must read this one
    if (bit && toggleBit?.(bit.key)) setWatch((w) => (w && bit.key in w ? withWatchValue(w, bit.key, !bit.value) : w))
  }
  /** A live value being typed: under which element's field, for which variable of the running program. */
  const [liveEdit, setLiveEditState] = useState<{ at: Sel; field: number; key: string; draft: string } | null>(null)
  // through a ref, like the two editors above it: Escape clears the draft and moves the focus, and moving the focus
  // fires this field's own blur synchronously, before the re-render. A commit that read the render's state would
  // still see the draft and write it into the running program. Escape must write nothing.
  const liveEditRef = useRef(liveEdit)
  const setLiveEdit = (v: typeof liveEdit): void => {
    liveEditRef.current = v
    setLiveEditState(v)
  }
  const startLiveEdit = (at: Sel, field: number, text: string): void => {
    if (!showsValues || !writeValue || !PLACE.test(text)) return
    const key = keyOf(text)
    if (key === null) return
    setOpError(null) // (a new value: the last one's refusal is no longer the news)
    setLiveEdit({ at, field, key, draft: fmt(valueOf(text)) })
  }
  const commitLiveEdit = (): void => {
    const v = liveEditRef.current
    if (!v) return
    setLiveEdit(null)
    const refused = writeValue ? writeValue(v.key, v.draft) : t(M.cannotWrite)
    setOpError(refused) // a write that worked says nothing
    rootRef.current?.focus()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const act = resolveKeyAction(e, 'ladder')
    // Find / Replace open from anywhere in the view - the Find bar's own buttons included - and must not reach the
    // browser's own Find or History (a field that owns its keys stops them before they get here)
    if (act === 'ladder.find' || act === 'ladder.replace' || ((act === 'ladder.findNext' || act === 'ladder.findPrev') && finding)) {
      e.preventDefault()
      e.stopPropagation()
      if (act === 'ladder.find' || act === 'ladder.replace') openFind(act === 'ladder.replace' && !readOnly)
      else findStep(act === 'ladder.findPrev' ? -1 : 1)
      return
    }
    if (e.target !== e.currentTarget) return // a field inside owns its own keys
    // Escape on the sheet closes Find when it is open, and is the sheet's either way: the 3D editor's window-level
    // Escape would otherwise clear the selected parts from under the ladder
    if (e.key === 'Escape') {
      if (finding) closeFind()
      e.stopPropagation()
      return
    }
    const edit = resolveKeyAction(e, 'editor')
    if (edit === 'edit.undo') onUndo()
    else if (edit === 'edit.redo') onRedo()
    else if (act === 'ladder.zoomIn' || act === 'ladder.zoomOut') stepZoom(zoomNow.current * (act === 'ladder.zoomIn' ? ZOOM_STEP : 1 / ZOOM_STEP))
    else if (act === 'ladder.zoomReset') stepZoom(1)
    else if (act === 'ladder.toggleBit') toggle()
    else if (act === 'ladder.insertBox') {
      e.preventDefault() // (a browser's own Ctrl+B)
      openPicker()
    } else if (act === 'ladder.crossRef') {
      const tag = focusedTag()
      if (tag) setXref(tag)
    }
    else if (edit === 'edit.cut') {
      if (copySelection() !== '') deleteSelection()
    }
    // nothing here is text the browser can copy, so Ctrl+C fires no copy event: written outright. Claimed even with
    // nothing to copy, or the 3D editor copies the selected part from under the ladder
    else if (edit === 'edit.copy') copySelection()
    // Ctrl+V does raise a paste event, which carries the clipboard without asking (onPaste); when a browser withholds
    // it, the clipboard is read after a beat instead. Not preventDefault (that cancels the paste event), but the 3D
    // editor's window-level Ctrl+V (paste a part) must not hear it
    else if (edit === 'edit.paste') {
      pasteEventSeen.current = false
      window.setTimeout(() => {
        if (!pasteEventSeen.current) pasteFromClipboard()
      }, 150)
      e.stopPropagation()
      return
    } else if (!active) return
    else if (edit === 'edit.delete') deleteSelection()
    else if (edit === 'edit.moveUp' || edit === 'edit.moveDown') moveSelectedRung(edit === 'edit.moveUp' ? -1 : 1)
    else if (act === 'ladder.edit') {
      if (selKind(active) === 'rung') startTextEdit(active)
      else startEdit(active, focusedField)
    } else if (act === 'ladder.extendUp' || act === 'ladder.extendDown' || act === 'ladder.extendPrev' || act === 'ladder.extendNext') {
      const vertical = act === 'ladder.extendUp' || act === 'ladder.extendDown'
      const step = act === 'ladder.extendUp' || act === 'ladder.extendPrev' ? -1 : 1
      if (vertical && selKind(active) === 'rung') {
        const to = (rangeEnd ?? active.rung) + step
        if (to >= 0 && to < routines[active.routine]!.rungs.length) setRangeEnd(to)
      } else if (!vertical && selKind(active) === 'element') {
        const to = (rangeEnd ?? active.trail[active.trail.length - 1]!) + step
        if (to >= 0 && to < seriesLength(routines[active.routine]!.rungs, active)) setRangeEnd(to)
      }
    } else if (act === 'ladder.up' || act === 'ladder.down') {
      const el = selKind(active) === 'element' ? elementAt(routines[active.routine]!.rungs, active) : null
      if (el && !isBranch(el) && LADDER.shape(el).kind === 'box') {
        // on a box: through its fields - its name, then each value - and round again
        const n = LADDER.fields(el).length
        setFocus({ key: selKey(active), field: (focusedField + (act === 'ladder.down' ? 1 : n - 1)) % n })
      } else {
        const rung = active.rung + (act === 'ladder.up' ? -1 : 1)
        if (routines[active.routine]!.rungs[rung]) setSel({ routine: active.routine, rung, trail: [] })
      }
    } else if (act === 'ladder.prev' || act === 'ladder.next' || act === 'ladder.stepPrev' || act === 'ladder.stepNext') {
      // Tab is Left / Right without the stop on each of a block's fields: element to element through the routine
      const back = act === 'ladder.prev' || act === 'ladder.stepPrev'
      const to = stepInstruction(routines[active.routine]!.rungs, active, back ? -1 : 1)
      if (to) setSel({ ...to, routine: active.routine })
    } else if (act === 'ladder.describe') {
      // a rung: its comment (claimed on an element too, where it does nothing: the browser's own Ctrl+D bookmarks the page)
      if (selKind(active) === 'rung') {
        const r = routines[active.routine]
        if (r && !locked(r)) setCommenting({ routine: active.routine, rung: active.rung, draft: r.rungs[active.rung]?.comment ?? '' })
      }
    } else return
    // claimed: the 3D editor's window-level shortcuts (Delete a part, the project's Ctrl+Z) must not also act
    e.preventDefault()
    e.stopPropagation()
  }

  const { stretch, dragDrop, rungDrop, suppressClick, dropMarker, onCellDoubleClick, onCellDown, onCellMove, onCellUp, onNodeDown, onNodeMove, onNodeUp, onNumDown, onNumMove, onNumUp } = useLadderDrags({ routines, canEdit, rootRef, setSel, commit, connect, startEdit, startLiveEdit })

  // ---- drawing ---------------------------------------------------------------------------------------------------

  const sameSel = (a: Sel | null, routine: number, rung: number, trail: number[]): boolean =>
    !!a && a.routine === routine && a.rung === rung && a.trail.length === trail.length && a.trail.every((n, i) => n === trail[i])

  const wire = (p: Power, key: string, grow = false, end = false): ReactElement => <span key={key} className={`ld-wire${grow ? ' grow' : ''}${end ? ' end' : ''}${p ? ' on' : ''}`} />

  const tagOptions = useMemo(() => [...new Set([...getTags(), ...LADDER.declaredNames(source)])].filter((t) => IDENT.test(t)).sort((a, b) => a.localeCompare(b)), [source])

  // The field being typed says what it takes (a contact a BOOL, a TON's PT a TIME), so its suggestions (the ending
  // proposed after the caret and the drop-down) put names of that type first (`LADDER.typeAhead`); after a dot
  // they are the members of what stands before it (`T1.` -> IN, PT, Q, ET). Planned once per field, not per keystroke.
  const editedField = editing ? `${editing.at.routine}:${editing.at.rung}:${editing.at.trail.join('.')}:${editing.field}` : ''
  const typeAhead = useMemo(() => {
    if (!editing) return null
    const r = routines[editing.at.routine]
    const el = r && elementAt(r.rungs, editing.at)
    if (!r || !el || isBranch(el)) return null
    return LADDER.typeAhead(source, r, el, editing.field, tagOptions)
    // (keyed on which field is open - editedField - not on the draft in it)
  }, [editedField, routines, source, tagOptions])

  const field = (at: Sel, i: number): ReactElement => (
    <input
      className="ld-input"
      data-testid="ladder-field"
      autoFocus
      list="ld-tags"
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      value={editing!.draft}
      size={Math.max(6, editing!.draft.length + 1)}
      aria-label={t(M.operand)}
      aria-invalid={!!opError}
      title={opError ?? undefined}
      onChange={(e) => {
        setOpError(null)
        setEditing({ ...editingRef.current, at, field: i, draft: withProposal(e, (typed) => (typeAhead ? completeName(typed, typeAhead.names, typeAhead.membersOf) : null)) })
      }}
      onBlur={() => {
        // an ending that was only proposed is not kept: Enter takes a proposal, walking away does not
        if (editingRef.current) editingRef.current = { ...editingRef.current, draft: withoutProposal(editingRef.current.draft), leaving: true }
        proposal.current = null
        commitField()
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          proposal.current = null // taken: the proposed ending is part of the field now
          commitField()
        } else if (e.key === 'Escape') {
          proposal.current = null
          const ed = editingRef.current
          setEditing(null)
          if (ed?.connected) disconnect(ed)
          else rootRef.current?.focus()
        }
      }}
    />
  )

  /** The selection's menu - one menu, wherever it opens: a right-click on a rung, a level, an element or one of its
   *  fields, or the strip's "⋯". Everything that acts on the selection; the strip keeps only what adds, and each
   *  entry here has a chord, which the menu names. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /** Open the menu at the pointer on `at` - keeping the selection when `at` is inside it (a Shift-selected run is copied
   *  as a run), else selecting there - with the keys on `field` when the right-click landed on one. */
  const openMenu = (e: ReactMouseEvent<HTMLElement>, at: Sel, field?: number): void => {
    e.preventDefault()
    e.stopPropagation()
    const inside = sameSel(active, at.routine, at.rung, at.trail) || inRange(at.routine, at.rung, at.trail) || (at.trail.length === 0 && rungInRange(at.routine, at.rung))
    if (!inside) setSel(at)
    if (field !== undefined) setFocus({ key: selKey(at), field })
    rootRef.current?.focus()
    setMenu({ x: e.clientX, y: e.clientY })
  }
  /** A right-click on a field's text: the menu, with the keys on that field. */
  const fieldMenu = (e: ReactMouseEvent<HTMLElement>, at: Sel, field: number): void => openMenu(e, at, field)
  const openActions = (e: ReactMouseEvent<HTMLElement>, at: Sel): void => openMenu(e, at)

  type PickEvent = { stopPropagation: () => void; shiftKey?: boolean; clientX?: number; clientY?: number }
  /** A click on an element: select it (Shift: extend the run), and note which of its fields the click landed on. */
  const pickCell = (e: PickEvent, at: Sel): void => {
    e.stopPropagation()
    if (suppressClick.current) return
    if (e.clientX !== undefined && e.clientY !== undefined) {
      const hit = (rootRef.current?.ownerDocument ?? document).elementFromPoint(e.clientX, e.clientY)
      const row = isEl(hit) ? hit.closest<HTMLElement>('[data-field]') : null
      if (row) setFocus({ key: selKey(at), field: Number(row.dataset.field) })
    }
    const sameSeries = !!active && selKind(active) === 'element' && active.routine === at.routine && active.rung === at.rung && active.trail.length === at.trail.length && active.trail.slice(0, -1).every((n, k) => n === at.trail[k])
    if (e.shiftKey && sameSeries) setRangeEnd(at.trail[at.trail.length - 1]!)
    else setSel(at)
    rootRef.current?.focus()
  }

  const isEditing = (at: Sel, i: number): boolean => !!editing && editing.field === i && sameSel(editing.at, at.routine, at.rung, at.trail)

  /** One leaf, drawn from its shape (ladderLeaf.tsx): a contact or coil - a variable over a symbol - or a box with a row
   *  per pin. `pin` is the power on its left link. */
  const item = (el: RungItem, at: Sel, pin: Power): ReactElement => {
    const selected = sameSel(active, at.routine, at.rung, at.trail) || inRange(at.routine, at.rung, at.trail)
    // every element a problem is about is marked: red for what stops the program compiling, amber for a warning
    const r = routines[at.routine]
    const marks = r?.rungProblemTrails?.[at.rung] ?? []
    const kinds = (r?.rungProblems[at.rung] ?? []).filter((_, k) => marks[k]?.join('.') === at.trail.join('.'))
    const flagged = kinds.some((d) => d.severity !== 'warning') ? ' bad' : kinds.length > 0 ? ' caution' : ''
    const cls = `ld-cell${selected ? ' sel' : ''}${flagged}${dragDrop && sameSel(dragDrop.from, at.routine, at.rung, at.trail) ? ' dragging' : ''}`
    const handlers = {
      onClick: (e: ReactPointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => F.current.pickCell(e, at),
      onDoubleClick: (e: React.MouseEvent<HTMLElement>) => F.current.onCellDoubleClick(e, at),
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => F.current.onCellDown(e, at),
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => F.current.onCellMove(e),
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => F.current.onCellUp(e),
      onContextMenu: (e: React.MouseEvent<HTMLElement>) => F.current.openActions(e, at),
    }
    const trail = `${at.routine}/${at.rung}/${at.trail.join('.')}`
    const s = LADDER.shape(el)
    if (s.kind === 'box') {
      return (
        <span className={`${cls} ld-boxed`} {...handlers} data-testid="ld-element" data-kind="box" data-mode={s.mode} data-starts={s.starts ? 'true' : undefined} data-trail={trail} title={s.tip}>
          {/* a box that starts the rung: nothing feeds it, so no wire leads in, and it is lit by what it returns */}
          {s.starts ? <span key="l" className="ld-wire none" /> : wire(pin, 'l')}
          <span className={`ld-box${(s.starts ? powerOut(el, pin) : pin) ? ' on' : ''}`}>
            {s.instance && (
              <span className={`ld-box-inst${selected && focusedField === s.instance.field ? ' focus' : ''}${isFound(at, s.instance.field) ? ' found' : ''}`} data-field={s.instance.field}>
                {isEditing(at, s.instance.field) ? field(at, s.instance.field) : <span className={s.instance.text === '?' ? 'blank' : ''} onContextMenu={(e) => F.current.fieldMenu(e, at, s.instance!.field)}>{s.instance.text}</span>}
              </span>
            )}
            <span className={`ld-box-title${s.titleField !== null && selected && focusedField === s.titleField ? ' focus' : ''}${s.titleField !== null && isFound(at, -1) ? ' found' : ''}`} {...(s.titleField !== null ? { 'data-field': s.titleField } : {})} onContextMenu={(e) => F.current.fieldMenu(e, at, s.titleField ?? -1)}>
              {s.titleField !== null && isEditing(at, s.titleField) ? field(at, s.titleField) : s.title}
            </span>
            {s.rows.map((row) => {
              const writable = !!writeValue && typeof row.watch === 'string' && row.watch !== 'pin' && row.field >= 0 && PLACE.test(row.watch)
              return (
                <span
                  key={row.key}
                  className={`ld-box-row${row.rung ? ' rung' : ''}${row.connect ? ' open' : ''}${selected && row.field >= 0 && focusedField === row.field ? ' focus' : ''}${row.field >= 0 && isFound(at, row.field) ? ' found' : ''}`}
                  {...(row.field >= 0 ? { 'data-field': row.field } : {})}
                  data-pin={row.name}
                  // (connected by the cell's own double-click, which hit-tests for this: onCellDoubleClick)
                  {...(row.connect && canEdit
                    ? { 'data-open': 'true', 'data-out': String(row.connect.out), title: t(row.connect.out ? M.pinOpenVariable : M.pinOpenValue, { pin: row.name }) }
                    : {})}
                >
                  <span className="ld-box-name">{row.name}</span>
                  {/* a pin on the rung with nothing written shows what flows through it; one written as well (the pin
                      the rung leaves by, also stored to a variable) shows its variable like any other */}
                  {row.rung && row.text === null ? (
                    <span className="ld-box-value">{row.out ? '→' : '←'}</span>
                  ) : row.text === null ? null : isEditing(at, row.field) ? (
                    field(at, row.field)
                  ) : (
                    <span className={`ld-box-value${row.text === '?' ? ' blank' : ''}`} onContextMenu={(e) => F.current.fieldMenu(e, at, row.field)}>
                      {row.out ? `→ ${row.text}` : row.text}
                    </span>
                  )}
                  {showsValues && (
                    liveEdit && liveEdit.field === row.field && sameSel(liveEdit.at, at.routine, at.rung, at.trail) ? (
                      <input
                        className="ld-input ld-live-input"
                        data-testid="ld-live-input"
                        autoFocus
                        spellCheck={false}
                        value={liveEdit.draft}
                        size={Math.max(4, liveEdit.draft.length + 1)}
                        aria-label={t(M.valueOf, { name: row.text ?? row.name })}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setLiveEdit({ ...liveEdit, draft: e.target.value })}
                        onBlur={commitLiveEdit}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitLiveEdit()
                          } else if (e.key === 'Escape') {
                            setLiveEdit(null)
                            rootRef.current?.focus()
                          }
                        }}
                      />
                    ) : (
                      (() => {
                        const v = row.watch === 'pin' ? (pin ?? undefined) : row.watch === null ? undefined : valueOf(row.watch)
                        const shown = fmt(v)
                        const held = row.watch !== null && row.watch !== 'pin' ? heldAt(row.watch) : undefined
                        const forced = held !== undefined
                        return (
                          <span
                            className={`ld-live${writable ? ' writable' : ''}${forced ? ' forced' : ''}`}
                            {...(forced ? { 'data-forced': 'true' } : {})}
                            data-testid="ld-live"
                            style={{ minWidth: `${roomFor(row.watch ?? `${trail}#${row.field}`, shown, typeof v === 'number')}ch` }}
                            // the cell holds the pointer from the press, so its double-click hit-tests for this (onCellDoubleClick)
                            {...(writable ? { 'data-live-text': row.watch!, title: t(M.liveWritable, { name: row.watch! }) } : {})}
                          >
                            {forced && forcedBadge(held)}
                            {shown}
                          </span>
                        )
                      })()
                    )
                  )}
                </span>
              )
            })}
          </span>
          {wire(powerOut(el, pin), 'r')}
        </span>
      )
    }
    // drawn TRUE the way an editor draws it online: a contact that passes, a coil whose variable is set
    const on = live && valueOf(s.lit.text) === s.lit.when
    // held by a force (the Watch dock): marked, since the rung then runs on a value the program does not set
    const held = heldAt(s.lit.text)
    const forced = held !== undefined
    const glyph =
      s.kind === 'contact' ? (
        <span className={`ld-glyph ld-contact${on ? ' on' : ''}`}>{s.slash ? <i className="ld-slash" /> : <span className="ld-contact-mark">{s.mark}</span>}</span>
      ) : (
        <span className={`ld-glyph ld-coil${on ? ' on' : ''}`}>{s.mark}</span>
      )
    return (
      <span className={`${cls}${forced ? ' forced' : ''}`} {...handlers} data-testid="ld-element" data-kind={s.kind} data-mode={s.mode} data-on={on ? 'true' : 'false'} data-forced={forced ? 'true' : 'false'} data-trail={trail} {...(s.title ? { title: s.title } : {})}>
        <span className={`ld-tag${selected && focusedField === 0 ? ' focus' : ''}${isFound(at, 0) ? ' found' : ''}`} data-field={0}>
          {isEditing(at, 0) ? field(at, 0) : <span className={s.tag === '?' ? 'blank' : ''} onContextMenu={(e) => F.current.fieldMenu(e, at, 0)}>{s.tag}</span>}
          {forced && forcedBadge(held)}
        </span>
        <span className="ld-sym">
          {wire(pin, 'l', true)}
          {glyph}
          {wire(powerOut(el, pin), 'r', true)}
        </span>
      </span>
    )
  }

  /** the power on an element's right link, from the live image; null when nothing runs */
  const powerOut = (el: RungElement, pin: Power): Power => {
    if (pin === null) return null
    if (isBranch(el)) return el.paths.some((p) => p.reduce<Power>((acc, x) => powerOut(x, acc), pin) === true)
    return LADDER.powerOut(el, pin, valueOf)
  }

  /** An output, or a branch with one on any level: where a rung's output section begins, packed against the right rail. */
  const holdsOutput = (el: RungElement): boolean => (isBranch(el) ? el.paths.some((path) => path.some(holdsOutput)) : LADDER.isOutput(el))

  /**
   * One series of elements: the input section from the left, the output section (the coils) against the right rail,
   * the wire stretched between them. Inside the output section everything packs to the right (`packRight`), so a
   * branch level's contact sits beside its coil, not at the far left of the level.
   */
  const series = (els: readonly RungElement[], routine: number, rung: number, home: number[], pin: Power, packRight = false): { nodes: ReactNode[]; pout: Power } => {
    const nodes: ReactNode[] = []
    let p = pin
    let tail = els.findIndex(holdsOutput)
    if (tail < 0) tail = els.length
    if (home.length === 0) nodes.push(wire(p, 'lead'))
    if (packRight) nodes.push(wire(p, 'fill-start', true))
    els.forEach((el, i) => {
      if (!packRight && i === tail) nodes.push(wire(p, `fill${i}`, true))
      else if (i > 0) nodes.push(wire(p, `gap${i}`))
      nodes.push(dropMarker(routine, rung, home, i))
      const at: Sel = { routine, rung, trail: [...home, i] }
      if (!isBranch(el)) {
        nodes.push(<Fragment key={i}>{item(el, at, p)}</Fragment>)
        p = powerOut(el, p)
        return
      }
      const pout = powerOut(el, p)
      const last = el.paths.length - 1
      const within = !!active && active.routine === routine && active.rung === rung && branchOf(routines[routine]!.rungs, active)?.join('.') === at.trail.join('.')
      const pulling = stretch && sameSel(stretch.branch, routine, rung, at.trail) ? stretch : null
      const node = (side: 'left' | 'right'): ReactElement => (
        <i
          key={side}
          className={`ld-node ${side}${pulling?.side === side ? ' pulling' : ''}`}
          data-testid={`ld-branch-node-${side}`}
          style={pulling?.side === side ? { transform: `translateX(${pulling.dx / zoom}px)` } : undefined}
          title={t(M.branchNode)}
          onPointerDown={(e) => F.current.onNodeDown(e, at, side)}
          onPointerMove={(e) => F.current.onNodeMove(e)}
          onPointerUp={(e) => F.current.onNodeUp(e)}
          onClick={(e) => e.stopPropagation()}
        />
      )
      nodes.push(
        <span key={i} className={`ld-branch${sameSel(active, routine, rung, at.trail) ? ' sel' : ''}${within ? ' within' : ''}`} data-testid="ld-branch" data-trail={`${routine}/${rung}/${at.trail.join('.')}`}>
          {within && canEdit && node('left')}
          {within && canEdit && node('right')}
          {el.paths.map((path, k) => {
            const packPath = packRight || i >= tail
            const inner = series(path, routine, rung, [...at.trail, k], p, packPath)
            const trail = [...at.trail, k]
            return (
              <span
                key={k}
                className={`ld-path${sameSel(active, routine, rung, trail) ? ' sel' : ''}`}
                data-testid="ld-path"
                data-series={`${routine}/${rung}/${trail.join('.')}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setSel({ routine, rung, trail })
                  rootRef.current?.focus()
                }}
                onContextMenu={(e) => F.current.openActions(e, { routine, rung, trail })}
              >
                <i className={`ld-v l${p ? ' on' : ''}${k === 0 ? ' first' : ''}${k === last ? ' last' : ''}`} />
                {wire(p, 'in')}
                {inner.nodes}
                {wire(inner.pout, 'out', !packPath, true)}
                <i className={`ld-v r${pout ? ' on' : ''}${k === 0 ? ' first' : ''}${k === last ? ' last' : ''}`} />
              </span>
            )
          })}
        </span>,
      )
      p = pout
    })
    nodes.push(dropMarker(routine, rung, home, els.length))
    if (!packRight && tail === els.length) nodes.push(wire(p, 'fill-end', true))
    // room between the last element and the rail, as there is off the left one: somewhere to drop "after the last"
    if (home.length === 0) nodes.push(wire(p, 'tail', false, true))
    return { nodes, pout: p }
  }

  // Bits more than one element writes every scan - two coils fighting over one bit (a double coil):
  // the last one to run decides it, which is almost never what was meant
  const duplicates = useMemo(() => duplicateDestructive(routines, LADDER.refs), [routines])
  const duplicateOn = (routine: number, rung: number): string | null => {
    const d = duplicates.find((x) => x.at.some((a) => a.routine === routine && a.rung === rung))
    if (!d) return null
    // (each other rung once, however many of its levels write the bit)
    const others = [...new Set(d.at.filter((a) => !(a.routine === routine && a.rung === rung)).map((a) => (routines.length > 1 ? t(M.rungRefOf, { rung: a.rung, section: a.routine + 1 }) : t(M.rungRef, { rung: a.rung }))))]
    // Both writes on this rung (two levels of a branch ending in the same coil), and there is no other rung to
    // name, so the message names this rung rather than ending on an empty list.
    if (others.length === 0) return t(M.duplicateHere, { name: d.name })
    return t(M.duplicateOthers, { name: d.name, rungs: others.join(', ') })
  }
  /** The element a problem is about, selected (a problem's line is a way to it). */
  const showProblem = (e: { stopPropagation: () => void }, ri: number, i: number, k: number): void => {
    e.stopPropagation()
    setSel({ routine: ri, rung: i, trail: routines[ri]?.rungProblemTrails?.[i]?.[k] ?? [] })
    rootRef.current?.focus()
  }

  /** One rung, drawn. Called only for a rung whose `rungSig` changed; every other one keeps the element it had. */
  const drawRung = (r: LadderRoutine, ri: number, rung: Rung, i: number): ReactElement => {
    // an error is what stops the program compiling; a warning (a number converted on its way into a narrower type) is
    // something to know about a rung that works, and is drawn as one. Each keeps its index: the way to its element
    const found = (r.rungProblems[i] ?? []).map((d, k) => ({ d, k }))
    const problems = found.filter((p) => p.d.severity !== 'warning')
    const cautions = found.filter((p) => p.d.severity === 'warning')
    const duplicate = problems.length === 0 ? duplicateOn(ri, i) : null
    const drawn = series(rung.elements, ri, i, [], live ? true : null)
    const isCommenting = commenting?.routine === ri && commenting.rung === i
    const fix = problems.length > 0 && canEdit ? LADDER.quickFix(r, ri, i) : null
    return (
      <div
        key={i}
        className={`ld-rung${sameSel(active, ri, i, []) || rungInRange(ri, i) ? ' sel' : ''}${problems.length > 0 ? ' bad' : ''}${rungDrop?.routine === ri && rungDrop.slot === i ? ' drop-before' : ''}${rungDrop?.routine === ri && rungDrop.slot === i + 1 && i === r.rungs.length - 1 ? ' drop-after' : ''}`}
        data-testid="ladder-rung"
        data-rung-of={ri}
        data-rung-index={i}
        onClick={(e) => F.current.rungClick(e, ri, i)}
        onContextMenu={(e) => F.current.openActions(e, { routine: ri, rung: i, trail: [] })}
      >
        <span
          className="ld-num"
          data-testid="ladder-rung-num"
          title={found.map((p) => p.d.message).join('\n') || (canEdit ? t(M.rungNumber) : undefined)}
          onPointerDown={(e) => F.current.onNumDown(e, ri, i)}
          onPointerMove={(e) => F.current.onNumMove(e)}
          onPointerUp={(e) => F.current.onNumUp(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            F.current.startTextEdit({ routine: ri, rung: i, trail: [] })
          }}
        >
          {problems.length > 0 && <b className="ld-err">e</b>}
          {i}
        </span>
        <span className="ld-rung-body">
          {/* the rung's label, where a jump lands: at the top-left of the rung, so every
              rung's rails still line up */}
          {rung.label && (
            <span className="ld-label" data-testid="ladder-label" title={t(M.labelHint)}>
              {rung.label}:
            </span>
          )}
          {isCommenting ? (
            <textarea
              className="ld-comment-input"
              data-testid="ladder-comment-input"
              autoFocus
              rows={Math.max(1, commenting.draft.split('\n').length)}
              value={commenting.draft}
              onChange={(e) => setCommenting({ ...commenting, draft: e.target.value })}
              onBlur={commitComment}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setCommenting(null)
                else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitComment()
                }
              }}
            />
          ) : (
            rung.comment !== '' && (
              <span className={`ld-comment${isFound({ routine: ri, rung: i, trail: [] }, 'comment') ? ' found' : ''}`} data-testid="ladder-comment" onDoubleClick={() => !locked(r) && setCommenting({ routine: ri, rung: i, draft: rung.comment })}>
                {rung.comment}
              </span>
            )
          )}
          {textEdit && sameSel(textEdit.at, ri, i, []) && (
            <span className="ld-rung-text">
              <input
                className="ld-input ld-textedit"
                data-testid="ladder-text-edit"
                autoFocus
                spellCheck={false}
                value={textEdit.draft}
                aria-label={t(M.rungText)}
                onChange={(e) => setTextEdit({ at: textEdit.at, draft: e.target.value })}
                onFocus={(e) => {
                  const te = textEditRef.current
                  if (!te?.select) return
                  e.currentTarget.setSelectionRange(te.select[0], te.select[1])
                  setTextEdit({ at: te.at, draft: te.draft })
                }}
                onBlur={commitTextEdit}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTextEdit()
                  } else if (e.key === 'Escape') {
                    setTextEdit(null)
                    rootRef.current?.focus()
                  }
                }}
              />
            </span>
          )}
          <span className="ld-line" data-series={`${ri}/${i}/`}>
            <i className={`ld-rail${live ? ' on' : ''}`} />
            {/* a rung too long for the view carries on underneath (`linkWraps`) */}
            <span className="ld-wrap">
              {drawn.nodes}
              {/* a jump or a RETURN ends the rung: it acts on what reaches it */}
              {rung.exit && (
                <span
                  className="ld-exit"
                  data-testid="ladder-exit"
                  title={rung.exit.kind === 'jump' ? t(M.jumpHint, { label: rung.exit.label }) : t(M.returnHint)}
                >
                  {/* i18n-ok: IEC ladder jump and return symbols */}
                  {rung.exit.kind === 'jump' ? `>> ${rung.exit.label}` : '<RETURN>'}
                </span>
              )}
              <span className="ld-links" aria-hidden="true" />
            </span>
            <i className="ld-rail" />
          </span>
          {/* every error, each one a way to the element it is about; the one-click fix after the first */}
          {problems.map((p, n) => (
            <span key={`e${p.k}`} className="ld-problem link" data-testid="ladder-problem" title={t(M.showElement)} onClick={(e) => F.current.showProblem(e, ri, i, p.k)}>
              {p.d.message}
              {n === 0 && fix && (
                <button
                  className="ld-declare"
                  data-testid={fix.testid}
                  title={fix.title}
                  onClick={(e) => {
                    e.stopPropagation()
                    F.current.fix(ri, i)
                  }}
                >
                  {fix.label}
                </button>
              )}
            </span>
          ))}
          {cautions.map((p) => (
            <span key={`w${p.k}`} className="ld-problem warn link" data-testid="ladder-warning" title={t(M.showElement)} onClick={(e) => F.current.showProblem(e, ri, i, p.k)}>
              ⚠ {p.d.message}
            </span>
          ))}
          {duplicate && (
            <span className="ld-problem warn" data-testid="ladder-duplicate">
              ⚠ {duplicate}
            </span>
          )}
        </span>
      </div>
    )
  }

  // ---- drawing only what changed ---------------------------------------------------------------------------------
  //
  // A routine is thousands of DOM nodes, and any state change here - a click, one step of the wheel - would rebuild
  // every rung. Nothing about a rung changes when the selection moves somewhere else, so a rung is drawn again only
  // when its signature changes: whatever its drawing reads, globally (`generation`) or for that rung alone. Whatever a
  // rung's handlers call goes through `F.current`, this render's functions, because an element kept from an earlier
  // render still holds that render's closures.
  //
  // The values are not in `generation`: they change eight times a second while a program runs (the poll
  // above), and clearing the cache for each one rebuilt every rung of the demo's 121 - the whole of it, to show a
  // change of half a rung on an average poll, and none at all on five polls in six. What a rung shows OF them is in
  // its own signature instead (`liveSig`), so a poll redraws the rungs whose numbers actually moved and no others.
  const generation = useRef({ n: 0, deps: [] as unknown[] })
  const rungCache = useRef(new Map<string, { sig: string; el: ReactElement }>())
  /**
   * The operand texts whose values a rung draws - every one `item()` and `powerOut()` ask `valueOf` for
   * (`LADDER.watchTexts`). A superset (a box's every pin, whether or not that row prints a number):
   * a text too many costs a redraw the rung did not need, while a text missing freezes that rung at the values it last
   * showed - which looks exactly like a ladder holding still, so it would not read as a bug.
   * Worked out once per rung object; `LADDER.read` makes new ones only when the text changes.
   */
  const valueTexts = useRef(new WeakMap<Rung, string[]>())
  const textsOf = (rung: Rung): string[] => {
    let texts = valueTexts.current.get(rung)
    if (!texts) {
      const out: string[] = []
      const walk = (els: readonly RungElement[]): void => {
        for (const el of els) {
          if (isBranch(el)) el.paths.forEach(walk)
          else out.push(...LADDER.watchTexts(el))
        }
      }
      walk(rung.elements)
      valueTexts.current.set(rung, (texts = out))
    }
    return texts
  }
  /** What a rung shows of the values, as it would print them. A rung is redrawn only when this changes, and only while
   *  it is on screen. A long routine shows three or four rungs at a time and its values change constantly while a line
   *  runs; redrawing the hidden ones would cost 1.9 s in every 10 (a real routine, one box on the line). A rung out of view
   *  keeps its old numbers and is redrawn with current ones when it comes into view (`inView` below triggers that
   *  render). */
  const lastLive = useRef(new WeakMap<Rung, string>())
  const liveSig = (rung: Rung, ri: number, i: number): string => {
    const stale = lastLive.current.get(rung)
    if (stale !== undefined && inView.current !== null && !inView.current.has(`${ri}/${i}`)) return stale
    // a forced operand is part of what it shows (its mark), so a release with no change of value still redraws it
    const now = textsOf(rung).map((t) => `${fmt(valueOf(t))}${forcedOf(t) ? '!' : ''}`).join('|')
    lastLive.current.set(rung, now)
    return now
  }
  /**
   * What a rung shows of the PROGRAM: its own elements and comment, what the checker said of it, whether its routine
   * can be edited at all, and how many rungs the routine has (the drop marker after the last one). Worked out once per
   * rung object (`LADDER.read` makes new ones only when the text changes), so a render that changed nothing does one map
   * lookup per rung instead of redrawing every rung for a change to one.
   */
  const contentOf = useRef(new WeakMap<Rung, string>())
  const rungContent = (r: LadderRoutine, rung: Rung, i: number): string => {
    let text = contentOf.current.get(rung)
    if (text === undefined) {
      text = JSON.stringify([rung, (r.rungProblems[i] ?? []).map((d) => `${d.severity ?? 'error'}:${d.message}`), r.rungProblemTrails?.[i] ?? [], locked(r), r.unreadable.length, r.rungs.length])
      contentOf.current.set(rung, text)
    }
    return text
  }
  {
    const deps: unknown[] = [live, canEdit, readOnly]
    if (deps.some((d, k) => d !== generation.current.deps[k])) {
      generation.current = { n: generation.current.n + 1, deps }
      rungCache.current.clear()
      valueTexts.current = new WeakMap()
      contentOf.current = new WeakMap()
    }
  }
  const rungSig = (ri: number, i: number): string => {
    const here = (at: Sel | null | undefined): boolean => !!at && at.routine === ri && at.rung === i
    return [
      generation.current.n,
      rungContent(routines[ri]!, routines[ri]!.rungs[i]!, i),
      // (not in the content: a rung's duplicate note changes with other rungs, not only with its own text)
      duplicateOn(ri, i) ?? '',
      liveSig(routines[ri]!.rungs[i]!, ri, i),
      here(active) ? `${selKey(active!)}~${rangeEnd}~${focusedField}` : rungInRange(ri, i) ? 'in-range' : '',
      editing && here(editing.at) ? `${selKey(editing.at)}~${editing.field}~${editing.draft}~${editing.leaving === true}~${proposal.current}~${opError}` : '',
      textEdit && here(textEdit.at) ? `${selKey(textEdit.at)}~${textEdit.draft}` : '',
      // (marked even while the draft is empty: opening the comment of a rung that has none must redraw it)
      commenting?.routine === ri && commenting.rung === i ? `comment~${commenting.draft}` : '',
      stretch && here(stretch.branch) ? `${selKey(stretch.branch)}~${stretch.side}~${stretch.dx}~${stretch.by}~${zoom}` : '',
      dragDrop && here(dragDrop.from) ? `from ${selKey(dragDrop.from)}` : '',
      dragDrop?.slot && dragDrop.slot.routine === ri && dragDrop.slot.rung === i ? `to ${dragDrop.slot.home.join('.')}#${dragDrop.slot.index}` : '',
      rungDrop?.routine === ri ? `${rungDrop.slot}` : '',
      finding && findAt && findAt.routine === ri && findAt.rung === i ? `found~${findAt.trail.join('.')}~${findAt.field}` : '',
      liveEdit && here(liveEdit.at) ? `live~${selKey(liveEdit.at)}~${liveEdit.field}~${liveEdit.draft}` : '',
    ].join('|')
  }
  const rungClick = (e: { stopPropagation: () => void; shiftKey: boolean }, ri: number, i: number): void => {
    e.stopPropagation()
    if (suppressClick.current) return
    if (e.shiftKey && active && selKind(active) === 'rung' && active.routine === ri) setRangeEnd(i)
    else setSel({ routine: ri, rung: i, trail: [] })
    rootRef.current?.focus()
  }
  /** The one-click fix under a rung's problem (`LADDER.quickFix`), made. It goes through `F.current` like every
   *  other handler here, and must: `source` is this render's text, and a rung kept from an earlier render (its own
   *  content unchanged) holds that render's, so calling it directly would write back a stale program and silently drop
   *  every edit made elsewhere since. */
  const fix = (ri: number, i: number): void => {
    const r = routines[ri]
    const q = r && LADDER.quickFix(r, ri, i)
    if (q) onEdit(q.apply(source))
  }
  const handlers = { pickCell, rungClick, onCellDoubleClick, onCellDown, onCellMove, onCellUp, onNodeDown, onNodeMove, onNodeUp, onNumDown, onNumMove, onNumUp, startTextEdit, fix, fieldMenu, openActions, showProblem }
  const F = useRef(handlers)
  F.current = handlers

  // Seen for a moment at most: the PLC panel opens a sheet only on a ladder POU, and goes back to the text once its marks
  // catch up with a program that has lost its last ladder (StEditor `scheduleMarks`). A ladder comes from the organizer's
  // "+ New", as a Ladder program, the way a vendor tool makes a routine of a language.
  if (routines.length === 0) {
    return (
      <div className="ld-root ld-empty" data-testid="ladder-view">
        <p>{t(M.noLadder)}</p>
        {!readOnly && <p className="ld-dim">{t(M.noLadderHint)}</p>}
      </div>
    )
  }

  const kind = active ? selKind(active) : null
  // only the editable bar reads this, so the one reason left is a section that does not parse as rungs
  const why = !canEdit ? t(M.fixRungText) : undefined
  /** The selection's menu. Each item runs after the menu has closed and handed the focus back to the sheet, so what it
   *  opens (the comment box, the Find bar, a dialog) keeps the focus it takes. */
  const actionItems = (): MenuItem[] => {
    const later = (fn: () => void) => () => void window.setTimeout(fn, 0)
    const has = selectionText() !== ''
    const off = !canEdit || !active
    const rungs = target?.rungs.length ?? 0
    const tag = focusedTag()
    const watched = watchTarget()
    const bit = toggleTarget()
    const forcing = forceTarget()
    const sep = SEPARATOR
    return [
      { label: t(M.cut), testid: 'ladder-cut', keys: primaryKey('edit.cut'), disabled: off || !has, title: why, onClick: later(() => { if (copySelection() !== '') deleteSelection() }) },
      { label: t(M.copy), testid: 'ladder-copy', keys: primaryKey('edit.copy'), disabled: !active || !has, title: t(M.copyHint), onClick: later(() => void copySelection()) },
      { label: t(M.paste), testid: 'ladder-paste', keys: primaryKey('edit.paste'), disabled: !canEdit, title: why ?? t(M.pasteHint), onClick: later(pasteFromClipboard) },
      { label: t(M.delete), testid: 'ladder-delete', keys: primaryKey('edit.delete'), disabled: off, title: why, onClick: later(deleteSelection) },
      sep,
      { label: t(M.commentRung), testid: 'ladder-comment-btn', keys: kind === 'rung' ? primaryKey('ladder.describe') : undefined, disabled: off, title: why, onClick: later(() => active && setCommenting({ routine: active.routine, rung: active.rung, draft: target!.rungs[active.rung]!.comment })) },
      { label: t(M.moveRungUp), testid: 'ladder-rung-up', keys: primaryKey('edit.moveUp'), disabled: off || active.rung === 0, title: why, onClick: later(() => moveSelectedRung(-1)) },
      { label: t(M.moveRungDown), testid: 'ladder-rung-down', keys: primaryKey('edit.moveDown'), disabled: off || active.rung >= rungs - 1, title: why, onClick: later(() => moveSelectedRung(1)) },
      { label: t(M.addBranchLevel), testid: 'ladder-path', disabled: off || !canAddPath(target!.rungs, active), title: why ?? t(M.addBranchLevelHint), onClick: later(() => void apply(addPath)) },
      sep,
      { label: t(M.toggleBit), testid: 'ladder-toggle-bit-item', keys: primaryKey('ladder.toggleBit'), disabled: !bit, title: t(!live ? M.toggleBitIdle : bit && forcedOf(bit.key) ? M.toggleBitForcedHint : M.toggleBitHint), onClick: later(toggle) },
      ...(onWatch ? [{ label: watched !== null ? t(M.addNameToWatch, { name: watched }) : t(M.addToWatch), testid: 'ladder-add-to-watch', disabled: watched === null, title: t(M.addToWatchHint), onClick: later(() => watched !== null && onWatch(watched)) }] : []),
      ...(forcing
        ? [{ label: t(forcing.forced ? M.releaseName : M.forceName, { name: forcing.key }), testid: 'ladder-force', title: t(forcing.forced ? M.releaseHint : M.forceHint), onClick: later(() => forceOrRelease(forcing)) }]
        : []),
      { label: t(M.crossReference), testid: 'ladder-xref', keys: primaryKey('ladder.crossRef'), disabled: !tag, title: t(M.crossReferenceHint), onClick: later(() => tag && setXref(tag)) },
      { label: t(M.findItem), testid: 'ladder-find-open', keys: primaryKey('ladder.find'), title: t(M.findItemHint), onClick: later(() => openFind(false)) },
    ]
  }
  // The scale readout: the only control in that bar which is not an edit, so the read-only view keeps it. Lifted out
  // of the element tabs row for that - it is the whole bar there.
  const zoomEl = zoom !== 1 && (
    <button
      className="ld-zoom"
      data-testid="ladder-zoom"
      title={withKey(t(M.zoom, { percent: Math.round(zoom * 100) }), 'ladder.zoomReset')}
      onClick={() => stepZoom(1)}
    >
      {Math.round(zoom * 100)}%
    </button>
  )
  const tab = LADDER.palette.find((set) => set.tab === paletteTab) ?? LADDER.palette[0]
  return (
    <div
      className="ld-root"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onCut={(e) => {
        onCopy(e)
        if (e.defaultPrevented) deleteSelection()
      }}
      onPaste={onPaste}
      data-testid="ladder-view"
      onClick={() => setSel(null)}
    >
      {/* the view refused an edit: the same red the rung problems use, in the banner shape .ld-idle set, because a
          bare line of body text at the top of the panel reads as a caption and not as the reason nothing happened */}
      {opError && (
        <div className="ld-toast" role="alert" data-testid="ladder-operand-error" title={t(M.dismiss)} onClick={() => setOpError(null)}>
          <span>⚠ {opError}</span>
          <span className="ld-toast-x" aria-hidden="true"><CloseIcon /></span>
        </div>
      )}
      {idleProgram !== null && idle && (
        <div className="ld-idle" data-testid="ladder-idle" onClick={(e) => e.stopPropagation()}>
          <span>
            {tNodes(running ? M.idleLive : M.idle, { program: <b>{idleProgram}</b>, running: idle.running })}
          </span>
        </div>
      )}
      {finding && (
        <div
          className="ld-find"
          data-testid="ladder-find"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              closeFind()
            } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
              e.preventDefault()
              e.stopPropagation()
              if ((e.target as HTMLElement).dataset.testid === 'ladder-find-with') replaceOne()
              else findStep(e.shiftKey ? -1 : 1)
            }
          }}
        >
          <input
            ref={findInput}
            className="ld-find-input"
            data-testid="ladder-find-what"
            placeholder={t(M.find)}
            spellCheck={false}
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value)
              setFindAt(null)
              setFindNote('')
            }}
          />
          {finding.replace && (
            <input className="ld-find-input" data-testid="ladder-find-with" placeholder={t(M.replaceWith)} spellCheck={false} value={findWith} onChange={(e) => setFindWith(e.target.value)} />
          )}
          <button className="ld-btn" data-testid="ladder-find-prev" disabled={findQuery === ''} title={withKey(t(M.previousMatch), 'ladder.findPrev')} onClick={() => findStep(-1)}>
            ↑
          </button>
          <button className="ld-btn" data-testid="ladder-find-next" disabled={findQuery === ''} title={withKey(t(M.nextMatch), 'ladder.findNext')} onClick={() => findStep(1)}>
            ↓
          </button>
          {!readOnly && (
            <button className="ld-btn" data-testid="ladder-find-show-replace" aria-pressed={finding.replace} title={finding.replace ? t(M.hideReplace) : withKey(t(M.replace), 'ladder.replace')} onClick={() => setFinding({ replace: !finding.replace })}>
              {t(M.showReplace)}
            </button>
          )}
          {finding.replace && (
            <>
              <button className="ld-btn" data-testid="ladder-replace" disabled={findQuery === '' || readOnly} title={t(readOnly ? M.readOnly : M.replaceHint)} onClick={replaceOne}>
                {t(M.replace)}
              </button>
              <button className="ld-btn" data-testid="ladder-replace-all" disabled={found.length === 0 || readOnly} title={t(readOnly ? M.readOnly : M.replaceAllHint)} onClick={replaceAll}>
                {t(M.replaceAll)}
              </button>
            </>
          )}
          <label className="ld-find-opt" title={t(M.wholeWordHint)}>
            <input type="checkbox" data-testid="ladder-find-whole" checked={findWhole} onChange={(e) => setFindWhole(e.target.checked)} /> {t(M.wholeWord)}
          </label>
          <label className="ld-find-opt" title={t(M.wrapHint)}>
            <input type="checkbox" data-testid="ladder-find-wrap" checked={findWrap} onChange={(e) => setFindWrap(e.target.checked)} /> {t(M.wrap)}
          </label>
          <select className="ld-find-scope" data-testid="ladder-find-scope" value={findScope} onChange={(e) => setFindScope(e.target.value as 'routine' | 'all')}>
            <option value="routine">{t(M.thisSection)}</option>
            <option value="all">{t(M.allSections)}</option>
          </select>
          <span className="ld-find-count" data-testid="ladder-find-count">
            {findCount}
          </span>
          <button className="ld-btn ld-find-close" data-testid="ladder-find-close" title={t(M.close)} onClick={closeFind}>
            <CloseIcon />
          </button>
        </div>
      )}
      {picking !== null && (
        <BoxPicker
          choices={boxChoices}
          prompt={t(M.boxPrompt)}
          onClose={closePicker}
          onPick={(key) => {
            setPicking(null)
            rootRef.current?.focus()
            insert({ key })
          }}
        />
      )}
      {/* (a click in the menu, or on its backdrop to dismiss it, must not reach the sheet's own click, which clears the
          selection the item is about to act on) */}
      {menu && (
        <div style={{ display: 'contents' }} onClick={(e) => e.stopPropagation()}>
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={actionItems()}
          onClose={() => setMenu(null)}
        />
        </div>
      )}
      {xref && (
        <CrossRefDialog
          name={xref}
          refs={crossReference(source, xref, routines, LADDER.refs)}
          declaration={LADDER.declaration(source, xref)}
          devices={devicesForTag(getDevices?.() ?? [], xref)}
          onOpenRung={(routine, rung) => {
            setXref(null)
            setSel({ routine, rung, trail: [] })
            rootRef.current?.focus()
          }}
          onOpenText={(offset) => {
            setXref(null)
            onShowText?.(offset)
          }}
          onClose={() => setXref(null)}
        />
      )}
      <datalist id="ld-tags">
        {(typeAhead?.names ?? tagOptions).map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {/* The element bar: one row of what you add, and at its right end the "⋯" that opens the selection's menu (the
          one a right-click on a rung or element opens) - and under it the tabs that choose which elements the middle
          offers (tabs under their strip). One row: the PLC dock gives this view about
          340px, and a second full-width band of buttons costs a third of the rungs that are left. That is why Cut /
          Copy / Paste / Delete, Comment, the rung moves, Cross Reference and Find live in the menu, not here: each has
          a chord, and the menu names it. Toggle Bit is the one exception, shown only while the program runs. It wraps,
          never clips, when the panel is narrower.

          A READ-ONLY view drops the bar rather than disabling it, which is the rule the PLC panel's header already
          follows (StEditor's commandsEl). Its controls wrap to five or six rows on the mobile PLC sheet - a
          third of a drawer whose whole job is to show rungs - and not one of them can act; the tabs go with them,
          since all they choose is which elements the strip offers. The scale readout is not an edit, so it stays. */}
      {readOnly ? (
        zoomEl && (
          <div className="ld-elements ld-elements-view" data-testid="ladder-elements-view" onClick={(e) => e.stopPropagation()}>
            {zoomEl}
          </div>
        )
      ) : (
      <div className="ld-elements" data-testid="ladder-elements" onClick={(e) => e.stopPropagation()}>
        <div className="ld-element-strip">
          <button className="ld-btn" data-testid="ladder-add-rung" disabled={!canEdit} title={why ?? t(M.addRungHint)} onClick={newRung}>
            {t(M.addRung)}
          </button>
          <button className="ld-btn" data-testid="ladder-branch" disabled={!canEdit || !active} title={why ?? t(M.branchHint)} onClick={() => apply(addBranch)}>
            {t(M.branch)}
          </button>
          {/* the same action as the menu's Add Branch Level, one click away beside Branch */}
          <button className="ld-btn" data-testid="ladder-path-btn" disabled={!canEdit || !active || !canAddPath(target!.rungs, active)} title={why ?? t(M.branchLevelHint)} onClick={() => apply(addPath)}>
            {t(M.branchLevel)}
          </button>
          <button className="ld-btn" data-testid="ladder-insert-box" disabled={!canEdit} title={why ?? withKey(t(M.insertBoxHint), 'ladder.insertBox')} onClick={openPicker}>
            {t(M.insertBox)}
          </button>
          <button className="ld-btn" data-testid="ladder-add-jump" disabled={!canEdit || !active} title={why ?? t(M.jumpAddHint)} onClick={() => addEnd('jump')}>
            {t(M.jump)}
          </button>
          <button className="ld-btn" data-testid="ladder-add-label" disabled={!canEdit || !active} title={why ?? t(M.labelAddHint)} onClick={() => addEnd('label')}>
            {t(M.label)}
          </button>
          <button className="ld-btn" data-testid="ladder-add-return" disabled={!canEdit || !active} title={why ?? t(M.returnAddHint)} onClick={() => addEnd('return')}>
            {t(M.return)}
          </button>
          <span className="ld-sep" />
          {tab?.groups.map((g) => (
            <div key={g.label} className="ld-pal-group" role="group" aria-label={t(g.label)}>
              {g.items.map((entry) => (
                <button key={entry.key} className="ld-btn ld-pal" data-testid={`ladder-insert-${entry.key}`} disabled={!canEdit} title={why ?? t(M.paletteHint, { what: t(entry.title, entry.titleParams) })} onClick={() => insert(entry)}>
                  {entry.label}
                </button>
              ))}
            </div>
          ))}
          {/* what happens to what is selected. Held to the right end of the row, so it keeps its place as the
              tabs below change the width of the middle. */}
          <div className="ld-strip-edit">
            {/* Toggle Bit is what an engineer does online, and a browser keeps its Ctrl+T: while the program runs, and only
                then, it is a button too */}
            {live && (
              <button
                className="ld-btn"
                data-testid="ladder-toggle-bit"
                disabled={!toggleTarget()}
                title={t(M.toggleBitButton, { what: withKey(t(M.toggleBitHint), 'ladder.toggleBit') })}
                onClick={toggle}
              >
                {t(M.toggleBit)}
              </button>
            )}
            <button
              className="ld-btn"
              data-testid="ladder-more"
              aria-haspopup="menu"
              title={t(M.moreHint)}
              onClick={(e) => {
                const b = e.currentTarget.getBoundingClientRect()
                setMenu({ x: b.left, y: b.bottom + 2 })
              }}
            >
              ⋯
            </button>
          </div>
        </div>
        <div className="ld-element-tabs" role="tablist" aria-label={t(M.elementSets)}>
          {LADDER.palette.map((set) => (
            <button key={set.tab} role="tab" aria-selected={set.tab === paletteTab} className={`ld-pal-label${set.tab === paletteTab ? ' on' : ''}`} data-testid={`ladder-tab-${set.tab}`} onClick={() => setPaletteTab(set.tab)}>
              {t(set.label)}
            </button>
          ))}
          {/* the scale, in the empty half of this row and only while it is not 100%: at the default it takes no room,
              and a sheet left at 40% by a stray Ctrl+wheel shows it and offers a way back */}
          {zoomEl}
        </div>
      </div>
      )}
      {/* the scroller is not what is scaled: a scaled scroller grows past its panel, taking its scrollbars out of reach.
          The sheet inside it is scaled, and the scroller scrolls it both ways. */}
      <div className="ld-scroll" ref={scrollRef} data-zoom={zoom}>
        <div className="ld-sheet" ref={zoomRef} style={{ zoom }}>
          {routines.map((r, ri) => (
            <section key={ri} className="ld-routine" data-testid="ladder-routine" data-routine-index={ri}>
              <RoutineHead routine={r} index={ri} source={source} readOnly={readOnly} onEdit={onEdit} onShowText={onShowText} onRenameTag={onRenameTag} />
              {r.unreadable.length > 0 && (
                <div className="ld-banner" data-testid="ladder-unreadable">
                  {t(M.unreadable, { message: r.unreadable[0]!.message, line: r.unreadable[0]!.pos.line })}
                </div>
              )}
              {r.rungs.map((rung, i) => {
                const sig = rungSig(ri, i)
                const kept = rungCache.current.get(`${ri}/${i}`)
                if (kept && kept.sig === sig) return kept.el
                const el = drawRung(r, ri, rung, i)
                rungCache.current.set(`${ri}/${i}`, { sig, el })
                return el
              })}
              {r.rungs.length === 0 && <div className="ld-dim ld-pad">{t(M.noRungs)}</div>}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
