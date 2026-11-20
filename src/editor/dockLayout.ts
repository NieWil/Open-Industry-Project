// Dockable panels for the desktop editor: the Scene tree, Inspector
// and Parts catalog can be moved between dock slots and stacked as tabs when they
// share one. Each side (Left / Right) has two vertical columns, and each column is
// split horizontally into a Top and Bottom sub-slot - the full set gives eight dock
// corners (LEFT_UL/BL/UR/BR + RIGHT_UL/BL/UR/BR).
// The primary column (`leftTop`/`leftBottom`) sits at the screen
// edge; the secondary `*2` column sits between it and the viewport. Empty columns
// collapse. The arrangement persists in localStorage so a user's layout survives reloads.
//
// On top of that, any one panel can be maximized to fill everything under the toolbar
// (`maximized`). See the field's comment for
// why it is orthogonal to where the panel is docked.

import { defineMessages, t } from '../core/i18n'

export type DockPanelId = 'tree' | 'inspector' | 'catalog' | 'st' | 'history' | 'problems' | 'watch'
export type DockSlotId =
  | 'leftTop'
  | 'leftBottom'
  | 'leftTop2'
  | 'leftBottom2'
  | 'rightTop'
  | 'rightBottom'
  | 'rightTop2'
  | 'rightBottom2'
  | 'bottom'
export type DockSide = 'left' | 'right'
/** A side column, named by its width key in DockSizes: `left`/`right` sit at the screen edge, `*2` beside the viewport. */
export type DockColumnId = 'left' | 'left2' | 'right' | 'right2'
/** the Top and Bottom sub-slots that make up each side column */
export const COLUMN_SLOTS: Record<DockColumnId, readonly [DockSlotId, DockSlotId]> = {
  left: ['leftTop', 'leftBottom'],
  left2: ['leftTop2', 'leftBottom2'],
  right: ['rightTop', 'rightBottom'],
  right2: ['rightTop2', 'rightBottom2'],
}
const COLUMN_IDS: DockColumnId[] = ['left', 'left2', 'right', 'right2']
/**
 * Where a panel lives: a dock slot, a floating window drawn inside the page, or 'popout' - a
 * real OS window of its own (see components/PopoutWindow), which is the only location that can
 * sit on a second monitor.
 *
 * Popout is a promotion of floating, not a parallel mechanism: same `detach` path, same shape of
 * policy list, and the panel renders in its full-bleed `docked` form once it owns a window. The
 * panel still runs in this document's React tree and JS context (it is portaled into the popup),
 * so it keeps the one store, the one controller and the one sim. That is why this
 * is a portal and not a second app instance.
 */
export type DockLocation = DockSlotId | 'floating' | 'popout'

/** every movable panel */
export const ALL_PANELS: DockPanelId[] = ['tree', 'inspector', 'catalog', 'st', 'history', 'problems', 'watch']

/** panels that can be detached into a floating window (only the PLC editor) */
export const FLOATABLE_PANELS: DockPanelId[] = ['st']

/**
 * Panels offered "Pop out" - a window of their own, draggable to another display.
 *
 * Same list as FLOATABLE_PANELS, and for the same reason: the mechanism is general (any panel id
 * works), but the panel actually starved of room next to a live viewport is the PLC editor, and
 * its job - watch the program while watching the machine - is the job a second monitor exists to
 * do. Another panel is added as one more entry when it needs this.
 *
 * Not the viewport: a WebGL/WebGPU context is bound to its canvas and its document, so the 3D
 * view can never be portaled into another window. Panels move; the machine stays.
 */
export const POPOUT_PANELS: DockPanelId[] = ['st']

/**
 * Panels offered a ⛶. The mechanism below is general - `maximized` holds any panel id - but
 * the policy is one entry, because maximize only helps where a panel is starved of room:
 *
 *   - a side-docked panel already has the full height of the window; maximizing adds only
 *     width, and neither the Scene tree nor the Inspector (a narrow field stack) uses width,
 *   - the Parts catalog is a wrapping grid sized for the short/wide bottom dock - full screen
 *     is one row of cards over a lot of nothing.
 *
 * That leaves the small floating window and the short bottom dock, and the panel that lives in
 * both is the PLC editor. An affordance that renders a bad layout teaches people not to
 * trust the button, so this stays a list of one until another panel's layout can use the space,
 * and then it is one more entry.
 */
export const MAXIMIZABLE_PANELS: DockPanelId[] = ['st']

/**
 * Each panel's tab label in English: the message sources, and what app/index.html's boot skeleton copies
 * (bootSkeleton.test.ts). Shown through {@link dockPanelTitle}.
 */
export const DOCK_PANEL_TITLES: Record<DockPanelId, string> = {
  tree: 'Scene',
  inspector: 'Inspector',
  catalog: 'Parts',
  st: 'PLC',
  history: 'History',
  problems: 'Problems',
  watch: 'Watch',
}

// The ids are `dock.panel.<panel>`: the boot skeleton's inline script finds the cached translations by that prefix.
const PANEL_TITLE = defineMessages('dock.panel', DOCK_PANEL_TITLES)

/** The tab label shown for a panel, in the editor's language. */
export function dockPanelTitle(panel: DockPanelId): string {
  return t(PANEL_TITLE[panel])
}

export const SLOT_ORDER: DockSlotId[] = [
  'leftTop',
  'leftBottom',
  'leftTop2',
  'leftBottom2',
  'rightTop',
  'rightBottom',
  'rightTop2',
  'rightBottom2',
  'bottom',
]
export const SLOT_LABELS: Record<DockSlotId, string> = {
  leftTop: 'Left, top',
  leftBottom: 'Left, bottom',
  leftTop2: 'Left 2, top',
  leftBottom2: 'Left 2, bottom',
  rightTop: 'Right, top',
  rightBottom: 'Right, bottom',
  rightTop2: 'Right 2, top',
  rightBottom2: 'Right 2, bottom',
  bottom: 'Bottom',
}

/**
 * Where each panel goes when nothing has been moved yet: History as a background tab behind the
 * Scene tree, and the PLC editor, Problems and Watch behind Parts.
 *
 * The bottom strip reads in the order the work goes: place parts, write the program, check the result.
 * Problems comes after the program because it checks the whole twin, wiring and parts as well as the program.
 * Watch is last: it is for the running line. A stored layout that predates it gets it after Problems too
 * (`normalizeDockLayout` restores a missing panel at its place in the default order).
 *
 * The PLC editor is docked, not floating: a floating window over the viewport hides much of it on a
 * laptop screen and sits in the path of a catalog drag. Docked, it shares a strip with the Problems
 * panel it links to, and ⛶ / ⧉ give it more room.
 *
 * Never 'popout', and the type says so: opening a window takes a user gesture, so a panel whose
 * default was a window would have nowhere to render on a fresh load.
 */
const DEFAULT_LOCATION: Record<DockPanelId, DockSlotId | 'floating'> = {
  tree: 'leftTop',
  inspector: 'rightTop',
  catalog: 'bottom',
  st: 'bottom',
  history: 'leftTop',
  problems: 'bottom',
  watch: 'bottom',
}

export type DockLayout = Record<DockSlotId, DockPanelId[]> & {
  /** panels detached into floating windows (not in any slot) */
  floating: DockPanelId[]
  /**
   * Panels living in their own OS window (not in any slot, not floating in-page).
   *
   * Not persisted - see `saveDockLayout` / `normalizeDockLayout`. Opening a popup
   * requires a user gesture, so a layout that remembered "popped out" would reload into a panel
   * that exists in the arrangement but nowhere on screen. It falls back to its default location
   * instead, exactly like `maximized` falls back to null.
   */
  popout: DockPanelId[]
  /** the active (front) tab per slot; null when the slot is empty */
  active: Record<DockSlotId, DockPanelId | null>
  /** The bottom dock is rolled up to just its tab strip (see `clickBottomDockTab`). */
  bottomCollapsed: boolean
  /**
   * Side columns folded to a rail of vertical tabs (see `clickSideDockTab`). A column folds whole,
   * both sub-slots together, because the width is what it gives back. Never holds an empty column.
   */
  collapsedColumns: DockColumnId[]
  /**
   * The one panel blown up to fill everything under the toolbar, or null.
   *
   * Orthogonal to where the panel lives: a floating PLC editor maximizes
   * exactly like a docked one, and restoring puts it back where it was, so neither form has
   * to be converted into the other first. `buildDockGrid` collapses the shell to one
   * full-bleed cell for it.
   *
   * Not a viewport replacement: the 3D canvas stays mounted and rendering underneath
   * (App hides it with `visibility`, never unmounts it), because tearing down a live
   * WebGL/WebGPU context - one whose render bundles have baked resource handles - is not
   * something a UI toggle should do. One keypress/click brings the machine back.
   */
  maximized: DockPanelId | null
}

const LAYOUT_KEY = 'oip-web/dock-layout'

/**
 * Stamped on the stored blob. Bump it when a default changes in a way stored layouts should pick
 * up, and teach `migrateDockLayout` the step - App writes the layout on mount, so a stored blob
 * holds the defaults of the day it was first written, not only what someone arranged.
 *
 *   1 (unstamped) - the PLC editor floats by default
 *   2 - the PLC editor docks behind Parts
 *   3 - the bottom strip is Parts, PLC, Controller, Problems (was Parts, PLC, Problems, Controller)
 *
 * There is no Controller dock (its tasks are the PLC panel's organizer, its link settings Controller
 * Properties), and dropping it needs no step: `normalizeDockLayout` drops an id it does not know from any blob,
 * and a slot's front tab falls back to one it still holds. A stored v3 default strip reads as today's default.
 */
const LAYOUT_VERSION = 3

/**
 * Bottom strips that older builds wrote as their untouched default. A stored strip still equal to
 * one of these was never arranged, so the 2 -> 3 step can put it in today's order.
 */
// (strings, not DockPanelId: they name the Controller dock, which is not a panel)
const PAST_BOTTOM_DEFAULTS: readonly (readonly string[])[] = [
  ['catalog', 'problems', 'controller'], // v1, where the PLC editor floated
  ['catalog', 'st', 'problems', 'controller'], // v2
]

export function defaultDockLayout(): DockLayout {
  return {
    leftTop: ['tree', 'history'],
    leftBottom: [],
    leftTop2: [],
    leftBottom2: [],
    rightTop: ['inspector'],
    rightBottom: [],
    rightTop2: [],
    rightBottom2: [],
    bottom: ['catalog', 'st', 'problems', 'watch'],
    floating: [],
    popout: [],
    active: {
      leftTop: 'tree',
      leftBottom: null,
      leftTop2: null,
      leftBottom2: null,
      rightTop: 'inspector',
      rightBottom: null,
      rightTop2: null,
      rightBottom2: null,
      bottom: 'catalog',
    },
    bottomCollapsed: false,
    collapsedColumns: [],
    maximized: null,
  }
}

/** the side column a slot belongs to, or null for the bottom dock */
export function columnOf(slot: DockSlotId): DockColumnId | null {
  return COLUMN_IDS.find((c) => COLUMN_SLOTS[c].includes(slot)) ?? null
}

function columnOccupied(layout: Record<DockSlotId, DockPanelId[]>, column: DockColumnId): boolean {
  const [top, bottom] = COLUMN_SLOTS[column]
  return layout[top].length > 0 || layout[bottom].length > 0
}

export function isColumnCollapsed(layout: DockLayout, column: DockColumnId): boolean {
  return layout.collapsedColumns.includes(column)
}

/** whether the slot is folded away: a rolled-up bottom dock, or a slot in a folded side column */
function slotCollapsed(layout: DockLayout, slot: DockSlotId): boolean {
  const column = columnOf(slot)
  return column ? isColumnCollapsed(layout, column) : layout.bottomCollapsed
}

/** the same layout with `slot` unfolded (its side column or the bottom dock) */
function withSlotOpen(layout: DockLayout, slot: DockSlotId): DockLayout {
  if (!slotCollapsed(layout, slot)) return layout
  const column = columnOf(slot)
  return column
    ? { ...layout, collapsedColumns: layout.collapsedColumns.filter((c) => c !== column) }
    : { ...layout, bottomCollapsed: false }
}

/**
 * Coerce any (possibly stale or hand-edited) value into a valid layout: every
 * panel appears exactly once, unknown ids are dropped, missing panels are
 * restored to their default slot, and each slot's active tab is one it holds.
 */
export function normalizeDockLayout(raw: unknown): DockLayout {
  const seen = new Set<DockPanelId>()
  const slots = {
    leftTop: [],
    leftBottom: [],
    leftTop2: [],
    leftBottom2: [],
    rightTop: [],
    rightBottom: [],
    rightTop2: [],
    rightBottom2: [],
    bottom: [],
  } as Record<DockSlotId, DockPanelId[]>
  const input = (raw ?? {}) as Partial<Record<DockSlotId, unknown>> & {
    active?: unknown
    bottomCollapsed?: unknown
    collapsedColumns?: unknown
  }

  for (const slot of SLOT_ORDER) {
    const list = Array.isArray(input[slot]) ? (input[slot] as unknown[]) : []
    for (const id of list) {
      if (ALL_PANELS.includes(id as DockPanelId) && !seen.has(id as DockPanelId)) {
        seen.add(id as DockPanelId)
        slots[slot].push(id as DockPanelId)
      }
    }
  }
  // Read against what the blob held, before the restore loop below back-fills missing
  // panels: an empty bottom dock is never "collapsed" (detach clears the flag), so a
  // blob claiming otherwise must not roll up a panel that restoration puts there.
  const bottomCollapsed = input.bottomCollapsed === true && slots.bottom.length > 0
  // the same rule for the side columns
  const rawColumns = Array.isArray(input.collapsedColumns) ? (input.collapsedColumns as unknown[]) : []
  const collapsedColumns = COLUMN_IDS.filter((c) => rawColumns.includes(c) && columnOccupied(slots, c))

  // floating panels (detached windows): honored only for those that can float
  const floating: DockPanelId[] = []
  const rawFloating = Array.isArray((input as { floating?: unknown }).floating)
    ? ((input as { floating?: unknown }).floating as unknown[])
    : []
  for (const id of rawFloating) {
    if (FLOATABLE_PANELS.includes(id as DockPanelId) && !seen.has(id as DockPanelId)) {
      seen.add(id as DockPanelId)
      floating.push(id as DockPanelId)
    }
  }
  // restore any panel that went missing (new panel added, a migrated or corrupt blob) beside its
  // nearest default neighbour still in the slot - after the closest one it follows by default, else
  // before the closest one it precedes - so it ends up where a fresh layout has it, inside whatever
  // order the user kept
  const defaults = defaultDockLayout()
  for (const id of ALL_PANELS) {
    if (seen.has(id)) continue
    const home = DEFAULT_LOCATION[id]
    if (home === 'floating') {
      floating.push(id)
      continue
    }
    const order = defaults[home]
    const at = order.indexOf(id)
    const slot = slots[home]
    const prev = at < 0 ? undefined : order.slice(0, at).reverse().find((p) => slot.includes(p))
    const next = at < 0 ? undefined : order.slice(at + 1).find((p) => slot.includes(p))
    if (prev) slot.splice(slot.indexOf(prev) + 1, 0, id)
    else if (next) slot.splice(slot.indexOf(next), 0, id)
    else slot.push(id)
  }

  const rawActive = (input.active ?? {}) as Partial<Record<DockSlotId, unknown>>
  const active: Record<DockSlotId, DockPanelId | null> = {
    leftTop: null,
    leftBottom: null,
    leftTop2: null,
    leftBottom2: null,
    rightTop: null,
    rightBottom: null,
    rightTop2: null,
    rightBottom2: null,
    bottom: null,
  }
  for (const slot of SLOT_ORDER) {
    const want = rawActive[slot] as DockPanelId | undefined
    active[slot] = want && slots[slot].includes(want) ? want : (slots[slot][0] ?? null)
  }
  // `maximized` is intentionally not restored from the blob. It's a transient "give me
  // room for a minute" state, not an arrangement: a session that ends maximized and
  // reloads into a shell with no 3D viewport reads as a broken editor, not as a
  // remembered preference. Everything else here survives a reload; this doesn't.
  // `popout` joins `maximized` in not being restored: a popped-out panel is a window, and a
  // window can only be opened from a user gesture. Honouring the flag on load would leave the
  // panel owned by a popup that was never allowed to open - present in the layout, absent from
  // the screen. The restore loop above has already put it back at its default location.
  return { ...slots, floating, popout: [], active, bottomCollapsed, collapsedColumns, maximized: null }
}

/**
 * Bring a stored blob up to LAYOUT_VERSION before `normalizeDockLayout` reads it. Separate from
 * normalize: normalize coerces shape and also reads layouts that never touched storage,
 * while this only knows what older defaults left behind.
 *
 * 1 -> 2: drop the PLC editor's floating claim, so it goes to its docked default. Every v1 browser
 * stored `floating: ['st']` on its first load whether or not anyone chose it, so the claim says
 * nothing about intent. A panel someone floats from here on is written into a v2 blob and kept.
 *
 * 2 -> 3: put an untouched bottom strip (one of PAST_BOTTOM_DEFAULTS) in today's order. normalize keeps
 * the order a blob holds, so without this step the new order would only reach fresh browsers. A strip
 * in any other order was arranged by someone and is kept.
 */
export function migrateDockLayout(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  let blob = raw as { version?: unknown; floating?: unknown; bottom?: unknown }
  const version = typeof blob.version === 'number' ? blob.version : 1
  if (version < 2 && Array.isArray(blob.floating)) {
    blob = { ...blob, floating: blob.floating.filter((id) => id !== 'st') }
  }
  const bottom = blob.bottom
  if (version < 3 && Array.isArray(bottom) && PAST_BOTTOM_DEFAULTS.some((d) => sameOrder(d, bottom))) {
    blob = { ...blob, bottom: defaultDockLayout().bottom.filter((id) => bottom.includes(id)) }
  }
  return blob
}

function sameOrder(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function readDockLayout(): DockLayout {
  if (typeof localStorage === 'undefined') return defaultDockLayout()
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    return raw ? normalizeDockLayout(migrateDockLayout(JSON.parse(raw))) : defaultDockLayout()
  } catch {
    return defaultDockLayout()
  }
}

export function saveDockLayout(layout: DockLayout): void {
  if (typeof localStorage === 'undefined') return
  try {
    // The stored blob describes the arrangement, so `maximized` and `popout` are stripped
    // rather than written and ignored later: normalizeDockLayout drops them on read too, but a
    // key that exists in storage and is silently discarded is the kind of thing someone "fixes"
    // into a bug. Only one of each pair is needed; writing both is intended.
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...layout, maximized: null, popout: [], version: LAYOUT_VERSION }))
  } catch {
    // best-effort UI preference
  }
}

/** where a panel currently lives (a slot, 'floating', or 'popout') */
export function locate(layout: DockLayout, panel: DockPanelId): DockLocation {
  for (const slot of SLOT_ORDER) {
    if (layout[slot].includes(panel)) return slot
  }
  if (layout.floating.includes(panel)) return 'floating'
  if (layout.popout.includes(panel)) return 'popout'
  return DEFAULT_LOCATION[panel]
}

export function isFloating(layout: DockLayout, panel: DockPanelId): boolean {
  return layout.floating.includes(panel)
}

export function isPoppedOut(layout: DockLayout, panel: DockPanelId): boolean {
  return layout.popout.includes(panel)
}

function cloneLayout(layout: DockLayout): DockLayout {
  return {
    leftTop: [...layout.leftTop],
    leftBottom: [...layout.leftBottom],
    leftTop2: [...layout.leftTop2],
    leftBottom2: [...layout.leftBottom2],
    rightTop: [...layout.rightTop],
    rightBottom: [...layout.rightBottom],
    rightTop2: [...layout.rightTop2],
    rightBottom2: [...layout.rightBottom2],
    bottom: [...layout.bottom],
    floating: [...layout.floating],
    popout: [...layout.popout],
    active: { ...layout.active },
    bottomCollapsed: layout.bottomCollapsed,
    collapsedColumns: [...layout.collapsedColumns],
    maximized: layout.maximized,
  }
}

/** drop a panel from wherever it currently is (slot or floating) */
function detach(next: DockLayout, panel: DockPanelId): void {
  for (const slot of SLOT_ORDER) {
    if (next[slot].includes(panel)) {
      next[slot] = next[slot].filter((p) => p !== panel)
      if (next.active[slot] === panel) next.active[slot] = next[slot][0] ?? null
    }
  }
  next.floating = next.floating.filter((p) => p !== panel)
  next.popout = next.popout.filter((p) => p !== panel)
  // dragging the last panel out of a collapsed bottom dock removes the dock entirely;
  // clear the flag so the next panel docked there arrives open
  if (next.bottom.length === 0) next.bottomCollapsed = false
  next.collapsedColumns = next.collapsedColumns.filter((c) => columnOccupied(next, c))
}

/** docking a panel reveals it: unfold the slot it lands in */
function openSlot(next: DockLayout, slot: DockSlotId): void {
  if (slot === 'bottom') next.bottomCollapsed = false
  else next.collapsedColumns = next.collapsedColumns.filter((c) => c !== columnOf(slot))
}

/** Dock a panel into a slot (appended as the new front tab there). No-op if already there. */
export function moveDockPanel(layout: DockLayout, panel: DockPanelId, to: DockSlotId): DockLayout {
  if (locate(layout, panel) === to) return layout
  const next = cloneLayout(layout)
  detach(next, panel)
  next[to] = [...next[to], panel]
  next.active[to] = panel
  openSlot(next, to)
  return next
}

/**
 * Dock a panel into a slot immediately before `before` (a panel already in that slot),
 * or at the end when `before` is null. Used by tab drag-reordering - works the same for
 * same-slot reordering and cross-slot insertion. Positioning by panel id (not a raw
 * index) still finds the place after the detach that happens first. Becomes the new active tab.
 */
export function moveDockPanelBefore(
  layout: DockLayout,
  panel: DockPanelId,
  to: DockSlotId,
  before: DockPanelId | null,
): DockLayout {
  if (before === panel) return layout // inserting an item before itself is a no-op
  const next = cloneLayout(layout)
  detach(next, panel)
  const arr = next[to]
  const idx = before ? arr.indexOf(before) : -1
  if (idx === -1) arr.push(panel)
  else arr.splice(idx, 0, panel)
  next[to] = arr
  next.active[to] = panel
  openSlot(next, to)
  return next
}

/** Detach a panel into a floating window. No-op if already floating. */
export function floatDockPanel(layout: DockLayout, panel: DockPanelId): DockLayout {
  if (isFloating(layout, panel)) return layout
  const next = cloneLayout(layout)
  detach(next, panel)
  next.floating = [...next.floating, panel]
  return next
}

/**
 * Pop a panel out into a window of its own - the one arrangement that can cross monitors.
 *
 * Refuses a panel outside POPOUT_PANELS, so the policy lives here and not only in whichever bit
 * of UI happens to draw the button. Clears `maximized` when it is this panel: "fill the shell
 * below the toolbar" describes a region of the main window, and a panel that has left that window
 * cannot hold it - leaving the flag set would blank the viewport on behalf of a panel that is no
 * longer there to paint over it.
 */
export function popoutDockPanel(layout: DockLayout, panel: DockPanelId): DockLayout {
  if (!POPOUT_PANELS.includes(panel)) return layout
  if (isPoppedOut(layout, panel)) return layout
  const next = cloneLayout(layout)
  detach(next, panel)
  next.popout = [...next.popout, panel]
  if (next.maximized === panel) next.maximized = null
  return next
}

/**
 * Blow a panel up to fill everything under the toolbar, or restore it if it already is.
 * Only one panel can hold the screen, so this replaces any previous occupant rather than
 * stacking. Works from a dock slot or a floating window alike (see `maximized`), and is refused
 * for a popped-out panel, which owns a whole window already.
 *
 * Refuses a panel that isn't in MAXIMIZABLE_PANELS, so the rule lives here and not only in
 * whichever bit of UI happens to draw the button.
 */
export function toggleMaximizePanel(layout: DockLayout, panel: DockPanelId): DockLayout {
  if (!MAXIMIZABLE_PANELS.includes(panel)) return layout
  if (isPoppedOut(layout, panel)) return layout
  return { ...layout, maximized: layout.maximized === panel ? null : panel }
}

/** Restore whatever is maximized (the Esc / ⛶ path). No-op when nothing is. */
export function clearMaximized(layout: DockLayout): DockLayout {
  return layout.maximized === null ? layout : { ...layout, maximized: null }
}

/**
 * Make a panel visible: front tab of its slot, and its slot unfolded (the bottom dock or a side
 * column). `activateDockPanel` alone isn't enough - a front tab in a folded slot still renders
 * nothing (see DockSlot). This is what "show me this panel" means for code outside
 * the dock UI, e.g. the tutorial surfacing the PLC panel as it writes the program into it. A
 * floating panel is a window that's always up, so it needs nothing.
 */
export function revealDockPanel(layout: DockLayout, panel: DockPanelId): DockLayout {
  // A different panel holding the whole screen hides every dock and the floating windows
  // with them, so revealing anything else has to restore it first. Otherwise "show me the
  // Parts catalog" quietly succeeds behind a full-bleed PLC editor. If the panel being revealed
  // is the maximized one, it is already as visible as it gets, with nothing to bring forward.
  if (layout.maximized === panel) return layout
  const base = clearMaximized(layout)
  const loc = locate(base, panel)
  // a floating window is always up, and a popped-out one is a window the OS owns - neither has a
  // tab to bring forward. (Raising the popup is PopoutWindow's job, not the layout's.)
  if (loc === 'floating' || loc === 'popout') return base
  const open = withSlotOpen(base, loc)
  if (open.active[loc] === panel) return open
  return { ...open, active: { ...open.active, [loc]: panel } }
}

/**
 * Whether revealing `panel` puts it in a dock slot: the question App asks before a reveal while
 * distraction-free is on. Df drops the slots and nothing else: the maximized panel, a floating
 * window and a popped-out window all stay up. So a reveal into a slot has to leave df, or
 * it quietly succeeds behind a hidden dock - the failure revealDockPanel already refuses for a
 * maximized panel. It is a separate question because df is store state the layout cannot see.
 */
export function revealNeedsDocks(layout: DockLayout, panel: DockPanelId): boolean {
  if (layout.maximized === panel) return false
  const loc = locate(layout, panel)
  return loc !== 'floating' && loc !== 'popout'
}

/** Whether `panel` is the open front tab of a slot: not behind another tab, not in a folded slot. */
export function tabShowsPanel(layout: DockLayout, panel: DockPanelId): boolean {
  const loc = locate(layout, panel)
  if (loc === 'floating' || loc === 'popout' || layout.active[loc] !== panel) return false
  return !slotCollapsed(layout, loc)
}

/** Bring a tab to the front of its slot. No-op for a floating or popped-out panel. */
export function activateDockPanel(layout: DockLayout, panel: DockPanelId): DockLayout {
  const loc = locate(layout, panel)
  if (loc === 'floating' || loc === 'popout' || layout.active[loc] === panel) return layout
  return { ...layout, active: { ...layout.active, [loc]: panel } }
}

/**
 * What a left-click on a tab does: in the bottom dock, clicking the
 * tab that is already at the front rolls the dock up to just its tab strip, and
 * clicking any tab while it's rolled up opens it again (switching tabs on the way
 * if needed). Any other tab falls through to `activateDockPanel`.
 *
 * Separate from `activateDockPanel`: the right-click path activates a
 * tab before opening its move menu, and must never collapse the dock underneath it.
 */
export function clickBottomDockTab(layout: DockLayout, panel: DockPanelId): DockLayout {
  if (locate(layout, panel) !== 'bottom') return activateDockPanel(layout, panel)
  if (layout.bottomCollapsed) {
    return { ...layout, bottomCollapsed: false, active: { ...layout.active, bottom: panel } }
  }
  if (layout.active.bottom === panel) return { ...layout, bottomCollapsed: true }
  return { ...layout, active: { ...layout.active, bottom: panel } }
}

/**
 * The side-dock twin of `clickBottomDockTab`: clicking the front tab of either sub-slot folds the
 * whole column to a rail of vertical tabs, and clicking any tab on the rail opens the column at the
 * width it had, with that tab in front. Anything that is not a side tab falls through to
 * `activateDockPanel`.
 */
export function clickSideDockTab(layout: DockLayout, panel: DockPanelId): DockLayout {
  const loc = locate(layout, panel)
  if (loc === 'floating' || loc === 'popout') return activateDockPanel(layout, panel)
  const column = columnOf(loc)
  if (!column) return activateDockPanel(layout, panel)
  if (isColumnCollapsed(layout, column)) {
    return {
      ...layout,
      collapsedColumns: layout.collapsedColumns.filter((c) => c !== column),
      active: { ...layout.active, [loc]: panel },
    }
  }
  if (layout.active[loc] === panel) return { ...layout, collapsedColumns: [...layout.collapsedColumns, column] }
  return { ...layout, active: { ...layout.active, [loc]: panel } }
}

/** What a left-click on any dock tab does: the bottom dock's roll-up, or a side column's fold. */
export function clickDockTab(layout: DockLayout, panel: DockPanelId): DockLayout {
  return locate(layout, panel) === 'bottom' ? clickBottomDockTab(layout, panel) : clickSideDockTab(layout, panel)
}

export interface DockSizes {
  /** primary (edge) left/right column widths */
  left: number
  right: number
  /** secondary (inner) left/right column widths */
  left2: number
  right2: number
  /** bottom dock height, as a CSS length: the front panel's own (see `bottomDockHeight`), which may be a share of the shell */
  dock: string
}

/**
 * How tall the bottom dock stands, per panel: the height belongs to the tab in front, not to the slot, the way
 * JetBrains' tool windows each keep their own size. The panels sharing the strip are different shapes. Parts is one row
 * of cards and Problems a short list, which a short strip suits; the PLC editor is hundreds of short lines (the demo's:
 * median 21 characters, 90% under 70), and a strip sized for a row of cards showed six of them, on a 1080p screen as on
 * a laptop, beside 1100px of unused width. So each panel keeps the height it was last dragged to.
 */
export type BottomHeights = Partial<Record<DockPanelId, number>>

/** the bottom dock's drag range: never shorter than this, never more than this share of the shell below the toolbar */
export const BOTTOM_MIN = 96
export const BOTTOM_MAX_SHARE = 0.8

/** the toolbar row, the one track above the docks (`buildDockGrid`) */
const TOOLBAR_ROW = 48

/**
 * Where a panel that has never been dragged stands in the bottom dock: px, or a share of the shell below the toolbar.
 *
 * The PLC editor's is a share so a bigger screen shows more program, not only more viewport (13 lines at 1366x768,
 * 20 at 1920x1080). Parts' is one row of cards: 31px of tab strip, the 42px header and a 124px card row, measured at
 * 1366 and 1920, plus 3px so a card's edge never clips. The tree, the Inspector and History only end up here when
 * someone moves them, and take a fixed 230px.
 */
export const DEFAULT_BOTTOM_HEIGHT: Record<DockPanelId, number | { share: number }> = {
  catalog: 200,
  st: { share: 0.45 },
  problems: 230,
  watch: 230,
  tree: 230,
  inspector: 230,
  history: 230,
}

/** The bottom dock's track for the panel in front, as a CSS length: its own height if it has one, else its default. */
export function bottomDockHeight(front: DockPanelId | null, heights: BottomHeights): string {
  const own = front ? heights[front] : undefined
  if (own !== undefined) return `${own}px`
  const d = DEFAULT_BOTTOM_HEIGHT[front ?? 'catalog']
  // a percentage in a grid track is of the grid container, which is the whole shell, toolbar row included
  return typeof d === 'number' ? `${d}px` : `max(${BOTTOM_MIN}px, calc((100% - ${TOOLBAR_ROW}px) * ${d.share}))`
}

/**
 * Stamped on the stored dock-sizes blob, as LAYOUT_VERSION is on the layout, for the same reason: App writes the sizes
 * on mount, so a blob holds the defaults of the day it was first written, and a changed default only reaches it
 * through a step in `migrateDockSizes`.
 *
 *   1 (unstamped) - one bottom-dock height for every panel (`dock`, default 230); the right column 280 wide
 *   2 - a height per panel (`bottom`); the right column 320 wide
 *   3 - the left column 260 wide (was 220 in both before)
 */
export const DOCK_SIZES_VERSION = 3

/** what v1 wrote as its defaults: a v1 blob still holding one of these was never dragged there */
const V1_DEFAULT_SIZES = { right: 280, dock: 230 }
/** ...and the one v1 and v2 both wrote for the left column */
const V2_DEFAULT_LEFT = 220

/**
 * Bring a stored dock-sizes blob up to DOCK_SIZES_VERSION, one step at a time.
 *
 * 1 -> 2 drops the old defaults, so the new ones apply (280 was an Inspector 60-70px too narrow for a conveyor's or a
 * robot's fields), and turns a dragged `dock` height into Parts' own: Parts was the tab in front by default, and the
 * other panels are better off at their new defaults than at a height that was chosen for a row of cards.
 *
 * 2 -> 3 drops a left column still at 220, a width at which the tree truncates names. Someone who dragged it to exactly
 * 220 gets 260 too; that is indistinguishable from never having dragged it, and every browser that opened the app
 * holds the second.
 */
export function migrateDockSizes(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  const blob: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  const version = typeof blob.version === 'number' ? blob.version : 1
  if (version < 2) {
    if (blob.right === V1_DEFAULT_SIZES.right) delete blob.right
    const dock = blob.dock
    delete blob.dock
    if (typeof dock === 'number' && Number.isFinite(dock) && dock !== V1_DEFAULT_SIZES.dock) blob.bottom = { catalog: dock }
  }
  if (version < 3 && blob.left === V2_DEFAULT_LEFT) delete blob.left
  return blob
}

/** The per-panel heights in a (migrated) dock-sizes blob; anything that is not a known panel's finite height is dropped. */
export function parseBottomHeights(blob: Record<string, unknown>): BottomHeights {
  const raw = blob.bottom
  if (!raw || typeof raw !== 'object') return {}
  const out: BottomHeights = {}
  for (const id of ALL_PANELS) {
    const v = (raw as Record<string, unknown>)[id]
    if (typeof v === 'number' && Number.isFinite(v)) out[id] = Math.max(BOTTOM_MIN, v)
  }
  return out
}

export interface DockGridStyle {
  gridTemplateColumns: string
  gridTemplateRows: string
  gridTemplateAreas: string
}

/**
 * CSS custom property carrying one dock size, e.g. `left` → `--dk-left`. The grid below
 * refers to these instead of hard px so a live gutter drag can move a track by writing one
 * custom property on the app root, with no React render in the loop - the drag mutates the
 * one thing that changed. React still owns the committed value (written on release); the
 * inline fallback below keeps the grid valid if no one has set the property yet.
 * `DockColumn` uses the same convention for its Top/Bottom split (`--dk-leftTop`).
 */
export function dockSizeVar(key: string): string {
  return `--dk-${key}`
}

/**
 * Build the CSS grid that places the toolbar, viewport, occupied side columns and
 * the bottom dock plus their resize gutters. Each side has two columns; a column
 * whose Top and Bottom sub-slots are both empty collapses - along with its gutter -
 * so the viewport reclaims the space, just like hiding an empty dock. The
 * internal Top/Bottom split inside a column is handled by the column itself, not
 * this grid. A collapsed bottom dock keeps its row (the tab strip is still there to
 * click) but sizes it to content and drops its resize gutter; a folded side column does the same
 * across, keeping its area for the tab rail.
 *
 * The bottom dock runs under the left columns and the viewport and stops at the right ones, which
 * run the full height beside it - Unity's default split. The two sides are not equal once the
 * bottom dock can stand tall for the PLC editor (`DEFAULT_BOTTOM_HEIGHT`): the Inspector is the
 * side panel still in use then (a part's tag, a speed) and the tallest content there is (648px
 * for a sensor, 4314 for a robot, measured on the demo), while the scene tree is the one that
 * matters least while programming. And the strip keeps the width under the left column, which a
 * ladder rung - contacts on the left rail, coils on the right - needs more than code does. Grid-area names:
 * `leftA`/`leftB`/`rightA`/`rightB` for the columns (A = primary/edge, B =
 * secondary/inner) and `gutlA`/`gutlB`/`gutrA`/`gutrB` for their resize gutters.
 */
export function buildDockGrid(layout: DockLayout, sizes: DockSizes): DockGridStyle {
  // A maximized panel takes the whole shell below the toolbar: every dock column and the
  // bottom dock collapse away. The single remaining cell is still named `viewport` because
  // the viewport element stays in it: the maximized panel shares the cell and paints over
  // a canvas that keeps its context (App hides it with `visibility`, which reserves layout
  // and so keeps the drawing buffer sized to something real). Same shape as distraction-free.
  if (layout.maximized) {
    return {
      gridTemplateColumns: 'minmax(0, 1fr)',
      gridTemplateRows: '48px minmax(0, 1fr)',
      gridTemplateAreas: '"toolbar" "viewport"',
    }
  }
  const hasBottom = layout.bottom.length > 0

  // each sized track reads its custom property, falling back to the committed value so the
  // template is valid on its own (a missing var would invalidate the whole declaration)
  const track = (key: keyof DockSizes): string => {
    const v = sizes[key]
    return `var(${dockSizeVar(key)}, ${typeof v === 'number' ? `${v}px` : v})`
  }

  const cols: string[] = []
  const mid: string[] = []
  // A shown column is its track plus a gutter on the viewport side. A folded one is only the rail,
  // sized `auto` to its tabs like the rolled-up bottom row, with no width to drag.
  const column = (id: DockColumnId, area: string, gutter: string): void => {
    if (!columnOccupied(layout, id)) return
    const left = id === 'left' || id === 'left2'
    if (isColumnCollapsed(layout, id)) {
      cols.push('auto')
      mid.push(area)
    } else if (left) {
      cols.push(track(id), '6px')
      mid.push(area, gutter)
    } else {
      cols.push('6px', track(id))
      mid.push(gutter, area)
    }
  }
  // left columns run edge → viewport (A then B), right columns viewport → edge (B then A)
  column('left', 'leftA', 'gutlA')
  column('left2', 'leftB', 'gutlB')
  cols.push('minmax(0, 1fr)')
  mid.push('viewport')
  column('right2', 'rightB', 'gutrB')
  column('right', 'rightA', 'gutrA')

  const span = (name: string): string => Array(cols.length).fill(name).join(' ')
  // a bottom-dock row: `name` from the left edge to the viewport's right edge, then the right
  // columns and their gutters carried on down from the row above
  const viewportCol = mid.indexOf('viewport')
  const underLeft = (name: string): string => [...Array(viewportCol + 1).fill(name), ...mid.slice(viewportCol + 1)].join(' ')
  const rows = [`${TOOLBAR_ROW}px`, 'minmax(0, 1fr)']
  const areas = [span('toolbar'), mid.join(' ')]
  if (hasBottom) {
    if (layout.bottomCollapsed) {
      // rolled up: no height to drag, so the gutter row goes away too. `auto` sizes the
      // row to the tab strip the slot still renders - no magic number to keep in sync
      // with the tab CSS.
      rows.push('auto')
      areas.push(underLeft('bottom'))
    } else {
      rows.push('6px', track('dock'))
      areas.push(underLeft('gutd'), underLeft('bottom'))
    }
  }

  return {
    gridTemplateColumns: cols.join(' '),
    gridTemplateRows: rows.join(' '),
    gridTemplateAreas: areas.map((a) => `"${a}"`).join(' '),
  }
}

/** a cell of `buildDockGrid` where a column's width gutter meets the bottom dock's height gutter */
export interface DockGridCorner {
  side: DockSide
  widthKey: 'left' | 'left2' | 'right' | 'right2'
  /** grid lines, 1-based */
  row: number
  column: number
}

/**
 * Where the column width gutters meet the bottom dock's height gutter. Each left gutter crosses it, in a cell of the
 * `gutd` area. On the right the height gutter ends against the innermost right gutter, which carries on down, so
 * that T is a corner too, in a cell of that gutter's area. Either way the cell belongs to an area, so a corner
 * handle is placed by line, over it.
 */
export function dockGridCorners(layout: DockLayout): DockGridCorner[] {
  if (layout.maximized || layout.bottom.length === 0 || layout.bottomCollapsed) return []
  const corners: DockGridCorner[] = []
  // left columns are laid out as [column, gutter] pairs from the edge, so a gutter's track is 2, 4;
  // a folded column is one track (its rail) and has no gutter to meet
  let column = 0
  for (const id of ['left', 'left2'] as const) {
    if (!columnOccupied(layout, id)) continue
    if (isColumnCollapsed(layout, id)) {
      column += 1
      continue
    }
    column += 2
    corners.push({ side: 'left', widthKey: id, row: 3, column })
  }
  // the viewport's track, then the first right column: its gutter when it is shown, none when it is a rail
  const inner = columnOccupied(layout, 'right2') ? 'right2' : columnOccupied(layout, 'right') ? 'right' : null
  if (inner && !isColumnCollapsed(layout, inner)) corners.push({ side: 'right', widthKey: inner, row: 3, column: column + 2 })
  return corners
}
