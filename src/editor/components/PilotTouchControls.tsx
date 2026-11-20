import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { IRenderView } from '../../render/api'
import type { EditorStore } from '../store/store'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('pilotTouch', {
  use: 'Use',
  exit: 'Exit',
})

/** max thumb travel from the joystick base centre, in CSS px (full deflection = full walk speed).
 *  Picked so travel + the 26px thumb radius == the 66px base radius: the thumb sits flush at the rim. */
const STICK_RADIUS = 40

/**
 * On-screen pilot controls for touch devices: a left-thumb virtual joystick walks (replacing WASD)
 * and a full-screen look pad drags to aim (replacing pointer-lock mouse-look). Use / Exit
 * buttons fill in for E / Esc. Rendered by App only while piloting on a mobile layout, where
 * the editor chrome is hidden - so this overlay owns the screen. Each finger is a separate pointerId:
 * the joystick and buttons capture and stopPropagation their own pointer, leaving any other pointer
 * for the look pad, so walking and looking work simultaneously (two thumbs).
 */
export function PilotTouchControls({
  view,
  store,
  prompt,
}: {
  view: IRenderView
  store: EditorStore
  prompt: string | null
}) {
  // --- movement joystick (bottom-left) ---
  const baseRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const stickId = useRef<number | null>(null)
  const stickOrigin = useRef({ x: 0, y: 0 })

  const setStick = useCallback(
    (dx: number, dy: number) => {
      const len = Math.hypot(dx, dy)
      const scale = len > STICK_RADIUS ? STICK_RADIUS / len : 1
      const tx = dx * scale
      const ty = dy * scale
      if (thumbRef.current) thumbRef.current.style.transform = `translate(${tx}px, ${ty}px)`
      // screen up = walk forward; screen right = strafe right
      view.pilotSetMove(-ty / STICK_RADIUS, tx / STICK_RADIUS)
    },
    [view],
  )

  const onStickDown = useCallback(
    (e: ReactPointerEvent) => {
      e.stopPropagation()
      if (stickId.current !== null || !baseRef.current) return
      stickId.current = e.pointerId
      const r = baseRef.current.getBoundingClientRect()
      stickOrigin.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      e.currentTarget.setPointerCapture(e.pointerId)
      setStick(e.clientX - stickOrigin.current.x, e.clientY - stickOrigin.current.y)
    },
    [setStick],
  )

  const onStickMove = useCallback(
    (e: ReactPointerEvent) => {
      if (e.pointerId !== stickId.current) return
      e.stopPropagation()
      setStick(e.clientX - stickOrigin.current.x, e.clientY - stickOrigin.current.y)
    },
    [setStick],
  )

  const onStickUp = useCallback(
    (e: ReactPointerEvent) => {
      if (e.pointerId !== stickId.current) return
      e.stopPropagation()
      stickId.current = null
      if (thumbRef.current) thumbRef.current.style.transform = ''
      view.pilotSetMove(0, 0)
    },
    [view],
  )

  // --- look pad (drag anywhere not on a control) ---
  const lookId = useRef<number | null>(null)
  const lookLast = useRef({ x: 0, y: 0 })

  const onLookDown = useCallback((e: ReactPointerEvent) => {
    if (lookId.current !== null) return
    lookId.current = e.pointerId
    lookLast.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onLookMove = useCallback(
    (e: ReactPointerEvent) => {
      if (e.pointerId !== lookId.current) return
      view.pilotLook(e.clientX - lookLast.current.x, e.clientY - lookLast.current.y)
      lookLast.current = { x: e.clientX, y: e.clientY }
    },
    [view],
  )

  const onLookUp = useCallback((e: ReactPointerEvent) => {
    if (e.pointerId !== lookId.current) return
    lookId.current = null
  }, [])

  // buttons fire on pointerdown (snappier than click on touch) and must not leak to the look pad
  const tap = (fn: () => void) => (e: ReactPointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    fn()
  }

  return (
    <div
      className="pilot-touch"
      onPointerDown={onLookDown}
      onPointerMove={onLookMove}
      onPointerUp={onLookUp}
      onPointerCancel={onLookUp}
    >
      <div
        className="pilot-touch-stick"
        ref={baseRef}
        onPointerDown={onStickDown}
        onPointerMove={onStickMove}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
      >
        <div className="pilot-touch-thumb" ref={thumbRef} />
      </div>
      <div className="pilot-touch-actions">
        <button className="pilot-touch-btn pilot-touch-use" onPointerDown={tap(() => view.pilotInteract())}>
          {prompt ?? t(M.use)}
        </button>
      </div>
      <button className="pilot-touch-exit" onPointerDown={tap(() => store.exitPilot())}>
        {t(M.exit)}
      </button>
    </div>
  )
}
