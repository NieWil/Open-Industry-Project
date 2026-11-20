// The PLC panel's floating WINDOW: where it sits, dragging it by its header, resizing it by its grip, collapsing it,
// and keeping it inside the view. None of it is about the program.
//
// The geometry itself is the store's (editor/program/stProgram.ts): one window, remembered per browser, wherever the panel
// is mounted from.

import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { fitStEditorGeometry, readStEditorGeometry, saveStEditorGeometry, type StEditorGeometry } from '../../program/stProgram'

const VIEW_TOOLBAR = '.viewport-toolbar-wrap'

/**
 * The rectangle the floating window must stay inside: `el` (the 3D view) when it is laid out, else the browser
 * window. It starts below the view's spatial toolbar, keeping the same gap the toolbar keeps from the view's top:
 * the toolbar outranks the window, so a header parked under it could not be grabbed again. Snapped inward to whole
 * pixels, so a fitted window never pokes half a pixel over a dock.
 */
export function floatBounds(el: HTMLElement | null | undefined): StEditorGeometry {
  const r = el?.getBoundingClientRect()
  if (!el || !r || r.width <= 0 || r.height <= 0) return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
  const bar = el.querySelector(VIEW_TOOLBAR)?.getBoundingClientRect()
  const top = bar && bar.height > 0 ? bar.bottom + (bar.top - r.top) : r.top
  const x = Math.ceil(r.left)
  const y = Math.ceil(top)
  return { x, y, w: Math.floor(r.right) - x, h: Math.floor(r.bottom) - y }
}

/** Pointer handlers as a JSX element takes them. */
export interface DragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
}

export interface PlcPanelWindow {
  /** where the floating window is, and how big */
  geom: StEditorGeometry
  collapsed: boolean
  setCollapsed: (f: (was: boolean) => boolean) => void
  /** the window itself, measured when it is collapsed (its header is all that is left) */
  floatRef: RefObject<HTMLDivElement | null>
  /** the header: drag to move, press without moving to collapse */
  header: DragHandlers
  /** the bottom-right grip: drag to resize */
  grip: DragHandlers
}

/** The floating window's own behaviour, for a panel mounted with `docked` false. */
export function usePlcPanelWindow(docked: boolean | undefined, boundsRef?: { readonly current: HTMLElement | null }): PlcPanelWindow {
  const [collapsed, setCollapsedState] = useState(false)
  const [geom, setGeom] = useState(readStEditorGeometry)
  const floatRef = useRef<HTMLDivElement | null>(null)

  // the window stays inside the view: when the view resizes, when the toolbar comes or goes, and when it collapses
  useLayoutEffect(() => {
    if (docked) return
    const fit = (): void => {
      const bounds = floatBounds(boundsRef?.current)
      const shown = collapsed ? floatRef.current?.offsetHeight : undefined
      setGeom((g) => fitStEditorGeometry(g, bounds, shown))
    }
    fit()
    const el = boundsRef?.current
    if (el && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fit)
      ro.observe(el)
      // the toolbar sets the top edge; a drag re-reads it anyway if it comes or goes (pilot mode unmounts it)
      const bar = el.querySelector(VIEW_TOOLBAR)
      if (bar) ro.observe(bar)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [docked, collapsed, boundsRef])

  // drag the panel by its header; a press with no movement falls through to a collapse toggle. The bounds are read
  // once per gesture: nothing the drag does can move the view.
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number; moved: boolean; bounds: StEditorGeometry } | null>(null)
  const header: DragHandlers = {
    onPointerDown: (e) => {
      drag.current = { sx: e.clientX, sy: e.clientY, bx: geom.x, by: geom.y, moved: false, bounds: floatBounds(boundsRef?.current) }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e) => {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true
      if (d.moved) {
        const shown = collapsed ? floatRef.current?.offsetHeight : undefined
        setGeom((g) => fitStEditorGeometry({ ...g, x: d.bx + dx, y: d.by + dy }, d.bounds, shown))
      }
    },
    onPointerUp: (e) => {
      const d = drag.current
      drag.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
      if (d && !d.moved) setCollapsedState((c) => !c)
      else if (d) setGeom((g) => (saveStEditorGeometry(g), g)) // persist the moved window
    },
  }

  // resize from the bottom-right grip; the grip stops at the view's right and bottom edges rather than pushing the
  // window the other way (the fit then only enforces the minimum size)
  const resize = useRef<{ sx: number; sy: number; bw: number; bh: number; bounds: StEditorGeometry } | null>(null)
  const grip: DragHandlers = {
    onPointerDown: (e) => {
      e.stopPropagation()
      resize.current = { sx: e.clientX, sy: e.clientY, bw: geom.w, bh: geom.h, bounds: floatBounds(boundsRef?.current) }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e) => {
      const r = resize.current
      if (!r) return
      const b = r.bounds
      const w = r.bw + (e.clientX - r.sx)
      const h = r.bh + (e.clientY - r.sy)
      setGeom((g) => fitStEditorGeometry({ ...g, w: Math.min(w, b.x + b.w - g.x), h: Math.min(h, b.y + b.h - g.y) }, b))
    },
    onPointerUp: (e) => {
      resize.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
      setGeom((g) => (saveStEditorGeometry(g), g))
    },
  }

  return { geom, collapsed, setCollapsed: setCollapsedState, floatRef, header, grip }
}
