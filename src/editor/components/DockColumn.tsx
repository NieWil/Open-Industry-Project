import type { ReactNode } from 'react'
import { DockSlot } from './DockSlot'
import { ResizeGutter } from './ResizeGutter'
import { columnOf, isColumnCollapsed, type DockLayout, type DockPanelId, type DockSide, type DockSlotId } from '../dockLayout'

interface DockColumnProps {
  side: DockSide
  /** the Top and Bottom sub-slots that make up this column */
  topId: DockSlotId
  bottomId: DockSlotId
  /** CSS grid-area this column occupies (e.g. 'leftA', 'rightB') */
  gridArea: string
  layout: DockLayout
  /** height (px) of the Top sub-slot when the column is split Top/Bottom */
  topSize: number
  /** custom property carrying `topSize` (see `dockSizeVar`) - lets the split gutter resize
   *  the pane live without re-rendering the panels inside it */
  sizeVar: string
  onResizeSplit: (px: number) => void
  onActivate: (panel: DockPanelId) => void
  /** a LEFT-click on a tab, when that is more than activating it (the PLC tab opens in a window of its own) */
  onTabClick?: (panel: DockPanelId) => void
  onMaximize?: (panel: DockPanelId) => void
  canMaximize?: (panel: DockPanelId) => boolean
  onMove: (panel: DockPanelId, to: DockSlotId, before?: DockPanelId | null) => void
  onFloat?: (panel: DockPanelId) => void
  canFloat?: (panel: DockPanelId) => boolean
  onPopout?: (panel: DockPanelId) => void
  canPopout?: (panel: DockPanelId) => boolean
  renderPanel: (panel: DockPanelId) => ReactNode
}

/**
 * One dock column, split horizontally into a Top and Bottom sub-slot. When both
 * hold panels they're shown stacked with a draggable divider; when only one is
 * occupied it fills the whole column. Each side has up to two of these columns. Folded, it is a
 * rail: each sub-slot's tabs turned on end, one after the other, and no split to drag.
 */
export function DockColumn({
  side,
  topId,
  bottomId,
  gridArea,
  layout,
  topSize,
  sizeVar,
  onResizeSplit,
  onActivate,
  onTabClick,
  onMaximize,
  canMaximize,
  onMove,
  onFloat,
  canFloat,
  onPopout,
  canPopout,
  renderPanel,
}: DockColumnProps) {
  const top = layout[topId]
  const bottom = layout[bottomId]
  const hasTop = top.length > 0
  const hasBottom = bottom.length > 0
  // folded to a rail (see `clickSideDockTab`): both sub-slots show their tabs only, stacked
  const column = columnOf(topId)
  const collapsed = column !== null && isColumnCollapsed(layout, column)
  const split = hasTop && hasBottom && !collapsed

  const slot = (id: DockSlotId, panels: DockPanelId[]): ReactNode => (
    <DockSlot
      slot={id}
      panels={panels}
      active={layout.active[id]}
      collapsed={collapsed}
      onActivate={onActivate}
      onTabClick={onTabClick}
      onMaximize={onMaximize}
      canMaximize={canMaximize}
      onMove={onMove}
      onFloat={onFloat}
      canFloat={canFloat}
      onPopout={onPopout}
      canPopout={canPopout}
      renderPanel={renderPanel}
    />
  )

  return (
    <div className={`dock-column dock-column-${side}${collapsed ? ' collapsed' : ''}`} style={{ gridArea }}>
      {hasTop && (
        <div
          className="dock-column-pane"
          // the var (set on the app root) is what the gutter moves live; the committed px is
          // the fallback, so the pane is correct before any drag has happened
          style={
            collapsed ? { flex: '0 0 auto' } : split ? { flex: `0 0 var(${sizeVar}, ${topSize}px)` } : { flex: '1 1 auto' }
          }
        >
          {slot(topId, top)}
        </div>
      )}
      {split && (
        <ResizeGutter
          className="gutter gutter-split"
          axis="y"
          sign={1}
          value={topSize}
          cssVar={sizeVar}
          onResize={onResizeSplit}
          min={96}
          max={900}
        />
      )}
      {hasBottom && (
        <div className="dock-column-pane" style={{ flex: collapsed ? '0 0 auto' : '1 1 auto' }}>
          {slot(bottomId, bottom)}
        </div>
      )}
    </div>
  )
}
