import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { clamp } from '../../core/math'

/** one dock size a drag moves, along one axis */
export interface ResizeTrack {
  axis: 'x' | 'y'
  /** +1 if dragging toward +axis grows the panel, -1 if it shrinks it */
  sign: 1 | -1
  /**
   * current panel size in px (the committed value; a live drag runs ahead of it), or a function that reads it off the
   * screen when a drag starts - for a track whose committed value is not a px number (the PLC editor's default bottom
   * dock height is a share of the window, see dockLayout's DEFAULT_BOTTOM_HEIGHT)
   */
  value: number | ((gutter: HTMLElement) => number)
  /** commit the new size - called once, on release, not per pointer event */
  onResize: (size: number) => void
  /**
   * Custom property this track drives while dragging (see `dockSizeVar`), e.g. `--dk-left`.
   * Written straight onto the app root each frame, so the track resizes without a React
   * render: the whole editor tree (Inspector, Catalog, SceneTree, ST editor) would otherwise
   * re-render on every pointer event, and only the grid template actually changed. Omit it
   * and the drag falls back to committing per frame instead.
   */
  cssVar?: string
  min: number
  /** px, or read when a drag starts (a limit relative to the window) */
  max: number | ((gutter: HTMLElement) => number)
}

interface ResizeGutterProps extends ResizeTrack {
  /** grid-area + cursor class, e.g. "gutter gutter-left" */
  className: string
  /** optional inline style (e.g. dynamic grid-area for a per-column gutter) */
  style?: CSSProperties
}

/** thin draggable divider that resizes the adjacent dock track */
export function ResizeGutter({ className, style, ...track }: ResizeGutterProps) {
  return (
    <div
      className={className}
      style={style}
      onPointerDown={(e) => startResize(e, [track])}
      role="separator"
      aria-orientation={track.axis === 'x' ? 'vertical' : 'horizontal'}
    />
  )
}

/** the handle where two gutters cross: one drag moves both tracks */
export function ResizeCorner({ className, style, tracks }: { className: string; style?: CSSProperties; tracks: ResizeTrack[] }) {
  return <div className={className} style={style} onPointerDown={(e) => startResize(e, tracks)} aria-hidden="true" />
}

function startResize(e: ReactPointerEvent<HTMLDivElement>, tracks: readonly ResizeTrack[]): void {
  if (e.button !== 0) return
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  const el = e.currentTarget
  // every dock size lives as a custom property on the app root, so both the grid tracks
  // and the (inheriting) column panes follow one write
  const root = el.closest<HTMLElement>('.app')
  const live = tracks.map((t) => {
    const startSize = typeof t.value === 'function' ? t.value(el) : t.value
    return {
      t,
      startSize,
      size: startSize,
      limit: typeof t.max === 'function' ? t.max(el) : t.max,
      writeLive: t.cssVar && root ? (px: number) => root.style.setProperty(t.cssVar!, `${px}px`) : null,
      // what the property held before the drag, for a drag that ends where it started: that commits nothing, so React
      // never rewrites the property, and a frame flushed on the way would otherwise stay on screen - as px, where the
      // committed value may be a share of the window that should keep following it
      before: t.cssVar && root ? root.style.getPropertyValue(t.cssVar) : '',
    }
  })
  el.setPointerCapture(e.pointerId)

  let frame = 0
  // Coalesce to one write per frame. Pointer events can outpace the display, and each write
  // costs a style recalc + a grid layout + a viewport ResizeObserver notification; more than
  // one between paints is wasted.
  const flush = (): void => {
    frame = 0
    for (const l of live) {
      if (l.writeLive) l.writeLive(l.size)
      else l.t.onResize(l.size)
    }
  }
  const onMove = (ev: PointerEvent): void => {
    for (const l of live) {
      const delta = l.t.axis === 'x' ? ev.clientX - startX : ev.clientY - startY
      l.size = clamp(l.startSize + l.t.sign * delta, l.t.min, Math.max(l.t.min, l.limit))
    }
    if (!frame) frame = requestAnimationFrame(flush)
  }
  // a pointercancel (the OS took the pointer, a touch turned into a pan) ends the drag as a release does, else the
  // move listener stays on and the next plain hover keeps resizing
  const onUp = (): void => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    for (const l of live) {
      if (l.size === l.startSize) {
        // a click, or a drag that landed where it started
        if (l.writeLive && l.before) root?.style.setProperty(l.t.cssVar!, l.before)
        continue
      }
      l.writeLive?.(l.size)
      // commit once: React state catches up to the value already on screen (same number, so
      // nothing moves), and the persisted layout follows from there
      l.t.onResize(l.size)
    }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
