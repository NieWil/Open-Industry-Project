import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { effectivelyHiddenSet, orderedTree, subtreeIds } from '../../core/scene/hierarchy'
import { PART_DEFS } from '../../core/types'
import type { SdkPart, PartDef, PartInstance } from '../../core/types'
import { getPackage } from '../../core/parts/partRegistry'
import { isStandardCategory, packageCategory } from '../../core/parts/partCategory'
import { partDisplayNames } from '../../core/parts/partDisplayName'
import { resolveKeyAction } from '../../core/keymap'
import { keyBelongsToTarget } from '../dialogHost'
import { runCommand, runCommandOn } from '../commands'
import { preloadBehaviorEditor } from './behaviorEditorChunk'
import { flattenRigForest, jointRange, rigGeometryOf, shapeLabel } from '../rigTree'
import { sceneDisplayUnits } from '../../core/scene/sceneUnits'
import type { RigJoint, RigLink } from '../../core/parts/partPackage'
import { partLinkOwnership } from '../../core/rig/rigPose'
import type { EditorState, EditorStore } from '../store/store'
import { rigNodeKey } from '../store/store'
import type { EditorController } from '../controller'
import { controllerBadges } from '../program/controllerBadges'
import { partsWithForces, usePlcForces } from '../program/plcForces'
import { matchesTreeFilter, sessionDefinitionScope } from '../treeNode'
import type { TreeNodeSource } from '../treeNode'
import { SceneTreeMenu } from './SceneTreeMenu'
import { useTreeDrag } from './sceneTreeDnd'
import type { DropPos } from './sceneTreeDnd'
import { rowWindow } from './sceneTreeWindow'
import { ChevronIcon, PencilIcon, SceneIcon, ScriptIcon, TreeGlyph } from './toolbarIcons'
import type { TreeGlyphKind } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const CATEGORY_ICONS: Record<PartDef['category'], TreeGlyphKind> = {
  Equipment: 'equipment',
  Devices: 'devices',
  Products: 'products',
  Structure: 'structure',
}

/** a category's row glyph: a category a part names itself has no glyph of its own, so it takes Equipment's */
export function categoryIcon(category: string): TreeGlyphKind {
  return isStandardCategory(category) ? CATEGORY_ICONS[category] : 'equipment'
}

/** indentation per tree depth, in px */
const INDENT_PX = 13
/**
 * Windowing (see `renderRows` / `window` below). Rendering every row makes 200 parts
 * 3,897 DOM nodes with 177 of 200 rows scrolled out of sight, and a selection change then spends
 * its frame on that DOM's layout and paint, not on React (measured: a ~35 ms frame in a prod
 * build against a 16.6 ms quiet frame). Rows are uniform
 * single-line flex items, so the visible range is pure arithmetic on the scroll offset; the rows
 * outside it become two spacer divs that hold the scrollbar's extent.
 *
 * The row pitch (height + the container's 1 px flex gap) is measured from two live rows rather than
 * hardcoded, so a theme/zoom/font change can't desynchronise the mapping from scrollTop to index.
 */
const ROW_OVERSCAN = 6
const ROW_PITCH_FALLBACK = 25

/** one drawable row: a scene part, or one rig link of an expanded custom part.
 *  `open` is the part's disclosure state, resolved once where the rows are built - the row and the
 *  rig children it does (or doesn't) expand into must agree on it, and computing it twice invites
 *  them to disagree. (TypeScript won't catch a missing `open` either: the bare name resolves to
 *  the DOM's `window.open`, so a missing local compiles clean and renders every caret expanded.) */
type RenderRow =
  | { key: string; kind: 'part'; part: PartInstance; depth: number; hasChildren: boolean; open: boolean }
  | { key: string; kind: 'rig'; part: PartInstance; link: RigLink; joint: RigJoint | undefined; depth: number }

interface SceneTreeProps {
  store: EditorStore
  state: EditorState
  /** null in contexts without a live controller (e.g. tests); "Open Part Editor" then can't stop the sim first */
  controller?: EditorController | null
}

// Row and head glyphs: filled, like every other editor icon (toolbarIcons.tsx), secondary parts at half
// opacity. Sized per use (10-13px) because they sit in a dense tree row, not a toolbar.

/** visible = the open eye the Share menu uses (toolbarIcons EyeIcon); hidden = a closed eye */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true" focusable="false">
      {off ? (
        <path d="M1 6.2l1.3-.8C3.7 7.4 5.7 8.5 8 8.5s4.3-1.1 5.7-3.1l1.3.8C13.3 8.7 10.9 10 8 10S2.7 8.7 1 6.2zM4.1 9.2 3 11l1.3.8 1.1-1.9zm3.15.8h1.5v2h-1.5zm4.65-.8 1.1 1.8-1.3.8-1.1-1.9z" />
      ) : (
        <path d="M8 3C4.5 3 1.7 5.1 0.5 8c1.2 2.9 4 5 7.5 5s6.3-2.1 7.5-5C14.3 5.1 11.5 3 8 3zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
      )}
    </svg>
  )
}

function LockIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="3" y="7" width="10" height="7.5" rx="1" />
      {/* shackle: closed when locked, swung open when unlocked */}
      <path d={open ? 'M5 7V5a3 3 0 0 1 5.8-1.1l-1.4.6A1.5 1.5 0 0 0 6.5 5v2z' : 'M5 7V5a3 3 0 0 1 6 0v2H9.5V5a1.5 1.5 0 0 0-3 0v2z'} />
    </svg>
  )
}

/** small frame badge on a select-as-one row (a viewport click on any part inside selects it) */
function GroupBadge() {
  return (
    <svg className="tree-group-badge" viewBox="0 0 16 16" width="11" height="11" fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d="M4.5 2h7A2.5 2.5 0 0 1 14 4.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5v-7A2.5 2.5 0 0 1 4.5 2zm0 2.2a.3.3 0 0 0-.3.3v7a.3.3 0 0 0 .3.3h7a.3.3 0 0 0 .3-.3v-7a.3.3 0 0 0-.3-.3z" />
    </svg>
  )
}

/** disclosure triangle: points right when collapsed, down when expanded */
function Caret({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
      aria-hidden="true"
      focusable="false"
      style={{ transform: collapsed ? 'none' : 'rotate(90deg)' }}
    >
      <path d="M5 3l6 5-6 5z" fill="currentColor" />
    </svg>
  )
}

/** the head's "show part types" toggle: a label/tag glyph */
function TypeTagIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" fillRule="evenodd" aria-hidden="true" focusable="false">
      <path d="M13.5 2.5H9a1 1 0 0 0-.7.3L2.8 8.3a1 1 0 0 0 0 1.4l3.5 3.5a1 1 0 0 0 1.4 0l5.5-5.5a1 1 0 0 0 .3-.7V3a.5.5 0 0 0-.5-.5zm-2.7 1.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 1 0 0-2.2z" />
    </svg>
  )
}

/** A tree row's identity, passed to the shared handlers so they can dispatch by kind (one row
 *  component serves scene parts and rig links). A part is addressed by id; a rig link by its owning part + name. */
export type RowDesc = { kind: 'part'; id: string } | { kind: 'rigLink'; id: string; partId: string; linkName: string }

interface TreeRowProps {
  /** 'part' = a scene placement; 'rigLink' = an internal node of a custom part's rig (author mode) */
  kind: 'part' | 'rigLink'
  /** stable address: part.id, or rigNodeKey(partId, linkName) - drives the memo, the row's data-row-id, and the handlers */
  rowId: string
  /** rig-link rows only: the owning part + link name (so handlers can target the package) */
  partId?: string
  linkName?: string
  label: string
  depth: number
  /** the leading glyph - a category icon (part) or a joint glyph (rig link); a key, so the memo compares by value */
  icon: TreeGlyphKind
  /** the trailing type label - the part def label, or a rig joint name / shape label */
  typeLabel: string
  /** row tooltip - rig joint/shape detail; omitted for parts */
  rowTitle?: string
  /** rig-link rows: short tags for what is true of the node besides its own fields - a param sets some of them,
   *  an aim sets its rotation, it is repeated, the script draws on it (nodeBadges); '' for none. A string, so the
   *  memo compares by value. */
  nodeBadges?: string
  /** part rows: show an expand/collapse caret (rig links always render expanded, so they get a spacer) */
  hasChildren: boolean
  grouped: boolean
  hasScript: boolean
  isOpenScene: boolean
  selected: boolean
  renaming: boolean
  /** the rename input's text - '' for every non-renaming row, so their prop stays stable */
  renameText: string
  /** this row's own visibility (drives the eye toggle) */
  hidden: boolean
  /** own or inherited from a hidden ancestor (dims the row) */
  rowHidden: boolean
  locked: boolean
  /** capability gates (from the TreeNode model) - a rig link can't reorder/reparent, etc. */
  canHide: boolean
  canLock: boolean
  /** the active drop indicator for this row, or null when it isn't the drop target */
  dropPos: DropPos | null
  collapsed: boolean
  canReorder: boolean
  running: boolean
  /** a tag of the part is forced while the program runs (EditorController.forcePlcValue) */
  forced?: boolean
  /** the controller its PLC tags are on, when the row names one (program/controllerBadges.ts) */
  controllerBadge?: string
  onRowClick: (e: ReactMouseEvent, desc: RowDesc) => void
  onRowContextMenu: (e: ReactMouseEvent, desc: RowDesc) => void
  onBeginRename: (desc: RowDesc) => void
  onToggleCollapse: (id: string) => void
  /** set this row's lock to `locked` (the desired new value); routes to the store/controller by kind */
  onSetLocked: (desc: RowDesc, locked: boolean) => void
  /** set this row's hidden to `hidden` (the desired new value); routes by kind */
  onSetHidden: (desc: RowDesc, hidden: boolean) => void
  /** part rows only: start a drag-toggle of visibility from this row's eye (hidden = its current own state) */
  onVisiblePointerDown: (id: string, hidden: boolean) => void
  /** part rows only: pointer dragged onto this row - paints the active visibility drag, if any */
  onRowPointerEnter: (id: string, buttons: number) => void
  onOpenBehavior: (id: string) => void
  onOpenScene: (id: string) => void
  onDragStart: (e: ReactDragEvent<HTMLDivElement>, id: string) => void
  onDragOver: (e: ReactDragEvent<HTMLDivElement>, id: string) => void
  onDrop: (e: ReactDragEvent<HTMLDivElement>, id: string) => void
  onDragEnd: () => void
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
}

const M = defineMessages('sceneTree', {
  // a mark, not a word: the forced badge the rungs draw beside an operand (LadderView)
  forced: 'F',
  forcedTitle: 'A tag of this part is forced: the running program holds it until released',
  controllerTitle: 'Its PLC tags are on {name}',
  tagParam: 'param',
  whyParam: "Its position is partly set by the part's params: {params}",
  tagAim: 'aim',
  whyAim: 'Rotation aims at {target}',
  tagArray: 'array',
  whyWorldPitch: 'Repeated on a world-wide pitch along X',
  whyCopies: 'Repeated into copies',
  tagScript: 'script',
  whyDrawn: "The part's script draws on this node",
  expand: 'Expand',
  collapse: 'Collapse',
  groupTitle: 'Select as one: a viewport click on any part inside selects this',
  openScene: 'Open in the part editor',
  editScript: 'Edit behavior script',
  unlock: 'Unlock',
  lock: 'Lock',
  show: 'Show',
  hide: 'Hide',
  renameReferences: {
    one: 'Also update {count} reference to “{name}” in the behavior script?',
    other: 'Also update {count} references to “{name}” in the behavior script?',
  },
  instances: { one: '{count} instance', other: '{count} instances' },
  defScopeTitle: 'Editing a definition: changes apply to every instance ({instances})',
  definition: 'definition',
  backTitle: 'Back to the full scene',
  scene: 'Scene',
  instancesUpdate: '{instances} in this scene will update on save',
  filter: 'Filter parts',
  hideTypes: 'Hide part types',
  showTypes: 'Show part types',
  empty: 'No parts yet.',
  noMatch: 'No matching parts.',
})

/**
 * One tree row for both kinds, memoized: with primitive props + stable handlers (the parent funnels
 * per-render values through a ref, see SceneTree), a selection / collapse / drag change re-renders only the
 * rows whose own props changed - not all N rows. Scene parts and rig links share this single component; the
 * kind-specific affordances (drag/reorder/badges/script for parts; the rig glyph) are gated on `kind` + caps.
 * The node-model dispatch lives in the parent's `desc`-keyed handlers - passing the freshly-built TreeNode in
 * would defeat the memo, so the row carries primitives and hands its identity back via `RowDesc`.
 */
/**
 * What a rig node's row should say about it beyond its name, from core's ownership answer (the same one the
 * Inspector and the gizmo lock fields by): a frame like a roller conveyor's 'roller' draws nothing itself, so
 * without these it reads as an empty node. `tags` is the row's short text, `why` the tooltip lines.
 */
function nodeBadges(part: PartInstance, link: RigLink): { tags: string; why: string[] } {
  const pkg = part.type === 'part' ? getPackage((part as SdkPart).packageId) : undefined
  const own = pkg ? partLinkOwnership(pkg, link.name, (part as SdkPart).params) : null
  if (!own) return { tags: '', why: [] }
  const tags: string[] = []
  const why: string[] = []
  // 'param' only where the gizmo loses a handle (a position axis a param sets): a param-driven size, which on a
  // conveyor is nearly every node, is said where it is edited, in the Inspector, and would tag every row here
  const params = own.offset.flatMap((o) => (o?.by === 'param' ? [o.param] : []))
  if (params.length > 0) {
    tags.push(t(M.tagParam))
    why.push(t(M.whyParam, { params: [...new Set(params)].join(', ') }))
  }
  if (own.rotation?.by === 'aim') {
    tags.push(t(M.tagAim))
    why.push(t(M.whyAim, { target: own.rotation.target }))
  }
  for (const n of own.notes) {
    if (n.kind === 'array') {
      tags.push(t(M.tagArray))
      why.push(n.worldPhase ? t(M.whyWorldPitch) : t(M.whyCopies))
    } else if (n.kind === 'drawn') {
      tags.push(t(M.tagScript))
      why.push(t(M.whyDrawn))
    }
  }
  return { tags: tags.join(' · '), why }
}

const TreeRow = memo(function TreeRow(props: TreeRowProps) {
  const { kind, rowId, label, depth, icon, typeLabel, rowTitle, hasChildren, grouped, hasScript, isOpenScene, selected, renaming, renameText, hidden, rowHidden, locked, canHide, canLock, dropPos, collapsed, canReorder, running } = props
  const isPart = kind === 'part'
  const desc: RowDesc = isPart ? { kind: 'part', id: rowId } : { kind: 'rigLink', id: rowId, partId: props.partId!, linkName: props.linkName! }
  const drop = dropPos ? ` drop-${dropPos}` : ''
  return (
    <div
      // the row's stable address, in the DOM: with the tree windowed, "is this part's row rendered,
      // and is it on screen?" is a real question a gate has to be able to ask (verify-panel-dom-budget)
      data-row-id={rowId}
      className={`tree-row${isPart ? '' : ' rig-node'}${selected ? ' selected' : ''}${rowHidden ? ' hidden' : ''}${locked ? ' locked' : ''}${grouped ? ' grouped' : ''}${drop}`}
      title={rowTitle}
      draggable={isPart && canReorder && !renaming}
      onClick={(e) => props.onRowClick(e, desc)}
      onPointerEnter={isPart ? (e) => props.onRowPointerEnter(rowId, e.buttons) : undefined}
      onContextMenu={(e) => props.onRowContextMenu(e, desc)}
      onDoubleClick={() => {
        if (running || renaming) return
        props.onBeginRename(desc)
      }}
      onDragStart={isPart ? (e) => props.onDragStart(e, rowId) : undefined}
      onDragOver={isPart ? (e) => props.onDragOver(e, rowId) : undefined}
      onDrop={isPart ? (e) => props.onDrop(e, rowId) : undefined}
      onDragEnd={isPart ? props.onDragEnd : undefined}
    >
      {isPart && hasChildren ? (
        <button
          className="tree-caret"
          style={{ marginLeft: depth * INDENT_PX }}
          title={collapsed ? t(M.expand) : t(M.collapse)}
          draggable={false}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleCollapse(rowId)
          }}
        >
          <Caret collapsed={collapsed} />
        </button>
      ) : (
        <span className="tree-caret-spacer" style={{ marginLeft: depth * INDENT_PX }} />
      )}
      <span className="tree-icon"><TreeGlyph kind={icon} /></span>
      {grouped && (
        <span className="tree-group-wrap" title={t(M.groupTitle)}>
          <GroupBadge />
        </span>
      )}
      {renaming ? (
        <input
          className="tree-rename"
          autoFocus
          value={renameText}
          placeholder={label}
          onChange={(e) => props.onRenameChange(e.target.value)}
          onBlur={props.onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onRenameCommit()
            else if (e.key === 'Escape') props.onRenameCancel()
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span className="tree-name">{label}</span>
          {props.forced && (
            <span className="tree-forced" data-testid="tree-forced" title={t(M.forcedTitle)}>
              {t(M.forced)}
            </span>
          )}
          {props.controllerBadge ? (
            <span className="tree-controller" data-testid="tree-controller" title={t(M.controllerTitle, { name: props.controllerBadge })}>
              {/* i18n-ok: the controller's name, as the tags spell it */}
              {props.controllerBadge}
            </span>
          ) : null}
          {props.nodeBadges ? (
            <span className="tree-node-badges" data-testid="tree-node-badges">
              {props.nodeBadges}
            </span>
          ) : null}
          <span className="tree-type">{typeLabel}</span>
          {isPart && hasScript && !isOpenScene && (
            <button
              className="tree-open-scene"
              title={t(M.openScene)}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation()
                props.onOpenScene(rowId)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <SceneIcon />
            </button>
          )}
          {isPart && hasScript && (
            <button
              className="tree-script"
              title={t(M.editScript)}
              draggable={false}
              // preload the Monaco chunk on hover so the editor opens without its download spinner
              onPointerEnter={() => preloadBehaviorEditor()}
              onClick={(e) => {
                e.stopPropagation()
                props.onOpenBehavior(rowId)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <ScriptIcon />
            </button>
          )}
          {canLock && (
            <button
              className="tree-lock"
              title={locked ? t(M.unlock) : t(M.lock)}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation()
                props.onSetLocked(desc, !locked)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <LockIcon open={!locked} />
            </button>
          )}
          {canHide && (
            <button
              className="tree-eye"
              title={hidden ? t(M.show) : t(M.hide)}
              draggable={false}
              // part: a primary pointerdown toggles + arms the drag-paint; the click is swallowed so the row
              // isn't selected. A right-press opens the row's context menu and must not hide the part on
              // its way (pointerdown fires for every button). rig: no paint - a plain click toggles its
              // persisted visibility.
              onPointerDown={
                isPart
                  ? (e) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      props.onVisiblePointerDown(rowId, hidden)
                    }
                  : undefined
              }
              onClick={(e) => {
                e.stopPropagation()
                // part mouse-click is handled by pointerdown (detail≥1); keyboard (detail 0) + every rig click toggle here
                if (!isPart || e.detail === 0) props.onSetHidden(desc, !hidden)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <EyeIcon off={hidden} />
            </button>
          )}
        </>
      )}
    </div>
  )
})

export function SceneTree({ store, state, controller }: SceneTreeProps) {
  // the parts with a forced signal, re-worked out when a force is set or released (not every frame)
  const forces = usePlcForces(controller)
  const forcedParts = useMemo(() => partsWithForces(state.scene.parts, forces, controller?.plcProgramWatch, controller?.plcAliases), [state.scene.parts, forces, controller])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [text, setText] = useState('')
  // author-mode rig-node rename (parallel to the part-row rename above): which internal link is being
  // renamed + its input buffer. Separate from `renamingId`/`text` because the two name different things.
  const [renamingRig, setRenamingRig] = useState<{ partId: string; linkName: string } | null>(null)
  const [rigText, setRigText] = useState('')
  const [filter, setFilter] = useState('')
  // One context menu for both kinds: it carries the right-clicked row as a TreeNodeSource so the
  // menu can build its TreeNode and gate items by capability - scene parts and rig links share this menu.
  const [menu, setMenu] = useState<{ x: number; y: number; src: TreeNodeSource } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // rig-internal disclosure for custom parts with no scene children (default closed so a 20-link robot
  // doesn't flood the tree). Parts that also have scene children reuse `collapsed` instead.
  
  const treeRef = useRef<HTMLDivElement>(null)
  // last clicked row: the pivot Shift-click ranges from
  const anchor = useRef<string | null>(null)
  const lastSelected = state.selectedIds[state.selectedIds.length - 1]

  const q = filter.trim().toLowerCase()
  const filtering = q !== ''
  const parts = state.scene.parts
  // The derived tree state below is memoized on its inputs: every committed store change re-renders the
  // whole panel (App subscribes to the store wholesale), so without the memos each selection click would
  // re-walk the hierarchy and rebuild every Map/Set here even when the scene didn't change.
  // id → part, for the O(1) lookups the row handlers do (they read it through the `live` ref)
  const partsById = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts])
  // every part's row label, in one pass (partDisplayName per row would rescan the scene per row). A
  // custom part's label comes from its package name, which can change with `parts` untouched; hence
  // packageRev, as in renderRows below.
  const displayNames = useMemo(() => partDisplayNames(parts), [parts, state.packageRev])
  // which rows name the PLC their tags are on: few, since a group on one controller is named once
  const badgeOf = useMemo(() => controllerBadges(parts, filtering), [parts, filtering, state.packageRev])
  // filtered view is a flat list (no nesting/DnD); otherwise a nested pre-order walk
  const allRows = useMemo(
    () =>
      filtering
        ? parts.filter((p) => matchesTreeFilter(p, displayNames.get(p.id) ?? p.id, q)).map((part) => ({ part, depth: 0, hasChildren: false }))
        : orderedTree(parts, (id) => collapsed.has(id)),
    [parts, displayNames, filtering, q, collapsed],
  )
  // part-scene focus ("open scene"): the dock shows only the opened part + its subtree as the tree.
  const focusId = state.focusedPartId
  const focusedPart = focusId ? (partsById.get(focusId) ?? null) : null
  // The session's definition scope (editing a package def, not a placement). Drives the
  // "Editing definition - N instances" banner + a panel tint, consolidating the scattered instance/definition
  // cues onto one concept. null in the base scene or a plain part-focus (inspecting one placement).
  const defScope = sessionDefinitionScope(state)
  const defName = defScope ? (getPackage(defScope.ref)?.name ?? focusedPart?.name ?? 'part') : ''
  const instCount = defScope?.instancesAffected ?? 0
  // leaving a definition session swaps the live scene: the Close Part Editor command (commands.ts), which stops a run first
  const back = (): void => runCommand('part.closeScene')
  const instLabel = t(M.instances, { count: instCount })
  const focusSub = useMemo(() => (focusId ? new Set(subtreeIds(parts, [focusId])) : null), [parts, focusId])
  const treeRows = useMemo(() => (focusSub ? allRows.filter((r) => focusSub.has(r.part.id)) : allRows), [allRows, focusSub])
  const visibleIds = useMemo(() => treeRows.map((r) => r.part.id), [treeRows])
  const rowInfo = useMemo(() => new Map(treeRows.map((r) => [r.part.id, r])), [treeRows])
  const partParent = useMemo(() => new Map(parts.map((p) => [p.id, p.parent])), [parts])
  /**
   * One flat list of the rows the panel would draw: a part row, then the rig rows it has expanded,
   * in the order they appear. Nesting the rig expansion inside the part map would make
   * "row N" un-addressable; windowing (below) needs a single index space, and so does anything that
   * wants to scroll to a row without touching the DOM.
   */
  const renderRows = useMemo(() => {
    const out: RenderRow[] = []
    for (const { part, depth, hasChildren } of treeRows) {
      // scene-children parts toggle via `collapsed`; the opened part-scene root is always expanded, so its
      // rig is the visible tree.
      const open = (hasChildren && !collapsed.has(part.id)) || part.id === focusId
      out.push({ key: part.id, kind: 'part', part, depth, hasChildren, open })
      const isCustom = part.type === 'part'
      // same gate as the row itself: internals show only for the opened part-scene root, and never in the
      // flat filtered view
      if (filtering || !isCustom || part.id !== focusId) continue
      if (!open) continue
      const geom = rigGeometryOf(part)
      if (!geom) continue
      for (const r of flattenRigForest(geom, depth)) {
        out.push({ key: rigNodeKey(part.id, r.link.name), kind: 'rig', part, link: r.link, joint: r.joint, depth: r.depth })
      }
    }
    return out
    // `packageRev` is a required dependency: a rig row's existence comes from the package
    // (rigGeometryOf reads the registry), not from `parts` - so adding or renaming a link re-renders
    // with an unchanged parts array, and a memo keyed only on the scene would serve a row list that
    // predates the edit. The store bumps packageRev on every registry write for exactly this.
  }, [treeRows, filtering, focusId, collapsed, state.packageRev])

  // --- windowing: render only the rows in (and just outside) the scroll viewport ---
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const rowPitch = useRef(ROW_PITCH_FALLBACK)
  // the scroll-to-selection effect runs a frame later, by which time `renderRows` may have been
  // rebuilt; read it through a ref so the effect never closes over a stale list
  const renderRowsRef = useRef(renderRows)
  renderRowsRef.current = renderRows

  // measure the true pitch from two consecutive live rows (row height + the container's flex gap).
  // Runs after every render but costs one offsetTop read of already-laid-out nodes, and only when at
  // least two rows exist.
  useEffect(() => {
    const el = treeRef.current
    if (!el) return
    const live = el.querySelectorAll<HTMLDivElement>('.tree-row')
    if (live.length >= 2) {
      // Fractional, and averaged over the whole mounted window. `offsetTop` is an integer, so one gap
      // between two adjacent rows measures a 25.3px pitch as 25. revealRow multiplies the pitch by the
      // row index, so the 0.3px rounding compounds to ~34px short at row 200, below the fold. Windowed,
      // the row then unmounts, so selecting the last part in the demo would scroll near it and show
      // nothing (verify-panel-dom-budget's "scrolls it on screen").
      const spanTop = live[0]!.getBoundingClientRect().top
      const spanBottom = live[live.length - 1]!.getBoundingClientRect().top
      const pitch = (spanBottom - spanTop) / (live.length - 1)
      // …and a 0.5 threshold would have rejected exactly the correction this is about.
      if (pitch > 0 && Math.abs(pitch - rowPitch.current) > 0.02) rowPitch.current = pitch
    }
    if (el.clientHeight !== viewport.height) setViewport((v) => ({ ...v, height: el.clientHeight }))
  })

  useEffect(() => {
    const el = treeRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setViewport((v) => ({ ...v, height: el.clientHeight })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // scroll updates coalesce to one state write per frame: a trackpad fling fires far more scroll
  // events than there are frames to render, and each one would otherwise re-slice the list
  const scrollRaf = useRef(0)
  const onTreeScroll = useCallback(() => {
    if (scrollRaf.current) return
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      const el = treeRef.current
      if (el) setViewport({ top: el.scrollTop, height: el.clientHeight })
    })
  }, [])
  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), [])

  const pitch = rowPitch.current
  const total = renderRows.length
  const { first: firstIdx, last: lastIdx } = rowWindow(viewport.top, viewport.height || 600, pitch, total, ROW_OVERSCAN)
  // a row being renamed keeps its input mounted even if the user scrolls it away - losing focus
  // mid-rename would discard what they were typing
  const renamingKey = renamingId ?? (renamingRig ? rigNodeKey(renamingRig.partId, renamingRig.linkName) : null)
  const renamingIdx = renamingKey === null ? -1 : renderRows.findIndex((r) => r.key === renamingKey)
  // ...and the rename can't outlive its row. A rename begun on a part the dock doesn't show (filtered
  // out, outside the opened scene) or whose row went away mid-rename (undo, a
  // collab peer) mounts no input, so nothing would ever commit or cancel it - and every row handler
  // stands down while a rename is open, which left the tree deaf to clicks until a reload.
  useEffect(() => {
    if (renamingKey === null || renamingIdx >= 0) return
    setRenamingId(null)
    setRenamingRig(null)
  }, [renamingKey, renamingIdx])
  const windowRows = renderRows.slice(firstIdx, lastIdx)
  if (renamingIdx >= 0 && (renamingIdx < firstIdx || renamingIdx >= lastIdx)) windowRows.push(renderRows[renamingIdx]!)
  const padTop = firstIdx * pitch
  const padBottom = Math.max(0, (total - lastIdx) * pitch)
  // a part hidden directly or via a hidden ancestor reads dimmed
  const effHidden = useMemo(() => effectivelyHiddenSet(parts), [parts])
  // reorder/reparent by drag only against the full, unfiltered tree
  const canReorder = !filtering

  // The row handlers below are useCallback-stable so the memoized TreeRows aren't all invalidated
  // when one row changes. The per-render values they need (the current visible order, selection,
  // parts, rename buffer) are funnelled through this ref, read at call time.
  const live = useRef({ visibleIds, selectedIds: state.selectedIds, parts, partsById, focusId, renamingId, running: state.running, text, renamingRig, rigText })
  live.current = { visibleIds, selectedIds: state.selectedIds, parts, partsById, focusId, renamingId, running: state.running, text, renamingRig, rigText }

  // drag & drop (reorder + reparent): the in-flight drag ids, drop indicator, and row/container handlers
  const expandRow = useCallback((id: string) => {
    setCollapsed((cur) => {
      if (!cur.has(id)) return cur
      const next = new Set(cur)
      next.delete(id)
      return next
    })
  }, [])
  const { dropAt, onDragStart, onRowDragOver, onRowDrop, onDragEnd, onTreeDragOver, onTreeDrop } = useTreeDrag(store, live, expandRow)

  const closeMenu = useCallback(() => setMenu(null), [])

  const commitRename = useCallback(() => {
    const { renamingId: rid, text: t } = live.current
    if (rid !== null) store.rename(rid, t)
    setRenamingId(null)
  }, [store])

  const cancelRename = useCallback(() => setRenamingId(null), [])

  // open every collapsed ancestor of `id`, so its row is in the list
  const expandAncestors = useCallback((id: string) => {
    const byId = live.current.partsById
    const part = byId.get(id)
    if (!part) return
    setCollapsed((cur) => {
      let next: Set<string> | null = null
      const seen = new Set<string>()
      for (let pid = part.parent; pid !== undefined && !seen.has(pid); pid = byId.get(pid)?.parent) {
        seen.add(pid)
        if (!cur.has(pid)) continue
        next = next ?? new Set(cur)
        next.delete(pid)
      }
      return next ?? cur
    })
  }, [])

  const beginRename = useCallback(
    (id: string) => {
      const { running, partsById: byId } = live.current
      if (running) return
      const part = byId.get(id)
      if (!part) return
      // F2 on a part picked in the viewport can land under a collapsed ancestor: open the path so the
      // input mounts (a row hidden any other way is dropped by the rename guard above)
      expandAncestors(id)
      setText(part.name ?? '')
      setRenamingId(id)
    },
    [expandAncestors],
  )

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // drag-toggle visibility: press the eye and drag across rows to set them
  // all to the same state. visPaint holds the target `visible` value for the active drag.
  // The paint ends on release, on the window losing focus, or on entering a row with no button held: Alt-Tab mid-drag
  // can take the release with it, and the paint then went on hiding every row the mouse crossed, an undo step each.
  const visPaint = useRef<boolean | null>(null)
  const onVisiblePointerDown = useCallback(
    (id: string, hidden: boolean) => {
      const target = hidden // toggling a hidden row shows it, and vice-versa
      visPaint.current = target
      store.setVisible([id], target)
      const end = (): void => {
        visPaint.current = null
        window.removeEventListener('pointerup', end)
        window.removeEventListener('blur', end)
      }
      window.addEventListener('pointerup', end)
      window.addEventListener('blur', end)
    },
    [store],
  )
  const onRowPointerEnter = useCallback(
    (id: string, buttons: number) => {
      if (visPaint.current === null) return
      if (buttons === 0) visPaint.current = null
      else store.setVisible([id], visPaint.current)
    },
    [store],
  )

  // A custom part row's two icons are the part commands (commands.ts part.*) aimed at that row's part, selected or
  // not: the </> badge is Edit Behavior, the clapperboard Open Part Editor. Its right-click menu runs the same commands.
  const onOpenBehavior = useCallback((id: string) => runCommandOn('part.editBehavior', { partId: id }), [])
  const onOpenScene = useCallback((id: string) => runCommandOn('part.openScene', { partId: id }), [])

  // Author mode: select a rig-internal link for read-only inspection (only its part's open scene shows
  // these rows). Focus the tree so keyboard nav keeps working, mirroring a part-row click.
  const onSelectRig = useCallback(
    (partId: string, linkName: string) => {
      treeRef.current?.focus({ preventScroll: true })
      store.selectRigNode(partId, linkName)
    },
    [store],
  )

  // Author-mode rig-node rename (double-click a link row). Seeds the buffer with the current name; commit
  // cascades through the package via the controller (renames the link + its parent/aim/joint references).
  const beginRenameRig = useCallback((partId: string, linkName: string) => {
    if (live.current.running) return
    setRigText(linkName)
    setRenamingRig({ partId, linkName })
  }, [])

  const commitRenameRig = useCallback(() => {
    const { renamingRig: r, rigText: text } = live.current
    if (r && controller) {
      const part = live.current.partsById.get(r.partId)
      // the predicate only fires when the (valid) rename has whole-literal references to the old name in the
      // behavior script - guard the freeform-JS rewrite behind an explicit confirm (see renameRigNode).
      if (part?.type === 'part') {
        controller.renameRigNode((part as SdkPart).packageId, r.linkName, text, (count) =>
          window.confirm(t(M.renameReferences, { count, name: r.linkName })),
        )
      }
    }
    setRenamingRig(null)
  }, [controller])

  const cancelRenameRig = useCallback(() => setRenamingRig(null), [])

  // move the selection to `id`, extending the range from the anchor when Shift is held
  const navTo = (id: string | undefined, shift: boolean) => {
    if (id === undefined) return
    if (shift && anchor.current !== null) {
      const a = visibleIds.indexOf(anchor.current)
      const b = visibleIds.indexOf(id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        store.selectMany(visibleIds.slice(lo, hi + 1))
        return
      }
    }
    store.select(id)
    anchor.current = id
  }

  // Tree keyboard navigation, active while the tree has focus:
  // Up/Down step rows, Home/End jump, Right expands then descends, Left collapses
  // then ascends, Shift extends the range. Ctrl+Up/Down (move) is left to the controller.
  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (renamingId !== null) return
    if (e.target instanceof HTMLElement && e.target.tagName === 'INPUT') return
    const k = e.key
    if ((k === 'ArrowUp' || k === 'ArrowDown') && (e.ctrlKey || e.metaKey)) return
    if (visibleIds.length === 0) return
    const cur = lastSelected
    const idx = cur !== undefined ? visibleIds.indexOf(cur) : -1
    if (k === 'ArrowDown') {
      e.preventDefault()
      navTo(visibleIds[idx < 0 ? 0 : Math.min(idx + 1, visibleIds.length - 1)], e.shiftKey)
    } else if (k === 'ArrowUp') {
      e.preventDefault()
      navTo(visibleIds[idx <= 0 ? 0 : idx - 1], e.shiftKey)
    } else if (k === 'Home') {
      e.preventDefault()
      navTo(visibleIds[0], e.shiftKey)
    } else if (k === 'End') {
      e.preventDefault()
      navTo(visibleIds[visibleIds.length - 1], e.shiftKey)
    } else if (k === 'ArrowRight') {
      e.preventDefault()
      if (cur === undefined) return navTo(visibleIds[0], false)
      if (rowInfo.get(cur)?.hasChildren) {
        if (collapsed.has(cur)) toggleCollapse(cur) // expand
        else navTo(visibleIds[idx + 1], false) // descend to the first child
      }
    } else if (k === 'ArrowLeft') {
      e.preventDefault()
      if (cur === undefined) return navTo(visibleIds[0], false)
      if (rowInfo.get(cur)?.hasChildren && !collapsed.has(cur)) toggleCollapse(cur) // collapse
      else navTo(partParent.get(cur), false) // ascend to the parent
    }
  }

  // What the tree should keep in view: the rig node if one is selected (author mode selects the node
  // it just added), else the last-selected part. One key, because `renderRows` addresses both kinds
  // the same way. With the list windowed, "scroll to it" is also what mounts it.
  const scrollTargetKey =
    state.selectedRigNode !== null && state.selectedRigNode !== undefined
      ? rigNodeKey(state.selectedRigNode.partId, state.selectedRigNode.linkName)
      : lastSelected
  // Bring the row `key` addresses on screen, a frame from now; returns the cancel.
  //
  // Deferred a frame: the effects below flush inside the same task as a commit's syncScene - on a bulk
  // duplicate that task is already the heaviest frame of the gesture. A rAF later is invisible for a
  // scroll and keeps the work off the commit frame.
  //
  // Index arithmetic, not element.scrollIntoView(): the row may not be mounted (the list is
  // windowed), and scrollIntoView on a row that happens to be mounted also forces a synchronous
  // layout of the whole panel. `block: 'nearest'` semantics by hand - scroll only when the row is
  // outside the viewport, and only far enough to bring it to the near edge.
  const revealRow = useCallback((key: string) => {
    const raf = requestAnimationFrame(() => {
      const el = treeRef.current
      const idx = renderRowsRef.current.findIndex((r) => r.key === key)
      if (!el || idx < 0) return
      const pitch = rowPitch.current
      const top = idx * pitch
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + pitch > el.scrollTop + el.clientHeight) el.scrollTop = top + pitch - el.clientHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [])
  // A part picked in the viewport can sit under a collapsed ancestor: open the path once per new pick.
  // Keyed on the pick, not the collapse set, so collapsing a parent of the selection later stays collapsed.
  useEffect(() => {
    if (lastSelected !== undefined) expandAncestors(lastSelected)
  }, [lastSelected, expandAncestors])
  // whether the target has a row yet: the expansion above lands a render later, and the reveal re-runs then
  const targetListed = useMemo(
    () => scrollTargetKey !== undefined && renderRows.some((r) => r.key === scrollTargetKey),
    [renderRows, scrollTargetKey],
  )
  useEffect(
    () => (scrollTargetKey === undefined || !targetListed ? undefined : revealRow(scrollTargetKey)),
    [scrollTargetKey, targetListed, revealRow],
  )
  // Move Up / Move Down keeps the selection, so the effect above does not run: follow the row on request
  const scrollTargetRef = useRef(scrollTargetKey)
  scrollTargetRef.current = scrollTargetKey
  useEffect(() => {
    let cancel: (() => void) | undefined
    const off = store.onRevealTreeSelection(() => {
      const key = scrollTargetRef.current
      if (key === undefined) return
      cancel?.()
      cancel = revealRow(key)
    })
    return () => {
      off()
      cancel?.()
    }
  }, [store, revealRow])
  // a rename can open on a row that isn't on screen (F2 after a viewport pick, which may also have just
  // expanded its ancestors): the input is kept mounted off-window, so scroll it to where it's typed into
  useEffect(() => (renamingKey === null ? undefined : revealRow(renamingKey)), [renamingKey, revealRow])

  // the rename shortcut (edit.rename, F2 by default) renames the single selected part
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (resolveKeyAction(e, 'editor') !== 'edit.rename' || state.running || state.selectedIds.length !== 1) return
      // a code editor or the ladder find bar keeps F2 even on one of its buttons: opening a part rename there
      // took the keyboard out of the panel
      if (keyBelongsToTarget(e)) return
      e.preventDefault()
      beginRename(state.selectedIds[0]!)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.running, state.selectedIds, beginRename])

  // while the context menu is open, Esc closes it without also clearing the
  // selection - capture phase wins over the controller's window keydown
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      setMenu(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menu])

  const onRowClick = useCallback(
    (e: ReactMouseEvent, id: string) => {
      if (live.current.renamingId !== null) return
      treeRef.current?.focus({ preventScroll: true }) // so arrow-key navigation works after a click
      if (e.ctrlKey || e.metaKey) {
        store.toggleSelect(id)
        anchor.current = id
      } else if (e.shiftKey && anchor.current !== null) {
        const ids = live.current.visibleIds
        const a = ids.indexOf(anchor.current)
        const b = ids.indexOf(id)
        if (a === -1) {
          store.select(id)
          anchor.current = id
        } else {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          store.selectMany(ids.slice(lo, hi + 1))
        }
      } else {
        store.select(id)
        anchor.current = id
      }
    },
    [store],
  )

  const onRowContextMenu = useCallback(
    (e: ReactMouseEvent, id: string) => {
      e.preventDefault()
      if (live.current.renamingId !== null) return
      if (!live.current.selectedIds.includes(id)) {
        store.select(id)
        anchor.current = id
      }
      const part = live.current.partsById.get(id)
      if (part) setMenu({ x: e.clientX, y: e.clientY, src: { kind: 'part', part, depth: 0 } })
    },
    [store],
  )

  // Author-mode rig-node context menu (right-click a rig row): select the link, then open the same menu as a
  // scene row - it builds the link's TreeNode and shows only the capability-appropriate items.
  const onRigRowContextMenu = useCallback(
    (e: ReactMouseEvent, partId: string, linkName: string) => {
      e.preventDefault()
      if (live.current.renamingRig !== null) return
      store.selectRigNode(partId, linkName)
      const part = live.current.partsById.get(partId)
      const geometry = part ? rigGeometryOf(part) : null
      const link = geometry?.links.find((l) => l.name === linkName)
      if (geometry && link) setMenu({ x: e.clientX, y: e.clientY, src: { kind: 'rigLink', partId, link, geometry, depth: 0 } })
    },
    [store],
  )

  // The single TreeRow hands its identity back as a RowDesc; these stable dispatchers route to the
  // existing part handlers or the rig (package/store) ones by kind, so one row serves both without the model
  // object (which is rebuilt each render) ever crossing the memo boundary.
  const onRowClickDesc = useCallback(
    (e: ReactMouseEvent, desc: RowDesc) => (desc.kind === 'part' ? onRowClick(e, desc.id) : onSelectRig(desc.partId, desc.linkName)),
    [onRowClick, onSelectRig],
  )
  const onRowContextMenuDesc = useCallback(
    (e: ReactMouseEvent, desc: RowDesc) => (desc.kind === 'part' ? onRowContextMenu(e, desc.id) : onRigRowContextMenu(e, desc.partId, desc.linkName)),
    [onRowContextMenu, onRigRowContextMenu],
  )
  const onBeginRenameDesc = useCallback(
    (desc: RowDesc) => (desc.kind === 'part' ? beginRename(desc.id) : beginRenameRig(desc.partId, desc.linkName)),
    [beginRename, beginRenameRig],
  )
  // `hidden`/`locked` are the desired new states (the row passes `!current`)
  const onSetHiddenDesc = useCallback(
    (desc: RowDesc, hidden: boolean) => {
      if (desc.kind === 'part') return store.setVisible([desc.id], !hidden)
      const part = live.current.partsById.get(desc.partId)
      if (controller && part?.type === 'part') controller.setRigLinkHidden((part as SdkPart).packageId, desc.linkName, hidden)
    },
    [store, controller],
  )
  const onSetLockedDesc = useCallback(
    (desc: RowDesc, locked: boolean) => (desc.kind === 'part' ? store.setLocked([desc.id], locked) : store.setRigNodeLocked(desc.partId, desc.linkName, locked)),
    [store],
  )

  const sel = useMemo(() => new Set(state.selectedIds), [state.selectedIds])

  return (
    <div className={`scene-tree-panel${defScope ? ' definition-scope' : ''}`}>
      <div className="scene-tree-head">
        {defScope ? (
          // editing a definition (a part package): make the blast radius impossible to miss.
          // Two lines so the name (the only variable info) gets the full dock width: badge + session
          // actions on top, name + count below. The count chip renders only when instances exist -
          // with none placed there is no blast radius to warn about; the tooltip still carries it.
          <div className="scene-def-scope" title={t(M.defScopeTitle, { instances: instLabel })}>
            <div className="scene-def-scope-top">
              <span className="scene-def-scope-badge"><PencilIcon size="1em" /> {t(M.definition)}</span>
              <button className="scene-def-scope-back" title={t(M.backTitle)} onClick={back}>
                <ChevronIcon dir="left" /> {t(M.scene)}
              </button>
            </div>
            <div className="scene-def-scope-label">
              <span className="scene-def-scope-name">{defName}</span>
              {instCount > 0 && (
                <span className="scene-def-scope-count" title={t(M.instancesUpdate, { instances: instLabel })}>
                  {instLabel}
                </span>
              )}
            </div>
          </div>
        ) : focusedPart ? (
          // inspecting one placement (part-focus): scene-scoped, a plain breadcrumb
          <button className="scene-breadcrumb" title={t(M.backTitle)} onClick={back}>
            <span className="scene-breadcrumb-back"><ChevronIcon dir="left" /> {t(M.scene)}</span>
            <span className="scene-breadcrumb-sep"><ChevronIcon /></span>
            <span className="scene-breadcrumb-part">{displayNames.get(focusedPart.id) ?? focusedPart.id}</span>
          </button>
        ) : (
          <h2>{t(M.scene)}</h2>
        )}
        <div className="scene-filter-row">
          <input
            className="scene-filter"
            value={filter}
            placeholder={t(M.filter)}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter('')
            }}
          />
          <button
            className={`tree-types-toggle${state.treeTypes ? ' active' : ''}`}
            title={state.treeTypes ? t(M.hideTypes) : t(M.showTypes)}
            aria-pressed={state.treeTypes}
            onClick={() => store.toggleTreeTypes()}
          >
            <TypeTagIcon />
          </button>
        </div>
      </div>
      <div
        className="scene-tree"
        ref={treeRef}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        onClick={(e) => {
          if (e.target === e.currentTarget) store.clearSelection()
        }}
        onDragOver={onTreeDragOver}
        onDrop={onTreeDrop}
        onScroll={onTreeScroll}
      >
        {state.scene.parts.length === 0 && <p className="tree-hint">{t(M.empty)}</p>}
        {state.scene.parts.length > 0 && treeRows.length === 0 && <p className="tree-hint">{t(M.noMatch)}</p>}
        {/* the rows above/below the window, as height only - they hold the scrollbar's extent */}
        {padTop > 0 && <div style={{ height: padTop, flex: 'none' }} aria-hidden="true" />}
        {windowRows.map((row) => {
          if (row.kind === 'rig') {
            const { part, link, joint, depth: rigDepth } = row
            const ren = renamingRig?.partId === part.id && renamingRig.linkName === link.name
            const badges = nodeBadges(part, link)
            return (
              <TreeRow
                key={row.key}
                kind="rigLink"
                rowId={row.key}
                partId={part.id}
                linkName={link.name}
                label={link.name}
                depth={rigDepth}
                icon={joint ? (joint.type === 'revolute' ? 'revolute' : 'prismatic') : 'node'}
                typeLabel={state.treeTypes ? (joint ? joint.name : shapeLabel(link.shape)) : ''}
                rowTitle={[joint ? `${joint.name}: ${joint.type} · ${jointRange(joint, sceneDisplayUnits(state.scene))}` : shapeLabel(link.shape), ...badges.why].join('\n')}
                nodeBadges={badges.tags}
                hasChildren={false}
                grouped={false}
                hasScript={false}
                isOpenScene={false}
                selected={state.selectedRigNode?.partId === part.id && state.selectedRigNode.linkName === link.name}
                renaming={ren}
                renameText={ren ? rigText : ''}
                hidden={link.hidden === true}
                rowHidden={link.hidden === true}
                locked={state.lockedRigNodes.has(row.key)}
                canHide
                canLock
                dropPos={null}
                collapsed={false}
                canReorder={false}
                running={state.running}
                onRowClick={onRowClickDesc}
                onRowContextMenu={onRowContextMenuDesc}
                onBeginRename={onBeginRenameDesc}
                onToggleCollapse={toggleCollapse}
                onSetLocked={onSetLockedDesc}
                onSetHidden={onSetHiddenDesc}
                onVisiblePointerDown={onVisiblePointerDown}
                onRowPointerEnter={onRowPointerEnter}
                onOpenBehavior={onOpenBehavior}
                onOpenScene={onOpenScene}
                onDragStart={onDragStart}
                onDragOver={onRowDragOver}
                onDrop={onRowDrop}
                onDragEnd={onDragEnd}
                onRenameChange={setRigText}
                onRenameCommit={commitRenameRig}
                onRenameCancel={cancelRenameRig}
              />
            )
          }
          const { part, depth, hasChildren, open } = row
          const isCustom = part.type === 'part'
          const def = PART_DEFS[part.type]
          // An unnamed part now reads as its type (e.g. "Belt Conveyor 2") rather than its raw id, numbered
          // with an auto suffix across unnamed siblings; a user-given name wins. The type-label subtitle is the part's
          // real package identity (never the generic "Custom Part") and is dropped below when it would merely
          // repeat the label (an unnamed, un-numbered part).
          const displayName = displayNames.get(part.id) ?? part.id
          const typeLabel = isCustom ? getPackage((part as SdkPart).packageId)?.name ?? 'Part' : def.label
          // the opened scene root is already named by the head banner/breadcrumb - its type label would
          // only repeat the part's name while it truncates, so yield the width back. Likewise drop it for
          // an unnamed part whose label already is the type name (no number).
          const typeSub = part.id === focusId || displayName === typeLabel ? '' : typeLabel
          // a custom rig part's internals show as child rows only for the opened part-scene root, whose whole
          // purpose is to edit them, and only in the nested (unfiltered) view; a placed part is one row.
          const showRig = !filtering && isCustom && part.id === focusId
          const rigGeom = showRig ? rigGeometryOf(part) : null
          const hasSceneChildren = hasChildren
          const expandable = hasSceneChildren || !!rigGeom
          return (
              <TreeRow
                key={row.key}
                kind="part"
                rowId={part.id}
                label={displayName}
                depth={depth}
                icon={categoryIcon(isCustom ? packageCategory(getPackage((part as SdkPart).packageId)) : def.category)}
                typeLabel={state.treeTypes ? typeSub : ''}
                // with the type column toggled off, the type stays discoverable on hover
                rowTitle={!state.treeTypes && typeSub ? typeSub : undefined}
                hasChildren={expandable}
                hasScript={isCustom}
                isOpenScene={part.id === focusId}
                selected={sel.has(part.id)}
                renaming={renamingId === part.id}
                renameText={renamingId === part.id ? text : ''}
                hidden={part.visible === false}
                rowHidden={effHidden.has(part.id)}
                locked={part.locked === true}
                grouped={part.grouped === true}
                canHide
                canLock
                dropPos={dropAt?.id === part.id ? dropAt.pos : null}
                collapsed={!open}
                canReorder={canReorder}
                running={state.running}
                forced={forcedParts.has(part.id)}
                controllerBadge={badgeOf.get(part.id)}
                onRowClick={onRowClickDesc}
                onRowContextMenu={onRowContextMenuDesc}
                onBeginRename={onBeginRenameDesc}
                onToggleCollapse={toggleCollapse}
                onSetLocked={onSetLockedDesc}
                onSetHidden={onSetHiddenDesc}
                onVisiblePointerDown={onVisiblePointerDown}
                onRowPointerEnter={onRowPointerEnter}
                onOpenBehavior={onOpenBehavior}
                onOpenScene={onOpenScene}
                onDragStart={onDragStart}
                onDragOver={onRowDragOver}
                onDrop={onRowDrop}
                onDragEnd={onDragEnd}
                onRenameChange={setText}
                onRenameCommit={commitRename}
                onRenameCancel={cancelRename}
              />
          )
        })}
        {padBottom > 0 && <div style={{ height: padBottom, flex: 'none' }} aria-hidden="true" />}
      </div>
      {menu && (
        <SceneTreeMenu
          menu={menu}
          state={state}
          store={store}
          controller={controller}
          onClose={closeMenu}
          beginRename={beginRename}
          beginRenameRig={beginRenameRig}
        />
      )}
    </div>
  )
}
