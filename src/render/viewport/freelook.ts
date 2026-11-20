import { Vector3 } from 'three'
import type { PerspectiveCamera } from 'three'
import { keyBelongsToControl, resolveKeyAction } from '../../core/keymap'
import type { KeyActionId } from '../../core/keymap'

const SENSITIVITY = (0.25 * Math.PI) / 180
const PITCH_LIMIT = (89 * Math.PI) / 180
const BASE_SPEED = 5
const SPEED_FACTOR = 1.15
const SPEED_MIN = 0.2
const SPEED_MAX = 50
const BOOST = 3

export interface FreelookCallbacks {
  onStart?: () => void
  onEnd?: () => void
  /**
   * true while the editor camera projects orthographically. Freelook doesn't
   * work in an orthogonal view - the RMB look gesture degrades to a view-plane pan
   * and the Shift+F fly toggle doesn't engage - flying a
   * parallel projection reads as nothing moving.
   */
  isOrthographic?: () => boolean
  /** the ortho pan fallback: slide the camera rig along the view plane by a css-px delta */
  panBy?: (dxPx: number, dyPx: number) => void
  /** an ortho pan gesture began: the view drops focus/follow animations that would fight it */
  onPanStart?: () => void
  /** the wheel changed the fly speed (m/s, before any boost), so the view can show it */
  onSpeedChange?: (speed: number) => void
}

/**
 * Freelook: hold RMB over the canvas to fly, or press Shift+F to
 * toggle a button-free flight. Mouse
 * yaws/pitches, WASD moves along the look ray, Q/E down/up (world Y), Shift or
 * Space boosts, wheel scales the base speed, Esc (or Shift+F again) ends it.
 *
 * Uses the Pointer Lock API (like the orbit gizmo) so a sweep is unbounded by
 * the screen edge: while locked we yaw/pitch from relative movementX/Y. We
 * accept Chrome's "press Esc" toast for that. If a browser refuses the lock we
 * fall back to CSS-hidden-cursor client-coordinate deltas (bounded by the edge).
 */
export class Freelook {
  private readonly canvas: HTMLCanvasElement
  private readonly camera: PerspectiveCamera
  private readonly callbacks: FreelookCallbacks
  /** the fly actions currently held (`fly.forward`…), not raw letters: the keymap resolves the
   *  press by physical key, so WASD stays a cluster on AZERTY/QWERTZ instead of scattering */
  private readonly keys = new Set<KeyActionId>()
  private readonly forward = new Vector3()
  private readonly move = new Vector3()
  private readonly right = new Vector3()
  private yaw = 0
  private pitch = 0
  private speed = BASE_SPEED
  private boosting = false
  // boost keys currently held (Shift and/or Space); boosting = set non-empty, so
  // releasing one while the other is held keeps the boost on
  private readonly boostKeys = new Set<string>()
  private lastX = 0
  private lastY = 0
  private isActive = false
  private suspended = false
  private disposed = false
  // RMB is physically held for a freelook gesture. Tracked apart from isActive:
  // if the pointer lock drops mid-flight, onLockChange ends the flight (isActive
  // false) while the button is still down, and Firefox - now unlocked - fires a
  // contextmenu we must still swallow.
  private rmbDown = false
  // an RMB freelook gesture is awaiting its (suppressed) contextmenu event
  private flyContextMenu = false
  private flyMenuTimer = 0
  // the RMB gesture is the orthographic view-plane pan, not a flight (see isOrthographic)
  private panning = false

  constructor(canvas: HTMLCanvasElement, camera: PerspectiveCamera, callbacks: FreelookCallbacks = {}) {
    this.canvas = canvas
    this.camera = camera
    this.callbacks = callbacks
    // window+capture, not canvas: while the pointer is locked (or just as the
    // lock releases on RMB-up) Firefox can dispatch contextmenu to the document
    // instead of the canvas, where a canvas-only listener never sees it.
    window.addEventListener('contextmenu', this.onContextMenu, true)
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('blur', this.onBlur)
    document.addEventListener('pointerlockchange', this.onLockChange)
  }

  get active(): boolean {
    return this.isActive
  }

  /** the RMB ortho view-plane pan is in progress (see isOrthographic). The view suspends
   *  OrbitControls' per-frame update for its duration, exactly like a flight: a leftover
   *  damped orbit delta applied mid-pan would rotate the rig under the gesture. */
  get isPanning(): boolean {
    return this.panning
  }

  /** pilot mode owns the pointer lock; suspend RMB-fly (and its lock listeners) while it runs */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended
    if (suspended && this.isActive) this.end()
  }

  /**
   * Freelook toggle (Shift+F): start a
   * button-free flight, or end the one in progress. Nothing need be held - Shift+F
   * again, Esc, or losing the pointer lock ends it.
   */
  toggle(): void {
    if (this.isActive) {
      this.end()
      return
    }
    if (this.suspended) return // pilot mode owns the viewport
    if (this.callbacks.isOrthographic?.()) return // no freelook in an orthogonal view
    this.begin()
  }

  private get locked(): boolean {
    return document.pointerLockElement === this.canvas
  }

  update(dt: number): void {
    if (!this.isActive) return
    const m = this.move.set(0, 0, 0)
    this.forward.set(
      -Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      -Math.cos(this.pitch) * Math.cos(this.yaw),
    )
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    if (this.keys.has('fly.forward')) m.add(this.forward)
    if (this.keys.has('fly.back')) m.sub(this.forward)
    if (this.keys.has('fly.right')) m.add(this.right)
    if (this.keys.has('fly.left')) m.sub(this.right)
    if (this.keys.has('fly.up')) m.y += 1
    if (this.keys.has('fly.down')) m.y -= 1
    if (m.lengthSq() < 1e-12) return
    m.normalize().multiplyScalar(this.speed * (this.boosting ? BOOST : 1) * dt)
    this.camera.position.add(m)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.endPan()
    this.end()
    window.clearTimeout(this.flyMenuTimer)
    window.removeEventListener('contextmenu', this.onContextMenu, true)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('blur', this.onBlur)
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }

  // Losing focus (alt-tab) drops the lock and can swallow the RMB pointerup, which
  // would otherwise leave rmbDown stuck on and suppress every later menu. Reset.
  private onBlur = (): void => {
    this.rmbDown = false
    this.flyContextMenu = false
    window.clearTimeout(this.flyMenuTimer)
    this.endPan()
    this.end()
  }

  private endPan(): void {
    if (!this.panning) return
    this.panning = false
    this.canvas.style.cursor = ''
  }

  // Suppress the browser menu over the canvas and for any RMB freelook gesture.
  // Gated (not a blanket window suppressor) so native menus on inspector inputs
  // still work. rmbDown covers a mid-flight contextmenu after the lock drops;
  // flyContextMenu covers the post-release one Firefox retargets to the document.
  private onContextMenu = (e: Event): void => {
    if (this.rmbDown || this.isActive || this.flyContextMenu || e.target === this.canvas) {
      e.preventDefault()
      this.flyContextMenu = false
      window.clearTimeout(this.flyMenuTimer)
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.suspended) return
    // Alt+RMB is the list-select gesture, not freelook: yield it (the editor
    // controller consumes it). Alt is checked before entering freelook.
    if (e.button !== 2 || this.isActive || this.panning || e.altKey) return
    this.rmbDown = true
    this.lastX = e.clientX
    this.lastY = e.clientY
    // orthogonal view: the look gesture pans the view plane instead.
    // No pointer lock - the drag is bounded like any pan.
    if (this.callbacks.isOrthographic?.()) {
      this.panning = true
      this.canvas.style.cursor = 'grabbing'
      this.callbacks.onPanStart?.()
      return
    }
    this.begin()
    // Space can't be read off a pointer event; if it's pre-held, its keydown
    // (or the user re-pressing it) starts the boost. Shift is available here.
    if (e.shiftKey) {
      this.boostKeys.add('shift')
      this.boosting = true
    }
  }

  /** common flight setup: seed yaw/pitch from the camera, hide the cursor, grab the lock */
  private begin(): void {
    this.isActive = true
    this.keys.clear()
    this.boostKeys.clear()
    this.boosting = false
    this.camera.getWorldDirection(this.forward)
    this.pitch = Math.asin(Math.max(-1, Math.min(1, this.forward.y)))
    this.yaw = Math.atan2(-this.forward.x, -this.forward.z)
    this.canvas.style.cursor = 'none'
    // capture the cursor so a sweep is unbounded; movementX/Y drive the look
    const req = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
    req?.catch?.(() => {})
    this.callbacks.onStart?.()
  }

  private onPointerUp = (e: PointerEvent): void => {
    // A toggled (Shift+F) flight has no RMB to release: rmbDown is false, so leave it
    // flying. Only an RMB-initiated flight (or its post-end Firefox menu) reaches here.
    if (e.button !== 2 || !this.rmbDown) return
    // The contextmenu fires right after this release and Firefox may target it
    // at the document (the lock is exiting), where the canvas check and isActive
    // both miss it. Arm the flag here, not on pointerdown: a multi-second flight
    // would outlive any pointerdown timer and leak the menu. Short fallback so a
    // release that never emits a contextmenu can't eat a later, unrelated menu.
    this.flyContextMenu = true
    window.clearTimeout(this.flyMenuTimer)
    this.flyMenuTimer = window.setTimeout(() => {
      this.flyContextMenu = false
    }, 500)
    this.rmbDown = false
    if (this.panning) {
      this.endPan()
      return
    }
    this.end()
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.panning) {
      const dx = e.clientX - this.lastX
      const dy = e.clientY - this.lastY
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.callbacks.panBy?.(dx, dy)
      return
    }
    if (!this.isActive) return
    // locked: relative movement deltas (clientX/Y are frozen). The lastClient
    // fallback covers the frames before the lock engages and a refused lock.
    const dx = this.locked ? e.movementX : e.clientX - this.lastX
    const dy = this.locked ? e.movementY : e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.yaw -= dx * SENSITIVITY
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dy * SENSITIVITY))
    this.applyRotation()
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.isActive) return
    e.preventDefault()
    e.stopPropagation()
    const factor = e.deltaY < 0 ? SPEED_FACTOR : 1 / SPEED_FACTOR
    this.speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, this.speed * factor))
    // reported at the limits too: a notch that changes nothing still says where it stopped
    this.callbacks.onSpeedChange?.(this.speed)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Shift+F freelook toggle. Handled before the active guard so it can also
    // start a flight, and in the capture phase with stopPropagation so the editor's
    // plain-F "focus selection" shortcut never fires for the same press. e.repeat
    // guards against an auto-repeat flicker; a focused text field keeps its Shift+F, by the
    // rule every editor shortcut asks (keyBelongsToControl), so a checkbox a click left
    // focused does not swallow it.
    // The toggle is in the editor keymap (it's pressed from the editor); only the
    // movement below is 'fly' mode.
    if (!e.repeat && resolveKeyAction(e, 'editor') === 'camera.freelook') {
      if (!this.isActive && e.target instanceof HTMLElement && keyBelongsToControl(e, e.target)) return
      this.toggle()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (this.panning && e.key === 'Escape') {
      this.endPan()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (!this.isActive) return
    if (e.key === 'Escape') {
      this.end()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const action = resolveKeyAction(e, 'fly')
    if (!action) return
    if (action === 'fly.boost') {
      // keyed by the legend, lower-cased ('shift' / ' ') - the RMB path seeds a pre-held Shift
      // the same way, and this key can't move under a layout
      this.boostKeys.add(e.key.toLowerCase())
      this.boosting = true
      e.preventDefault()
      return
    }
    this.keys.add(action)
    e.preventDefault()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.isActive) return
    const action = resolveKeyAction(e, 'fly')
    if (!action) return
    if (action === 'fly.boost') {
      this.boostKeys.delete(e.key.toLowerCase())
      this.boosting = this.boostKeys.size > 0
      e.preventDefault()
      return
    }
    this.keys.delete(action)
    e.preventDefault()
  }

  private applyRotation(): void {
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.set(this.pitch, this.yaw, 0)
  }

  private end(): void {
    if (!this.isActive) return
    this.isActive = false
    this.keys.clear()
    this.boostKeys.clear()
    this.boosting = false
    this.canvas.style.cursor = ''
    if (this.locked) document.exitPointerLock()
    this.callbacks.onEnd?.()
  }

  // Escape (or any external exit) drops the lock without an RMB release; stop
  // flying then. Also covers a fast RMB tap whose lock engages after we stopped.
  private onLockChange = (): void => {
    if (this.suspended) return // pilot mode owns the lock; don't steal it back
    if (this.locked) {
      if (!this.isActive) document.exitPointerLock()
      return
    }
    if (this.isActive) this.end()
  }
}
