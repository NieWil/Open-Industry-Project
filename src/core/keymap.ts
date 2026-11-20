/**
 * The keymap: every keyboard binding in the editor as one table, plus the matcher the
 * listeners resolve against.
 *
 * Why this exists, beyond tidiness:
 *
 * 1. **Layout correctness.** `e.key` is the legend on the key and depends on the keyboard layout:
 *    on AZERTY the physical W and A keys report 'z' and 'q', which would scatter the W/E/R tool
 *    cluster and WASD fly/walk. `e.code` is the physical position, so spatial keys match on it
 *    (Numpad5, which reports key 'Clear' with NumLock off, needs it too). Ctrl combos stay logical:
 *    every desktop app puts undo on the key labelled Z (see `match` below).
 *
 * 2. **Discoverability.** The shortcuts reference panel renders straight off this table, so a new
 *    binding can't ship undocumented.
 *
 * 3. **Rebinding.** `resolveKeymap(overrides)` is the seam the Settings overlay supplies (and
 *    persists, editor/keymapPrefs.ts) an override map through.
 *
 * Headless and DOM-free, like the rest of core: events arrive as `KeyEventLike`, which a real
 * KeyboardEvent satisfies structurally.
 */

import { defineMessage, t, type MessageId } from './i18n'

/** the modal context a binding belongs to. Chords only conflict within a mode (W is both the
 *  Move tool and fly-forward, which is fine: the modes are never live at the same time) */
export type KeyMode = 'editor' | 'fly' | 'pilot' | 'ladder'

/**
 * How a chord's key token is compared against the event:
 * - `physical` (default): against `e.code`, the key's position. Right for spatial keys: tools,
 *   movement, view toggles. A French user's Move tool stays under their left ring finger.
 * - `logical`: against `e.key`, the key's legend. Right for the clipboard/undo family, which
 *   users expect on the printed letter, and for modifier keys. A chord with Alt is matched by
 *   position all the same, because Alt changes the character the key reports (`matchesChord`).
 */
export type KeyMatch = 'physical' | 'logical'

/** the subset of KeyboardEvent the matcher reads. `code` is optional because synthetic events
 *  (`new KeyboardEvent('keydown', { key: 'g' })`, which a couple of e2e scripts dispatch) omit it -
 *  those fall back to the logical comparison. */
export interface KeyEventLike {
  readonly code?: string
  readonly key: string
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
}

export interface KeyBinding {
  readonly id: string
  readonly mode: KeyMode
  readonly group: string
  readonly label: string
  /** chords, in `mod+mod+Token` form. Token is a KeyboardEvent.code name (`KeyW`, `Period`,
   *  `Numpad5`) whichever `match` is used; `logical` maps it back to the legend. Modifiers are
   *  `ctrl` (ctrl or meta, so Cmd counts as Ctrl), `shift`, `alt`, `meta` (meta only, for the
   *  macOS-specific chords). Modifiers must match exactly: `KeyG` does not fire for Shift+G, which
   *  is a separate binding. */
  readonly keys: readonly string[]
  readonly match?: KeyMatch
  /** shown under the label in the shortcuts panel */
  readonly hint?: string
  /**
   * Modifier state is ignored for this chord. For the held keys of a modal gesture, where
   * modifiers change mid-gesture. Every fly/walk movement key needs it: Shift is the boost, so
   * strict matching would (a) refuse W while boosting and, worse, (b) miss the keyup of a key
   * pressed before Shift went down, leaving the camera stuck moving. Editor shortcuts stay strict,
   * which keeps G and Shift+G distinct.
   */
  readonly anyModifiers?: true
  /** documented here but not routed through `resolveKeyAction`: the handler pre-empts it in a
   *  modal branch (Escape, which means "back out of whatever is in flight"). Listed so the panel
   *  is complete; a future rebinding UI must refuse to remap these. */
  readonly fixed?: true
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

export const KEY_BINDINGS = [
  // --- file ---------------------------------------------------------------
  // logical, like undo: Save is on the printed S in every app. The app binds it itself (editor/App.tsx),
  // on the desktop too, because the browser has no menu to register it. Unbound, the press opens the
  // browser's own "Save page as", which saves the app's HTML.
  { id: 'file.save', mode: 'editor', group: 'File', label: 'Save', keys: ['ctrl+KeyS'], match: 'logical', hint: 'your work also saves itself as you go' },

  // --- tools ---------------------------------------------------------------
  { id: 'tool.transform', mode: 'editor', group: 'Tools', label: 'Transform', keys: ['KeyQ'], hint: 'combined move + rotate gizmo' },
  { id: 'tool.select', mode: 'editor', group: 'Tools', label: 'Select', keys: ['KeyV'] },
  { id: 'tool.move', mode: 'editor', group: 'Tools', label: 'Move', keys: ['KeyW'] },
  { id: 'tool.rotate', mode: 'editor', group: 'Tools', label: 'Rotate', keys: ['KeyE'] },
  { id: 'tool.ruler', mode: 'editor', group: 'Tools', label: 'Measure', keys: ['KeyM'], hint: 'click two points; Esc clears' },

  // --- editing (logical: the clipboard family belongs on the printed letter) ------------------
  { id: 'edit.undo', mode: 'editor', group: 'Edit', label: 'Undo', keys: ['ctrl+KeyZ'], match: 'logical' },
  { id: 'edit.redo', mode: 'editor', group: 'Edit', label: 'Redo', keys: ['ctrl+shift+KeyZ', 'ctrl+KeyY'], match: 'logical' },
  { id: 'edit.duplicate', mode: 'editor', group: 'Edit', label: 'Duplicate', keys: ['ctrl+KeyD'], match: 'logical' },
  { id: 'edit.copy', mode: 'editor', group: 'Edit', label: 'Copy', keys: ['ctrl+KeyC'], match: 'logical' },
  { id: 'edit.cut', mode: 'editor', group: 'Edit', label: 'Cut', keys: ['ctrl+KeyX'], match: 'logical' },
  { id: 'edit.paste', mode: 'editor', group: 'Edit', label: 'Paste', keys: ['ctrl+KeyV'], match: 'logical' },
  { id: 'edit.delete', mode: 'editor', group: 'Edit', label: 'Delete', keys: ['Delete', 'Backspace'] },
  { id: 'edit.sideGuards', mode: 'editor', group: 'Edit', label: 'Edit guard openings', keys: ['KeyG'], hint: 'with a conveyor selected: drag along a guard to cut an opening, Delete removes the clicked one, Esc exits' },
  { id: 'edit.rename', mode: 'editor', group: 'Edit', label: 'Rename', keys: ['F2'], hint: 'the selected part in the scene tree, or the declaration under the caret in the PLC text' },
  { id: 'edit.goToDefinition', mode: 'editor', group: 'Edit', label: 'Go to definition', keys: ['F12'], hint: 'where the name under the caret in the PLC text is declared' },
  // In the PLC text only. On a Mac Option+arrow moves the caret by a word, so the text keeps these two chords
  // there (StEditor.tsx) and the editor's right-click menu is the way in until they are rebound.
  { id: 'edit.jumpBack', mode: 'editor', group: 'Edit', label: 'Go back', keys: ['alt+ArrowLeft'], hint: 'to where the caret was before Go to definition' },
  { id: 'edit.jumpForward', mode: 'editor', group: 'Edit', label: 'Go forward', keys: ['alt+ArrowRight'], hint: 'after Go back' },
  { id: 'edit.moveUp', mode: 'editor', group: 'Edit', label: 'Move up one slot', keys: ['ctrl+ArrowUp'], match: 'logical' },
  { id: 'edit.moveDown', mode: 'editor', group: 'Edit', label: 'Move down one slot', keys: ['ctrl+ArrowDown'], match: 'logical' },
  { id: 'edit.lock', mode: 'editor', group: 'Edit', label: 'Lock', keys: ['ctrl+KeyL'], match: 'logical' },
  { id: 'edit.unlock', mode: 'editor', group: 'Edit', label: 'Unlock', keys: ['ctrl+shift+KeyL'], match: 'logical' },
  { id: 'edit.toggleVisible', mode: 'editor', group: 'Edit', label: 'Hide / show', keys: ['KeyH'], hint: 'hides the selection, or shows it all when any of it is hidden' },
  // The ids say 'group' although the label is 'Select as one' ('Group' names the container Ctrl+J makes).
  // A user's rebinding is stored under the id, so the ids don't change.
  { id: 'edit.group', mode: 'editor', group: 'Edit', label: 'Select as one', keys: ['ctrl+KeyG'], match: 'logical', hint: 'a viewport click on any part inside selects the whole' },
  { id: 'edit.ungroup', mode: 'editor', group: 'Edit', label: 'Select parts individually', keys: ['ctrl+shift+KeyG'], match: 'logical' },
  { id: 'edit.reparent', mode: 'editor', group: 'Edit', label: 'Reparent to new node', keys: ['ctrl+KeyJ'], match: 'logical', hint: 'wraps the selection in a fresh Group' },
  { id: 'ui.cancel', mode: 'editor', group: 'Edit', label: 'Cancel / deselect', keys: ['Escape'], fixed: true, hint: 'also backs out of Present, placing, a drag, or the ruler' },

  // --- placement & snapping ------------------------------------------------
  { id: 'snap.grid', mode: 'editor', group: 'Snapping', label: 'Grid snap', keys: ['KeyY'] },
  { id: 'snap.live', mode: 'editor', group: 'Snapping', label: 'Part snap', keys: ['KeyN'], hint: 'declared mates: conveyor ends, device mounts' },
  { id: 'snap.face', mode: 'editor', group: 'Snapping', label: 'Face snap', keys: ['shift+KeyN'], hint: 'flush a box onto a neighbour face' },
  { id: 'snap.vertex', mode: 'editor', group: 'Snapping', label: 'Vertex snap', keys: ['KeyB'], hint: 'hold; drag a corner onto another part' },
  { id: 'place.floor', mode: 'editor', group: 'Snapping', label: 'Drop to floor', keys: ['PageDown'] },
  { id: 'place.reposition', mode: 'editor', group: 'Snapping', label: 'Reposition on surfaces', keys: ['shift+KeyG'], hint: 'then Alt aligns to the face, X/Y/Z pick the axis' },

  // --- view & camera -------------------------------------------------------
  { id: 'view.focus', mode: 'editor', group: 'View', label: 'Focus selection', keys: ['KeyF'], hint: 'press again to follow it as it moves' },
  { id: 'view.space', mode: 'editor', group: 'View', label: 'Local / global space', keys: ['KeyT'] },
  { id: 'view.trackball', mode: 'editor', group: 'View', label: 'Trackball rotate', keys: ['KeyU'] },
  { id: 'view.projection', mode: 'editor', group: 'View', label: 'Perspective / orthographic', keys: ['KeyO', 'Numpad5'] },
  // The orbit gizmo's axis balls from the keyboard: an orthographic view down a world axis, Ctrl for the opposite side
  { id: 'view.front', mode: 'editor', group: 'View', label: 'Front view', keys: ['Numpad1'], hint: 'Ctrl for the rear' },
  { id: 'view.rear', mode: 'editor', group: 'View', label: 'Rear view', keys: ['ctrl+Numpad1'] },
  { id: 'view.right', mode: 'editor', group: 'View', label: 'Right view', keys: ['Numpad3'], hint: 'Ctrl for the left' },
  { id: 'view.left', mode: 'editor', group: 'View', label: 'Left view', keys: ['ctrl+Numpad3'] },
  { id: 'view.top', mode: 'editor', group: 'View', label: 'Top view', keys: ['Numpad7'], hint: 'Ctrl for the bottom' },
  { id: 'view.bottom', mode: 'editor', group: 'View', label: 'Bottom view', keys: ['ctrl+Numpad7'] },
  { id: 'view.flowArrows', mode: 'editor', group: 'View', label: 'Flow arrows', keys: ['Period'] },
  { id: 'camera.freelook', mode: 'editor', group: 'View', label: 'Free fly', keys: ['shift+KeyF'], hint: 'or hold the right mouse button' },
  { id: 'view.distractionFree', mode: 'editor', group: 'View', label: 'Distraction-free mode', keys: ['ctrl+shift+F11', 'meta+shift+KeyD'], match: 'logical' },

  // --- simulation ----------------------------------------------------------
  { id: 'sim.use', mode: 'editor', group: 'Simulation', label: 'Use selected part', keys: ['KeyC'], hint: 'blade stops, transfers; freezes selected live cargo' },
  { id: 'pilot.enter', mode: 'editor', group: 'Simulation', label: 'Pilot mode', keys: ['KeyP'], hint: 'first-person walk-around' },
  // The transport, bound by the app (editor/App.tsx) so the browser has one, and in the desktop app beside the
  // menu's F5 / F6 / Shift+F5 (commands.ts `accelerator`: different chords, so nothing fires twice). Not F5 in
  // the browser: the page owns it, and a Ctrl+F5 hard reload can't be prevented. Space is what a web visitor
  // guesses (a video player's). It plays and pauses but never stops, because Stop resets the run (cargo gone,
  // the PLC restarted) and the biggest key on the board must not do the one thing you can't undo. Stop is
  // Shift+ the play key, as Shift+F5 is F5's. Physical: Space has no legend to move. The listener is inactive
  // in text, dialogs, menus and free fly, whose boost is Space too (see App.tsx).
  { id: 'sim.playPause', mode: 'editor', group: 'Simulation', label: 'Play / pause', keys: ['Space'], hint: 'starts a stopped simulation; F5 / F6 in the desktop app' },
  { id: 'sim.stop', mode: 'editor', group: 'Simulation', label: 'Stop', keys: ['shift+Space'], hint: 'Shift+F5 in the desktop app' },
  // Shift+Period types '>', which reads as "next". Auto-repeat steps again, so holding it plays the run slowly.
  { id: 'sim.step', mode: 'editor', group: 'Simulation', label: 'Step one physics step', keys: ['shift+Period'], hint: 'while paused; F7 in the desktop app' },

  // --- help ----------------------------------------------------------------
  { id: 'ui.shortcuts', mode: 'editor', group: 'Help', label: 'Keyboard shortcuts', keys: ['shift+Slash'] },
  // logical: it's a Ctrl chord on the printed letter, like undo. On the web, which has no menu bar, it is
  // the way to reach every app-level command (see editor/commands.ts)
  { id: 'ui.commands', mode: 'editor', group: 'Help', label: 'Command palette', keys: ['ctrl+shift+KeyP'], match: 'logical', hint: 'search every menu command' },

  // --- the ladder view (editor/components/plc/LadderView.tsx), while it has the keyboard ---------------------
  // Its Delete, Ctrl+C/X/V and Ctrl+Z/Y are the Edit group's: the same chords, acting on the rungs.
  { id: 'ladder.prev', mode: 'ladder', group: 'Ladder', label: 'Previous element', keys: ['ArrowLeft'], hint: 'through branches, and on to the rung above' },
  { id: 'ladder.next', mode: 'ladder', group: 'Ladder', label: 'Next element', keys: ['ArrowRight'], hint: 'through branches, and on to the rung below' },
  { id: 'ladder.up', mode: 'ladder', group: 'Ladder', label: 'Field / rung above', keys: ['ArrowUp'], hint: "on a block, its fields; on a rung, the rung above" },
  { id: 'ladder.down', mode: 'ladder', group: 'Ladder', label: 'Field / rung below', keys: ['ArrowDown'] },
  { id: 'ladder.extendPrev', mode: 'ladder', group: 'Ladder', label: 'Extend the selection left', keys: ['shift+ArrowLeft'] },
  { id: 'ladder.extendNext', mode: 'ladder', group: 'Ladder', label: 'Extend the selection right', keys: ['shift+ArrowRight'] },
  { id: 'ladder.extendUp', mode: 'ladder', group: 'Ladder', label: 'Extend the selection up a rung', keys: ['shift+ArrowUp'] },
  { id: 'ladder.extendDown', mode: 'ladder', group: 'Ladder', label: 'Extend the selection down a rung', keys: ['shift+ArrowDown'] },
  { id: 'ladder.edit', mode: 'ladder', group: 'Ladder', label: 'Edit the field', keys: ['Enter'], hint: 'double-click does the same' },
  // element to element, where the arrows walk a block's fields one at a time
  { id: 'ladder.stepNext', mode: 'ladder', group: 'Ladder', label: 'Next element (whole)', keys: ['Tab'], hint: 'a block is ONE stop, where Right walks its fields' },
  { id: 'ladder.stepPrev', mode: 'ladder', group: 'Ladder', label: 'Previous element (whole)', keys: ['shift+Tab'] },
  { id: 'ladder.describe', mode: 'ladder', group: 'Ladder', label: 'Edit description', keys: ['ctrl+KeyD'], match: 'logical', hint: 'on a selected rung, its comment' },
  // Ctrl+wheel scales the sheet; these do the same from the keyboard. They also make the gesture discoverable:
  // the shortcuts panel renders this table, and a wheel gesture has nowhere else to be written down. They take
  // the chords the browser uses for page zoom on purpose: the view already claims Ctrl+wheel for the same reason,
  // and a reader expects them to zoom the code sheet.
  { id: 'ladder.zoomIn', mode: 'ladder', group: 'Ladder', label: 'Zoom in', keys: ['ctrl+Equal', 'ctrl+shift+Equal'], match: 'logical', hint: 'Ctrl+wheel does the same; the scale shows beside the tabs while it is not 100%' },
  { id: 'ladder.zoomOut', mode: 'ladder', group: 'Ladder', label: 'Zoom out', keys: ['ctrl+Minus'], match: 'logical' },
  { id: 'ladder.zoomReset', mode: 'ladder', group: 'Ladder', label: 'Zoom to 100%', keys: ['ctrl+Digit0'], match: 'logical' },
  { id: 'ladder.find', mode: 'ladder', group: 'Ladder', label: 'Find', keys: ['ctrl+KeyF'], match: 'logical' },
  { id: 'ladder.replace', mode: 'ladder', group: 'Ladder', label: 'Replace', keys: ['ctrl+KeyH', 'meta+alt+KeyF'], match: 'logical', hint: 'on a Mac ⌘H hides the app, so ⌘⌥F is the one to use there' },
  { id: 'ladder.findNext', mode: 'ladder', group: 'Ladder', label: 'Next match', keys: ['F3'], hint: 'Enter in the Find field does the same' },
  { id: 'ladder.findPrev', mode: 'ladder', group: 'Ladder', label: 'Previous match', keys: ['shift+F3'] },
  { id: 'ladder.toggleBit', mode: 'ladder', group: 'Ladder', label: 'Toggle the bit', keys: ['ctrl+KeyT'], match: 'logical', hint: 'the BOOL under the selection, once, while the program runs (a browser tab keeps Ctrl+T for itself: the right-click menu has it too, and the strip while the program runs)' },
  { id: 'ladder.insertBox', mode: 'ladder', group: 'Ladder', label: 'Insert a block', keys: ['ctrl+KeyB'], match: 'logical', hint: "anything a rung can call, this program's own first, found by typing" },
  { id: 'ladder.crossRef', mode: 'ladder', group: 'Ladder', label: 'Cross reference', keys: ['ctrl+KeyE'], match: 'logical', hint: 'everywhere the tag under the selection is used' },

  // --- free fly ------------------------------------------------------------
  { id: 'fly.forward', mode: 'fly', group: 'Free fly', label: 'Forward', keys: ['KeyW'], anyModifiers: true },
  { id: 'fly.back', mode: 'fly', group: 'Free fly', label: 'Back', keys: ['KeyS'], anyModifiers: true },
  { id: 'fly.left', mode: 'fly', group: 'Free fly', label: 'Left', keys: ['KeyA'], anyModifiers: true },
  { id: 'fly.right', mode: 'fly', group: 'Free fly', label: 'Right', keys: ['KeyD'], anyModifiers: true },
  { id: 'fly.up', mode: 'fly', group: 'Free fly', label: 'Up', keys: ['KeyE'], anyModifiers: true },
  { id: 'fly.down', mode: 'fly', group: 'Free fly', label: 'Down', keys: ['KeyQ'], anyModifiers: true },
  // Space as well as Shift: a Shift+RMB release pops Firefox's native context menu with no
  // cancellable event, so boosted flight there must not depend on Shift.
  { id: 'fly.boost', mode: 'fly', group: 'Free fly', label: 'Boost', keys: ['Shift', 'Space'], match: 'logical', anyModifiers: true, hint: 'hold; the wheel sets the base speed' },
  { id: 'fly.exit', mode: 'fly', group: 'Free fly', label: 'Stop flying', keys: ['Escape'], fixed: true },

  // --- pilot ---------------------------------------------------------------
  { id: 'pilot.forward', mode: 'pilot', group: 'Pilot mode', label: 'Walk forward', keys: ['KeyW'], anyModifiers: true },
  { id: 'pilot.back', mode: 'pilot', group: 'Pilot mode', label: 'Walk back', keys: ['KeyS'], anyModifiers: true },
  { id: 'pilot.left', mode: 'pilot', group: 'Pilot mode', label: 'Strafe left', keys: ['KeyA'], anyModifiers: true },
  { id: 'pilot.right', mode: 'pilot', group: 'Pilot mode', label: 'Strafe right', keys: ['KeyD'], anyModifiers: true },
  { id: 'pilot.interact', mode: 'pilot', group: 'Pilot mode', label: 'Use / pick up', keys: ['KeyE', 'KeyF'], anyModifiers: true },
  { id: 'pilot.exit', mode: 'pilot', group: 'Pilot mode', label: 'Leave pilot mode', keys: ['Escape', 'KeyP'] },
] as const satisfies readonly KeyBinding[]

export type KeyActionId = (typeof KEY_BINDINGS)[number]['id']

/** the table as plain `KeyBinding`s. `KEY_BINDINGS` keeps its literal types (that's what derives
 *  `KeyActionId`, so a typo in a handler is a build error). Everything that reads the table wants
 *  the widened view: the narrow one has no `fixed` property on the entries that omit it. */
export const DEFAULT_KEYMAP: readonly KeyBinding[] = KEY_BINDINGS

/** the groups in the order the shortcuts panel should show them */
export const KEY_GROUPS = ['File', 'Tools', 'Edit', 'Snapping', 'View', 'Simulation', 'Ladder', 'Free fly', 'Pilot mode', 'Help'] as const

// ---------------------------------------------------------------------------
// display text
//
// The table's labels, hints and group names are the English source. Each gets a message id derived from the binding
// id (`keymap.<id>.label`), like commands.ts does for command labels, so rewording English never orphans a
// translation. Read through keyLabel / keyHintText / keyGroupLabel while rendering, never at module scope: a locale
// installs at boot, after modules load.
const LABEL_IDS = new Map<string, MessageId>(DEFAULT_KEYMAP.map((b) => [b.id, defineMessage(`keymap.${b.id}.label`, b.label)]))
const HINT_IDS = new Map<string, MessageId>(
  DEFAULT_KEYMAP.flatMap((b) => (b.hint ? [[b.id, defineMessage(`keymap.${b.id}.hint`, b.hint)] as const] : [])),
)
const GROUP_IDS = new Map<string, MessageId>(KEY_GROUPS.map((g) => [g, defineMessage(`keymap.group.${g}`, g)]))

/** a binding's label as the user's locale reads it */
export function keyLabel(b: Pick<KeyBinding, 'id' | 'label'>): string {
  const id = LABEL_IDS.get(b.id)
  return id ? t(id) : b.label
}

/** a binding's hint as the user's locale reads it, or undefined when it has none */
export function keyHintText(b: Pick<KeyBinding, 'id' | 'hint'>): string | undefined {
  const id = HINT_IDS.get(b.id)
  return id ? t(id) : b.hint
}

/** a group's heading as the user's locale reads it */
export function keyGroupLabel(group: string): string {
  const id = GROUP_IDS.get(group)
  return id ? t(id) : group
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

/** code → the `key` a US layout would report, for the logical comparison and the code-less
 *  fallback. Anything absent falls back to the lower-cased token, which is already correct for
 *  the named keys (Escape/Delete/PageDown/ArrowUp/F11…). Numpad* has no entry: with
 *  NumLock off those report 'Clear', which is exactly why they are matched physically. */
const CODE_TO_KEY: Record<string, string> = { Space: ' ', Period: '.', Comma: ',', Slash: '/', Minus: '-', Equal: '=', Backquote: '`' }
for (let i = 0; i < 26; i += 1) CODE_TO_KEY[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i)
for (let i = 0; i <= 9; i += 1) CODE_TO_KEY[`Digit${i}`] = String(i)

/** a chord whose token is itself a modifier (fly boost on Shift). Its own keydown sets the
 *  matching modifier flag, so the usual "modifiers must match exactly" rule can't apply. */
const MODIFIER_TOKENS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

interface ParsedChord {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  token: string
}

function parseChord(chord: string): ParsedChord {
  const parts = chord.split('+')
  const token = parts[parts.length - 1] ?? ''
  const mods = parts.slice(0, -1)
  return {
    ctrl: mods.includes('ctrl'),
    shift: mods.includes('shift'),
    alt: mods.includes('alt'),
    meta: mods.includes('meta'),
    token,
  }
}

/** the legend a token would carry on a US layout, lower-cased for comparison */
function logicalKeyOf(token: string): string {
  return CODE_TO_KEY[token] ?? token.toLowerCase()
}

/** does `e` press exactly this chord? */
export function matchesChord(
  chord: string,
  e: KeyEventLike,
  opts: { match?: KeyMatch; anyModifiers?: boolean } = {},
): boolean {
  const c = parseChord(chord)
  if (MODIFIER_TOKENS.has(c.token)) return e.key === c.token
  if (!opts.anyModifiers) {
    // 'ctrl' means the platform command modifier (Ctrl or Cmd). 'meta' means Cmd specifically, for
    // the macOS-only chords.
    if (c.meta) {
      if (!e.metaKey || e.ctrlKey) return false
    } else if (c.ctrl) {
      if (!e.ctrlKey && !e.metaKey) return false
    } else if (e.ctrlKey || e.metaKey) {
      return false
    }
    if (c.shift !== e.shiftKey || c.alt !== e.altKey) return false
  }
  // Alt changes the legend a key reports: Option+F on macOS is 'ƒ', and AltGr types a third character elsewhere.
  // So an Alt chord is matched by position, whichever way its binding matches.
  if (((opts.match ?? 'physical') === 'physical' || c.alt) && e.code) return e.code === c.token
  return e.key.toLowerCase() === logicalKeyOf(c.token)
}

/**
 * Which action does this press invoke in this mode? Null if none - the caller keeps whatever
 * modal handling it had (an in-flight drag, a focused text field) around this call.
 */
export function resolveKeyAction(
  e: KeyEventLike,
  mode: KeyMode,
  keymap: readonly KeyBinding[] = activeKeymap(),
): KeyActionId | null {
  for (const b of keymap) {
    if (b.mode !== mode || b.fixed) continue
    for (const chord of b.keys) {
      if (matchesChord(chord, e, b)) return b.id as KeyActionId
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// the keys a focused control keeps
// ---------------------------------------------------------------------------

/** the part of a focused element the ownership rule reads. A DOM element satisfies it structurally. */
export interface KeyTargetLike {
  readonly tagName: string
  readonly type?: string
  readonly isContentEditable?: boolean
}

/** input types that take typed text, so every key belongs to them */
const TEXT_INPUT = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week'])
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

/**
 * Does this key belong to the control it was pressed on, rather than to an app shortcut? Text entry owns every key.
 * A checkbox, slider, select or button owns only the keys it uses itself: the browser leaves focus on a control
 * after a click, so treating every INPUT and SELECT as text made each shortcut (Ctrl+Z, Delete, W) dead after
 * clicking an Inspector checkbox, until the viewport was clicked. Every listener asks this one rule: the editor's
 * (editor/dialogHost.ts `keyBelongsToTarget`, which adds the regions that own all their keys) and free fly's.
 */
export function keyBelongsToControl(
  e: Pick<KeyEventLike, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  t: KeyTargetLike,
  opts: { spaceOnButton?: boolean } = {},
): boolean {
  if (t.isContentEditable || t.tagName === 'TEXTAREA') return true
  const chord = e.ctrlKey || e.metaKey || e.altKey
  if (t.tagName === 'INPUT') {
    const type = t.type ?? ''
    if (TEXT_INPUT.has(type)) return true
    if (chord) return false
    if (type === 'range') return ARROWS.has(e.key)
    if (type === 'radio') return e.key === ' ' || ARROWS.has(e.key)
    // checkbox, color, file and the button types: Space toggles or presses, Enter presses
    return e.key === ' ' || e.key === 'Enter'
  }
  // a select also jumps to an option by typed letter, so it keeps every unmodified key
  if (t.tagName === 'SELECT') return !chord
  // `spaceOnButton: false` leaves Space on a focused button to the caller (the transport plays and pauses over the
  // button a click left focused); Enter still presses it
  if (t.tagName === 'BUTTON') return !chord && ((e.key === ' ' && opts.spaceOnButton !== false) || e.key === 'Enter')
  return false
}

// ---------------------------------------------------------------------------
// overrides (the rebinding seam) + display
// ---------------------------------------------------------------------------

/** action id → the chords that should replace its defaults */
export type KeymapOverrides = Readonly<Record<string, readonly string[]>>

/**
 * The keymap a listener should resolve against. With no overrides this is the default table. A
 * settings UI passes a persisted override map here and nothing else in the app changes.
 * `fixed` bindings ignore overrides: Escape has to keep meaning "back out".
 */
export function resolveKeymap(overrides?: KeymapOverrides): readonly KeyBinding[] {
  if (!overrides) return DEFAULT_KEYMAP
  return DEFAULT_KEYMAP.map((b) => {
    const keys = overrides[b.id]
    return keys && !b.fixed ? { ...b, keys } : b
  })
}

/**
 * The active keymap: the resolved table every listener and every chord-display site reads.
 *
 * Module state, on purpose. `resolveKeymap` alone produces a table, but the six listeners that resolve
 * a press (editor controller, freelook, pilot, the palette/menu chord labels) live in three different
 * layers. `render/` cannot import `editor/`, so core is the only place a rebinding can become visible
 * to all of them at once. Same shape as core/parts/partRegistry and core/parts/partDiagnostics: a process-wide
 * table with a revision and subscribers, no DOM, no store.
 *
 * Persistence is not here. core is DOM-free, so localStorage is handled in editor/keymapPrefs.ts,
 * which calls in at boot. This module only knows what the bindings currently are.
 */
let overrideMap: KeymapOverrides | null = null
let resolved: readonly KeyBinding[] = DEFAULT_KEYMAP
let rev = 0
const keymapListeners = new Set<() => void>()

/** the table in force right now (=== DEFAULT_KEYMAP while nothing is overridden) */
export function activeKeymap(): readonly KeyBinding[] {
  return resolved
}

/** bumped on every change; a `useSyncExternalStore` snapshot for the panels that render chords */
export function keymapRev(): number {
  return rev
}

export function subscribeKeymap(cb: () => void): () => void {
  keymapListeners.add(cb)
  return () => keymapListeners.delete(cb)
}

/** Install (or clear, with null) the user's rebindings. Tests must reset this: it is process-wide. */
export function setKeymapOverrides(overrides: KeymapOverrides | null): void {
  // an empty map is "no overrides": it keeps `activeKeymap() === DEFAULT_KEYMAP` true, which is the
  // identity the display sites use to tell a default row from a customised one
  const empty = !overrides || Object.keys(overrides).length === 0
  overrideMap = empty ? null : overrides
  resolved = empty ? DEFAULT_KEYMAP : resolveKeymap(overrides)
  rev += 1
  for (const cb of keymapListeners) cb()
}

/** the binding for an action in the active table (what a menu or palette should print) */
export function activeBinding(id: string): KeyBinding | undefined {
  return resolved.find((b) => b.id === id)
}

/** has this action been rebound away from its default? */
export function isRebound(id: string): boolean {
  return overrideMap !== null && overrideMap[id] !== undefined
}

/**
 * The chord a press would be recorded as, for the "press a key" capture in a rebinding UI. It is the
 * inverse of `matchesChord`, which works because the token is always the physical
 * `e.code`, whichever way the binding matches (a logical binding maps its token back to a legend at
 * compare time, see `logicalKeyOf`). Returns null for a press that cannot be a chord on its own: a
 * bare modifier, or a key with no `code` (a synthetic event).
 *
 * `ctrl` is emitted for Ctrl or Cmd, matching how every chord in the table is written and how
 * `matchesChord` reads them. A Mac user recording ⌘Z gets `ctrl+KeyZ`, the same binding a Windows
 * user records.
 */
export function chordFromEvent(e: KeyEventLike): string | null {
  const code = e.code
  if (!code || MODIFIER_TOKENS.has(code) || /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code)) return null
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  return [...mods, code].join('+')
}

/**
 * Would binding `chord` to `id` collide? Returns the colliding action's id, or null.
 *
 * Scoped to the binding's own mode, because that is the only place a collision is real: W is both
 * the Move tool and fly-forward, and those modes are never live at once (see KeyMode).
 */
export function chordConflict(keymap: readonly KeyBinding[], id: string, chord: string): string | null {
  const self = keymap.find((b) => b.id === id)
  if (!self) return null
  for (const b of keymap) {
    if (b.id === id || b.mode !== self.mode) continue
    if (b.keys.includes(chord)) return b.id
  }
  return null
}

/** chords in one mode that fire on the same press - what a rebinding UI would have to refuse */
export function findKeymapConflicts(keymap: readonly KeyBinding[] = DEFAULT_KEYMAP): string[] {
  const seen = new Map<string, string>()
  const clashes: string[] = []
  for (const b of keymap) {
    for (const chord of b.keys) {
      // a physical and a logical binding on the same token collide only if both resolve the same
      // press; key it by mode+chord, which is what a US-layout user actually experiences
      const key = `${b.mode}:${chord}`
      const prev = seen.get(key)
      if (prev) clashes.push(`${key} - ${prev} and ${b.id}`)
      else seen.set(key, b.id)
    }
  }
  return clashes
}

const TOKEN_LABEL: Record<string, string> = {
  Space: 'Space',
  Period: '.',
  Comma: ',',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  Escape: 'Esc',
  Delete: 'Del',
  PageDown: 'Page Down',
  PageUp: 'Page Up',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Numpad1: 'Numpad 1',
  Numpad3: 'Numpad 3',
  Numpad5: 'Numpad 5',
  Numpad7: 'Numpad 7',
}

/** the chord as a human reads it: `ctrl+shift+KeyZ` → `Ctrl+Shift+Z` (`⌘⇧Z` on a Mac) */
export function formatChord(chord: string, mac = false): string {
  const c = parseChord(chord)
  const out: string[] = []
  if (c.ctrl) out.push(mac ? '⌘' : 'Ctrl')
  if (c.meta) out.push(mac ? '⌘' : 'Meta')
  if (c.alt) out.push(mac ? '⌥' : 'Alt')
  if (c.shift) out.push(mac ? '⇧' : 'Shift')
  out.push(TOKEN_LABEL[c.token] ?? c.token.replace(/^(Key|Digit)/, ''))
  return out.join(mac ? '' : '+')
}

/**
 * Whether a binding answers the shortcuts panel's search. Every word of the query must appear,
 * in any order, in the label, the hint, the group (as shown, or in English) or a chord as the panel prints it, so "ctrl+z",
 * "snap" and "fly w" all find their rows. Case-insensitive; an empty query matches everything.
 */
export function bindingMatches(b: KeyBinding, query: string, mac = false): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  // the text the panel shows, and the English source too, so a name read in either finds the row
  const shown = [keyLabel(b), keyHintText(b) ?? '', keyGroupLabel(b.group)]
  const text = [...shown, b.label, b.hint ?? '', b.group, ...b.keys.map((c) => formatChord(c, mac))].join('\n').toLowerCase()
  return words.every((w) => text.includes(w))
}
