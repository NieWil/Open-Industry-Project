// The ladder sheet's own layout (LadderView.tsx): its zoom, which rungs are in view, and the wire that joins a rung's
// wrapped rows. Each works on the sheet's DOM through the refs LadderView renders, not through React state.

import type { LadderRoutine } from '../../../plc/ladder/ladderRungs'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** How far the sheet scales, and by how much a wheel notch or a key moves it. */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2.5
export const ZOOM_STEP = 1.1

/** An element, whichever window it belongs to: a popped-out panel's nodes are another window's class. */
export const isEl = (x: unknown): x is HTMLElement => !!x && typeof x === 'object' && (x as Node).nodeType === 1

/** Ctrl+wheel and the ladder.zoom* keys scale the drawing; remembered per browser. `empty`: no routine is drawn. */
export function useLadderZoom(rootRef: RefObject<HTMLDivElement | null>, scrollRef: RefObject<HTMLDivElement | null>, zoomRef: RefObject<HTMLDivElement | null>, empty: boolean) {
  const [zoom, setZoom] = useState(() => {
    try {
      const z = Number(localStorage.getItem('oip.ladderZoom'))
      return z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1
    } catch {
      return 1
    }
  })
  const zoomNow = useRef(zoom)
  /** Paint a scale onto the DOM, keeping the scroll where it was. Returns it, or null if it did not move. */
  const paintZoom = useCallback((to: number): number | null => {
    const was = zoomNow.current
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(to * 100) / 100))
    if (next === was) return null
    zoomNow.current = next
    const scroller = scrollRef.current
    const sheet = zoomRef.current
    if (sheet) sheet.style.setProperty('zoom', String(next))
    if (scroller) {
      scroller.dataset.zoom = String(next)
      scroller.scrollTop = (scroller.scrollTop * next) / was
      scroller.scrollLeft = (scroller.scrollLeft * next) / was
    }
    return next
  }, [])
  const rememberZoom = useCallback((next: number): void => {
    setZoom(next)
    try {
      localStorage.setItem('oip.ladderZoom', String(next))
    } catch {
      // private mode
    }
  }, [])
  /** A whole step, from a key or the readout. There is no wheel storm to debounce, so it lands at once. */
  const stepZoom = useCallback((to: number): void => {
    const next = paintZoom(to)
    if (next !== null) rememberZoom(next)
  }, [paintZoom, rememberZoom])
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    // native, and not passive: React's wheel listener is passive, and could not keep the browser's own Ctrl+wheel (page
    // zoom) from firing too. A step goes straight to the DOM (one style on one element); React hears of the new zoom
    // once the wheel has settled, since re-rendering a whole routine per step is what makes zooming crawl.
    let settle = 0
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const next = paintZoom(zoomNow.current * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
      if (next === null) return
      window.clearTimeout(settle)
      settle = window.setTimeout(() => rememberZoom(next), 250)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.clearTimeout(settle)
      el.removeEventListener('wheel', onWheel)
    }
  }, [empty, paintZoom, rememberZoom])
  return { zoom, zoomNow, stepZoom }
}

/**
 * Which rungs are in (or near) view, as `routine/rung`: null until the observer has reported, which reads as "all of
 * them". Only `liveSig` asks - what a rung shows of the PROGRAM is drawn wherever the rung is.
 */
export function useRungsInView(scrollRef: RefObject<HTMLDivElement | null>, routines: readonly LadderRoutine[]): RefObject<Set<string> | null> {
  const inView = useRef<Set<string> | null>(null)
  const [, setSeen] = useState(0)
  useEffect(() => {
    const root = scrollRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const seen = new Set<string>()
    inView.current = null
    const observer = new IntersectionObserver(
      (entries) => {
        let came = false
        for (const e of entries) {
          const el = e.target as HTMLElement
          const k = `${el.dataset.rungOf}/${el.dataset.rungIndex}`
          if (e.isIntersecting) {
            if (!seen.has(k)) came = true
            seen.add(k)
          } else seen.delete(k)
        }
        inView.current = seen
        if (came) setSeen((n) => n + 1) // a rung has come into view: draw it with the values of now
      },
      { root, rootMargin: '300px 0px' },
    )
    root.querySelectorAll('[data-testid="ladder-rung"]').forEach((el) => observer.observe(el))
    return () => {
      observer.disconnect()
      inView.current = null
    }
    // (the rungs drawn: an edit that adds or removes one is another set of nodes)
  }, [routines])
  return inView
}

/** Join each wrapped rung's rows with the wire (see below). `empty`: no routine is drawn. */
export function useWrapLinks(scrollRef: RefObject<HTMLDivElement | null>, zoomRef: RefObject<HTMLDivElement | null>, empty: boolean): void {
  // ---- a rung that wraps -----------------------------------------------------------------------------------------
  //
  // A rung's series is a flex row that wraps (styles.css `.ld-wrap`), so a rung longer than the view carries on
  // underneath. What CSS cannot do is join the rows: where a row ends, the wire runs on to the edge, drops, comes back
  // under the row and enters the next one. That takes knowing where the rows fell, so it is measured - for the rungs in
  // view only, reads first and writes after - and drawn into `.ld-links`, a layer React renders empty and never reads.
  const linkWraps = useCallback((): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    const view = scroller.getBoundingClientRect()
    const plans: { layer: HTMLElement; html: string }[] = []
    for (const rung of scroller.querySelectorAll<HTMLElement>('.ld-rung')) {
      const box = rung.getBoundingClientRect()
      if (box.bottom < view.top - 200 || box.top > view.bottom + 200) continue
      const wrap = rung.querySelector<HTMLElement>('.ld-wrap')
      const layer = wrap?.querySelector<HTMLElement>(':scope > .ld-links')
      if (!wrap || !layer) continue
      const items = [...wrap.children].filter((c): c is HTMLElement => isEl(c) && c !== layer && !c.classList.contains('ld-drop'))
      const rows: { top: number; bottom: number; left: number; right: number }[] = []
      for (const it of items) {
        const row = rows.find((r) => Math.abs(r.top - it.offsetTop) <= 2)
        if (!row) rows.push({ top: it.offsetTop, bottom: it.offsetTop + it.offsetHeight, left: it.offsetLeft, right: it.offsetLeft + it.offsetWidth })
        else {
          row.bottom = Math.max(row.bottom, it.offsetTop + it.offsetHeight)
          row.left = Math.min(row.left, it.offsetLeft)
          row.right = Math.max(row.right, it.offsetLeft + it.offsetWidth)
        }
      }
      rows.sort((a, b) => a.top - b.top)
      const W = wrap.clientWidth
      const WIRE = 31 // where the wire runs in a row: `.ld-wire`'s height
      let html = ''
      for (let k = 0; k + 1 < rows.length; k++) {
        const [a, b] = [rows[k]!, rows[k + 1]!]
        const y0 = a.top + WIRE
        const mid = Math.round((a.bottom + b.top) / 2)
        const y1 = b.top + WIRE
        // the run carries on the row's own wire, so it covers the same 2px (wire - 2 to wire; it sat 1px lower, a step
        // at every wrap). It starts 1px back: offsetLeft and offsetWidth are rounded apiece, so the row's measured end can
        // sit up to ~0.7px past its real one, and an overlap cannot show where a gap would
        html += `<i class="ld-link run" style="left:${a.right - 1}px;top:${y0 - 2}px;width:${Math.max(0, W - 3 - a.right)}px"></i>`
        html += `<i class="ld-link back" style="left:4px;top:${y0}px;width:${W - 8}px;height:${mid - y0}px"></i>`
        html += `<i class="ld-link in" style="left:4px;top:${mid}px;width:${Math.max(4, b.left - 4)}px;height:${y1 - mid}px"></i>`
      }
      if (layer.dataset.links !== html) plans.push({ layer, html })
    }
    for (const { layer, html } of plans) {
      layer.innerHTML = html
      layer.dataset.links = html
    }
  }, [])
  useLayoutEffect(() => linkWraps())
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    // the sheet's own window: a popped-out panel keeps drawing while the main window is minimised
    const win = scroller.ownerDocument.defaultView ?? window
    let frame = 0
    const soon = (): void => {
      win.cancelAnimationFrame(frame)
      frame = win.requestAnimationFrame(linkWraps)
    }
    const resized = new ResizeObserver(soon)
    resized.observe(scroller)
    if (zoomRef.current) resized.observe(zoomRef.current)
    scroller.addEventListener('scroll', soon, { passive: true })
    return () => {
      win.cancelAnimationFrame(frame)
      resized.disconnect()
      scroller.removeEventListener('scroll', soon)
    }
  }, [linkWraps, empty])
}
