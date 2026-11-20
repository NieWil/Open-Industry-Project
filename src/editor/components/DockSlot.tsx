import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import {
  dockPanelTitle,
  SLOT_LABELS,
  SLOT_ORDER,
  type DockPanelId,
  type DockSlotId,
} from '../dockLayout'
import { ChevronIcon, MaximizeIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('dock', {
  show: 'Show {panel}',
  hide: 'Hide {panel}',
  maximizeTitle: 'Maximize {panel}',
  maximize: 'Maximize panel',
  moveTitle: 'Move this panel to another dock',
  move: 'Move panel',
  moveTo: 'Move “{panel}” to',
  float: 'Float',
  popoutTitle: 'Open in a separate window you can move to another monitor',
  popout: 'Pop out to a window',
})

interface DockSlotProps {
  slot: DockSlotId
  panels: DockPanelId[]
  active: DockPanelId | null
  onActivate: (panel: DockPanelId) => void
  /**
   * Left-click on a tab, when it should do more than activate - every dock passes its
   * fold toggle here. Defaults to `onActivate`. Kept apart from `onActivate` so the right-click
   * path (which activates before opening the move menu) can't collapse the dock under the menu.
   */
  onTabClick?: (panel: DockPanelId) => void
  /** the slot is folded: render the tab strip only (a rolled-up bottom dock or a side rail; see dockLayout) */
  collapsed?: boolean
  /** blow the front panel up to fill the shell below the toolbar (omit to hide the ⛶) */
  onMaximize?: (panel: DockPanelId) => void
  /** which panels are offered a ⛶ (MAXIMIZABLE_PANELS); the button acts on the front tab,
   *  so it appears and disappears as you switch tabs within a slot */
  canMaximize?: (panel: DockPanelId) => boolean
  onMove: (panel: DockPanelId, to: DockSlotId, before?: DockPanelId | null) => void
  /** detach a panel into a floating window (offered only for panels that can float) */
  onFloat?: (panel: DockPanelId) => void
  canFloat?: (panel: DockPanelId) => boolean
  /** detach a panel into an OS window of its own (offered only for panels that can pop out) */
  onPopout?: (panel: DockPanelId) => void
  canPopout?: (panel: DockPanelId) => boolean
  renderPanel: (panel: DockPanelId) => ReactNode
}

// Drag-to-dock is a fine-pointer (desktop) affordance; touch keeps the ▾ menu, which
// also stays as an accessible fallback. Mirrors the IS_COARSE_POINTER gate in controller/gizmo.ts.
const FINE_POINTER =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: fine)').matches
    : true
// Custom DnD payload type: a dragged dock tab. Using a typed key lets a slot validate
// the drag in dragover (where getData is unavailable) and ignore foreign drags.
const DND_TYPE = 'application/x-oip-dock-panel'

/**
 * One dock region (Left / Right / Bottom). Shows a tab strip - one
 * tab per panel docked here - and the active panel's content below. Panels are
 * reorganized by dragging a tab onto another slot (desktop), or via the tab's ▾
 * menu / right-click (also the touch + accessible path). When `collapsed`, only the
 * tab strip renders - the strip has to stay, or the panels in it become unreachable.
 */
export function DockSlot({
  slot,
  panels,
  active,
  onActivate,
  onTabClick,
  collapsed = false,
  onMaximize,
  canMaximize,
  onMove,
  onFloat,
  canFloat,
  onPopout,
  canPopout,
  renderPanel,
}: DockSlotProps) {
  // the panel whose move menu is open (null = closed)
  const [menuFor, setMenuFor] = useState<DockPanelId | null>(null)
  // The move menu is `position: fixed` and placed by hand, because `.dock-slot` is
  // `overflow: hidden`: dropped downward from a dock at the bottom of the window, the list
  // would be clipped mid-item and its last entries (Bottom / Float / Pop out) unreachable.
  // `anchorEl` is whatever opened it: the ▾ button or a right-clicked tab.
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; maxHeight: number } | null>(
    null,
  )
  // a dock tab is being dragged over this slot (drop target highlight)
  const [dragOver, setDragOver] = useState(false)
  // the panel being dragged out of this slot (dim its source tab)
  const [dragging, setDragging] = useState<DockPanelId | null>(null)
  // where a tab drop would insert: before this panel, at the 'end', or no caret.
  // state drives the caret; the ref mirrors it so onDrop reads the latest position
  // synchronously (React may not have committed the last dragover's setState yet).
  const [insertBefore, setInsertBefore] = useState<DockPanelId | 'end' | null>(null)
  const insertRef = useRef<DockPanelId | 'end' | null>(null)
  const setInsert = (v: DockPanelId | 'end' | null): void => {
    insertRef.current = v
    setInsertBefore(v)
  }
  // dragenter/leave fire for child nodes too; count depth so the highlight doesn't flicker
  const dragDepth = useRef(0)

  const toggleMenu = (panel: DockPanelId, anchor: HTMLElement): void => {
    setMenuFor((cur) => (cur === panel ? null : panel))
    setAnchorEl(anchor)
    setMenuPos(null)
  }
  const closeMenu = (): void => {
    setMenuFor(null)
    setAnchorEl(null)
    setMenuPos(null)
  }

  // Place the open menu: drop below the anchor, flip above it when the list doesn't fit there
  // and there is more room up top, and clamp to the window either way (the menu scrolls if
  // neither side is tall enough). Layout effect, so the placement lands before the first paint.
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menuFor || !anchorEl || !menu) return
    const place = (): void => {
      const a = anchorEl.getBoundingClientRect()
      menu.style.maxHeight = '' // measure the list's natural height, not last frame's clamp
      const h = menu.offsetHeight
      const w = menu.offsetWidth
      const GAP = 2
      const MARGIN = 6
      const below = window.innerHeight - a.bottom - GAP - MARGIN
      const above = a.top - GAP - MARGIN
      const flip = h > below && above > below
      const maxHeight = Math.max(80, Math.min(h, flip ? above : below))
      setMenuPos({
        top: flip ? a.top - GAP - maxHeight : a.bottom + GAP,
        left: Math.max(MARGIN, Math.min(a.right - w, window.innerWidth - w - MARGIN)),
        maxHeight,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [menuFor, anchorEl])

  // Esc closes it, like the rest of the shell's transient popups.
  useEffect(() => {
    if (!menuFor) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuFor])
  const front = active ?? panels[0] ?? null
  if (!front) return null

  const targets = SLOT_ORDER.filter((s) => s !== slot)
  // a slot given its own click handler is one that toggles
  const collapsible = onTabClick !== undefined
  const clickTab = onTabClick ?? onActivate

  const isDockDrag = (e: DragEvent): boolean => e.dataTransfer.types.includes(DND_TYPE)
  const onDragEnter = (e: DragEvent): void => {
    if (!isDockDrag(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }
  const onDragOver = (e: DragEvent): void => {
    if (!isDockDrag(e)) return
    e.preventDefault() // required for onDrop to fire
    e.dataTransfer.dropEffect = 'move'
  }
  const onDragLeave = (e: DragEvent): void => {
    if (!isDockDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) {
      setDragOver(false)
      setInsert(null)
    }
  }
  const onDrop = (e: DragEvent): void => {
    if (!isDockDrag(e)) return
    e.preventDefault() // a tab drop stops propagation, so this only fires for the content area = append
    dragDepth.current = 0
    setDragOver(false)
    setInsert(null)
    const panel = e.dataTransfer.getData(DND_TYPE) as DockPanelId
    if (panel) onMove(panel, slot) // append (moveDockPanel guards same-slot)
  }
  // Drop on a specific tab → insert at that position (same-slot reorder or cross-slot insert).
  const onTabDragOver = (e: DragEvent, panel: DockPanelId): void => {
    if (!isDockDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const afterMid = e.clientX > rect.left + rect.width / 2
    const idx = panels.indexOf(panel)
    const target: DockPanelId | 'end' = afterMid ? (panels[idx + 1] ?? 'end') : panel
    setInsert(target === dragging ? null : target) // no caret over the dragged tab's own gap
  }
  const onTabDrop = (e: DragEvent): void => {
    if (!isDockDrag(e)) return
    e.preventDefault()
    e.stopPropagation() // don't also fire the slot-level append
    dragDepth.current = 0
    setDragOver(false)
    const target = insertRef.current
    setInsert(null)
    const panel = e.dataTransfer.getData(DND_TYPE) as DockPanelId
    if (panel) onMove(panel, slot, target === 'end' ? null : target)
  }

  return (
    <div
      className={`dock-slot dock-slot-${slot}${dragOver ? ' drag-over' : ''}${collapsed ? ' collapsed' : ''}`}
      // names the FRONT panel, so the tutorial can spotlight "wherever the PLC panel is showing"
      // without knowing which slot the user docked it in
      data-tutorial={`dock-${front}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="dock-slot-tabs">
        {panels.map((panel, i) => (
          <button
            key={panel}
            type="button"
            className={
              `dock-slot-tab${panel === front ? ' active' : ''}${panel === dragging ? ' dragging' : ''}` +
              `${insertBefore === panel ? ' drop-before' : ''}` +
              `${insertBefore === 'end' && i === panels.length - 1 ? ' drop-after' : ''}`
            }
            draggable={FINE_POINTER}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_TYPE, panel)
              e.dataTransfer.effectAllowed = 'move'
              setDragging(panel)
              closeMenu()
            }}
            onDragEnd={() => {
              setDragging(null)
              setInsertBefore(null)
            }}
            onDragOver={(e) => onTabDragOver(e, panel)}
            onDrop={onTabDrop}
            // the front tab of a collapsible slot is a disclosure toggle, so it carries
            // the expanded state; the others just switch panels
            aria-expanded={collapsible && panel === front ? !collapsed : undefined}
            title={
              collapsible && panel === front
                ? collapsed
                  ? t(M.show, { panel: dockPanelTitle(panel) })
                  : t(M.hide, { panel: dockPanelTitle(panel) })
                : undefined
            }
            onClick={() => clickTab(panel)}
            onContextMenu={(e) => {
              e.preventDefault()
              onActivate(panel)
              toggleMenu(panel, e.currentTarget)
            }}
          >
            {dockPanelTitle(panel)}
          </button>
        ))}
        <span className="dock-slot-tab-spacer" />
        {/* Offered even on a rolled-up bottom dock: "give me the PLC full screen" from a
            strip you already collapsed is the gesture, and restoring returns it rolled up,
            which is where it was. */}
        {onMaximize && canMaximize?.(front) && (
          <button
            type="button"
            className="dock-slot-max-btn"
            title={t(M.maximizeTitle, { panel: dockPanelTitle(front) })}
            aria-label={t(M.maximize)}
            onClick={() => onMaximize(front)}
          >
            <MaximizeIcon />
          </button>
        )}
        <button
          type="button"
          className="dock-slot-menu-btn"
          title={t(M.moveTitle)}
          aria-label={t(M.move)}
          onClick={(e) => toggleMenu(front, e.currentTarget)}
        >
          <ChevronIcon dir="down" />
        </button>
        {menuFor && (
          <>
            <div className="dock-menu-backdrop" onPointerDown={closeMenu} />
            <div
              className="dock-move-menu"
              role="menu"
              ref={menuRef}
              style={
                menuPos
                  ? { top: menuPos.top, left: menuPos.left, maxHeight: menuPos.maxHeight }
                  : { top: 0, left: 0, visibility: 'hidden' }
              }
            >
              <div className="dock-move-menu-label">{t(M.moveTo, { panel: dockPanelTitle(menuFor) })}</div>
              {targets.map((to) => (
                <button
                  key={to}
                  type="button"
                  className="dock-move-menu-item"
                  role="menuitem"
                  onClick={() => {
                    onMove(menuFor, to)
                    closeMenu()
                  }}
                >
                  {SLOT_LABELS[to]}
                </button>
              ))}
              {onFloat && canFloat?.(menuFor) && (
                <button
                  type="button"
                  className="dock-move-menu-item dock-move-menu-float"
                  role="menuitem"
                  onClick={() => {
                    onFloat(menuFor)
                    closeMenu()
                  }}
                >
                  {t(M.float)}
                </button>
              )}
              {/* the only entry that leaves this window, hence the separate label: everything
                  above rearranges the app, this hands the panel to the OS */}
              {onPopout && canPopout?.(menuFor) && (
                <button
                  type="button"
                  className="dock-move-menu-item dock-move-menu-float"
                  role="menuitem"
                  title={t(M.popoutTitle)}
                  onClick={() => {
                    onPopout(menuFor)
                    closeMenu()
                  }}
                >
                  {t(M.popout)}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {!collapsed && <div className="dock-slot-content">{renderPanel(front)}</div>}
    </div>
  )
}
