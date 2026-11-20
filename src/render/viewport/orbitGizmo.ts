import { Quaternion, Vector3 } from 'three'
import type { PerspectiveCamera } from 'three'

/**
 * The X/Y/Z orbit gizmo in the top-right corner of the 3D editor viewport.
 * It shows the camera orientation
 * as six axis balls; clicking a ball snaps the camera to that orthographic-ish
 * view, and dragging anywhere inside the circle orbits the camera.
 *
 * Drawn with Canvas2D as a DOM overlay sibling of the WebGL canvas in
 * immediate mode: line + filled ball + letter for
 * positive axes, hollow ball + hover-only label for negative axes.
 */

const SIZE = 80 // css px, the rotation control is 80x80
const AXIS_RADIUS = 8 // axis ball radius
const CENTER = SIZE / 2
const ORBIT_RADIUS = SIZE / 2 - AXIS_RADIUS - 2 // ball placement radius
const DRAG_THRESHOLD = 4 // px of motion before a press becomes an orbit drag
const FONT_PX = 11

type RGB = readonly [number, number, number]

// shared with the transform gizmo's axis palette (render/gizmo.ts)
const AXIS_COLORS: readonly RGB[] = [
  [0xe0, 0x66, 0x66], // X
  [0x66, 0xbb, 0x6a], // Y
  [0x55, 0x99, 0xe0], // Z
]

// world axis each ball represents; index 0-2 positive, 3-5 negative. Snapping to
// a ball places the camera on that side looking at the target (view map:
// +X right, +Y top, +Z front, -X left, -Y bottom, -Z rear).
const AXIS_DIRS: readonly Vector3[] = [
  new Vector3(1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 1),
  new Vector3(-1, 0, 0),
  new Vector3(0, -1, 0),
  new Vector3(0, 0, -1),
]
const LETTERS = ['X', 'Y', 'Z', '-X', '-Y', '-Z']

interface Axis2D {
  axis: number // 0-5
  x: number
  y: number
  z: number // view-space depth, +1 toward the camera
  positive: boolean
}

export interface OrbitGizmoCallbacks {
  /** snap the camera to look down `dir` (a unit world axis) toward the target */
  snapToAxis(dir: Vector3): void
  /** orbit the camera around the target by a pointer delta in css px */
  orbitBy(dxPx: number, dyPx: number): void
  /** orbit drag began: snapshot the camera so an aborted orbit can restore it */
  beginOrbit(): void
  /** right-click abort: restore the camera to its pre-orbit pose */
  cancelOrbit(): void
}

function css(c: RGB, a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`
}

function darken(c: RGB, amt: number): RGB {
  const k = 1 - amt
  return [c[0] * k, c[1] * k, c[2] * k]
}

function lighten(c: RGB, amt: number): RGB {
  return [c[0] + (255 - c[0]) * amt, c[1] + (255 - c[1]) * amt, c[2] + (255 - c[2]) * amt]
}

export class OrbitGizmo {
  private readonly container: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly camera: PerspectiveCamera
  private readonly callbacks: OrbitGizmoCallbacks
  private readonly invQuat = new Quaternion()
  private readonly tmp = new Vector3()
  private readonly prevQuat = new Quaternion(2, 0, 0, 0) // invalid → forces first draw
  private readonly axes: Axis2D[] = []
  private dpr = 1
  private focusedAxis = -2 // -2 outside, -1 inside circle, 0-5 a ball
  private dirty = true
  private pressed = false
  private dragging = false
  private pressX = 0
  private pressY = 0
  private lastClientX = 0
  private lastClientY = 0
  private activePointerId = -1
  private disposed = false

  constructor(container: HTMLElement, camera: PerspectiveCamera, callbacks: OrbitGizmoCallbacks) {
    this.container = container
    this.camera = camera
    this.callbacks = callbacks

    const canvas = document.createElement('canvas')
    canvas.className = 'orbit-gizmo'
    this.canvas = canvas
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '8px',
      right: '8px',
      width: `${SIZE}px`,
      height: `${SIZE}px`,
      zIndex: '7',
      cursor: 'default',
      touchAction: 'none',
    })
    container.appendChild(canvas)
    this.ctx = canvas.getContext('2d')!
    this.resize()

    // listeners live on the canvas and rely on pointer capture for the pre-lock
    // frames; once an orbit drag starts we pointer-lock the canvas (mouse
    // capture). Every handler stops propagation so the drag/hover never leaks to
    // the editor controller listening on the parent.
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onLeave)
    canvas.addEventListener('contextmenu', this.onContextMenu)
    document.addEventListener('pointerlockchange', this.onLockChange)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('keydown', this.onKeyDown, true)
  }

  private get locked(): boolean {
    return document.pointerLockElement === this.canvas
  }

  /**
   * Show/hide the gizmo. Pilot mode hides it: the camera is the walker's eyes (no orbit target),
   * the gizmo's orbit drag would fight the look pad, and on mobile it sits under the Exit button.
   */
  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none'
  }

  /** recompute axis layout from the camera and redraw when anything changed */
  update(): void {
    if (this.disposed) return
    this.computeAxes()
    if (!this.dirty && this.prevQuat.equals(this.camera.quaternion)) return
    this.prevQuat.copy(this.camera.quaternion)
    this.dirty = false
    this.draw()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.dragging) {
      this.container.style.cursor = ''
      if (this.locked) document.exitPointerLock()
    }
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onLeave)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('keydown', this.onKeyDown, true)
    this.canvas.remove()
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(SIZE * this.dpr)
    this.canvas.height = Math.round(SIZE * this.dpr)
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.dirty = true
  }

  /** sort the axis balls back-to-front in view space for correct overdraw */
  private computeAxes(): void {
    this.invQuat.copy(this.camera.quaternion).invert()
    const axes = this.axes
    axes.length = 0
    for (let i = 0; i < 3; i++) {
      const v = this.tmp.copy(AXIS_DIRS[i]!).applyQuaternion(this.invQuat)
      const sx = v.x * ORBIT_RADIUS
      const sy = -v.y * ORBIT_RADIUS
      if (Math.abs(v.z) < 1) {
        axes.push({ axis: i, x: CENTER + sx, y: CENTER + sy, z: v.z, positive: true })
        axes.push({ axis: i + 3, x: CENTER - sx, y: CENTER - sy, z: -v.z, positive: false })
      } else {
        // camera looking straight down this axis: a single ball at the center
        axes.push({ axis: i + (v.z <= 0 ? 0 : 3), x: CENTER, y: CENTER, z: 1, positive: v.z > 0 })
      }
    }
    axes.sort((a, b) => a.z - b.z) // far first, so nearer balls draw on top
  }

  private draw(): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, SIZE, SIZE)
    if (this.focusedAxis > -2) {
      ctx.beginPath()
      ctx.arc(CENTER, CENTER, SIZE / 2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(128,128,128,0.25)'
      ctx.fill()
    }
    ctx.font = `bold ${FONT_PX}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const a of this.axes) this.drawAxis(a)
  }

  private drawAxis(a: Axis2D): void {
    const ctx = this.ctx
    const focused = this.focusedAxis === a.axis
    const dir = a.axis % 3
    const base = AXIS_COLORS[dir]!
    const alpha = focused ? 1 : clamp01(remap((a.z + 1) / 2, 0, 0.5, 0.35, 1))
    const c = focused ? lighten(base, 0.25) : base

    if (a.positive) {
      const dx = a.x - CENTER
      const dy = a.y - CENTER
      const len = Math.hypot(dx, dy)
      if (len > 0.001) {
        const ux = dx / len
        const uy = dy / len
        const end = Math.max(len - AXIS_RADIUS - 0.5, 0)
        ctx.beginPath()
        ctx.moveTo(CENTER + ux * 0.5, CENTER + uy * 0.5)
        ctx.lineTo(CENTER + ux * end, CENTER + uy * end)
        ctx.strokeStyle = css(c, alpha)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      fillCircle(ctx, a.x, a.y, AXIS_RADIUS, css(c, alpha))
      ctx.fillStyle = focused ? css([255, 255, 255], alpha) : css([0, 0, 0], alpha * 0.6)
      ctx.fillText(LETTERS[dir]!, a.x, a.y + 0.5)
    } else {
      fillCircle(ctx, a.x, a.y, AXIS_RADIUS, css(c, alpha))
      fillCircle(ctx, a.x, a.y, AXIS_RADIUS * 0.8, css(darken(c, 0.4), alpha))
      // negative labels only appear on hover (hidden otherwise)
      if (focused) {
        ctx.fillStyle = css([255, 255, 255], alpha)
        ctx.fillText(LETTERS[a.axis]!, a.x, a.y + 0.5)
      }
    }
  }

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private setFocus(x: number, y: number): void {
    let f = -2
    if (Math.hypot(x - CENTER, y - CENTER) < SIZE / 2) f = -1
    for (const a of this.axes) {
      if (Math.hypot(x - a.x, y - a.y) < AXIS_RADIUS) f = a.axis
    }
    if (f !== this.focusedAxis) {
      this.focusedAxis = f
      this.dirty = true
    }
    this.canvas.style.cursor = f >= 0 ? 'pointer' : f === -1 ? 'grab' : 'default'
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    // right-click during an orbit press/drag aborts it, restoring the camera to
    // the orientation captured when the drag began (no axis snap)
    if (e.button === 2 && this.pressed) {
      e.preventDefault()
      e.stopPropagation()
      this.abortDrag()
      return
    }
    if (e.button !== 0) return
    const p = this.localPoint(e)
    if (Math.hypot(p.x - CENTER, p.y - CENTER) >= SIZE / 2) return
    e.preventDefault()
    e.stopPropagation()
    this.pressed = true
    this.dragging = false
    this.pressX = p.x
    this.pressY = p.y
    this.lastClientX = e.clientX
    this.lastClientY = e.clientY
    this.activePointerId = e.pointerId
    this.canvas.setPointerCapture(e.pointerId)
    this.setFocus(p.x, p.y)
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    e.stopPropagation()
    // a chorded right-click (second button pressed while the orbit's left button
    // is held) arrives as a pointermove, not a pointerdown, so abort is read here
    if (this.pressed && (e.buttons & 2) !== 0) {
      this.abortDrag()
      return
    }
    // a press with no button held any more: its release was lost (Alt-Tab), which matters before the pointer lock
    // engages or when the browser refuses it. End it as a release would, the camera staying where the orbit left it.
    if (this.pressed && e.buttons === 0) {
      this.releaseLost()
      return
    }
    if (!this.pressed) {
      const p = this.localPoint(e)
      this.setFocus(p.x, p.y)
      return
    }
    if (!this.dragging) {
      const p = this.localPoint(e)
      if (Math.hypot(p.x - this.pressX, p.y - this.pressY) <= DRAG_THRESHOLD) return
      this.beginDrag()
    }
    // while pointer-locked clientX/Y are frozen, so orbit from movement deltas;
    // the lastClient fallback covers the frame before the lock actually engages
    const dx = this.locked ? e.movementX : e.clientX - this.lastClientX
    const dy = this.locked ? e.movementY : e.clientY - this.lastClientY
    this.lastClientX = e.clientX
    this.lastClientY = e.clientY
    this.callbacks.orbitBy(dx, dy)
  }

  /** enter the orbit drag: pointer-lock the canvas so the cursor is captured */
  private beginDrag(): void {
    this.dragging = true
    if (this.focusedAxis !== -1) {
      this.focusedAxis = -1
      this.dirty = true
    }
    this.callbacks.beginOrbit()
    // hide the cursor viewport-wide for the pre-lock frame and as a fallback if a
    // browser refuses the lock; pointer lock hides it for real once engaged
    this.container.style.cursor = 'none'
    this.canvas.style.cursor = 'none'
    const req = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
    req?.catch?.(() => {})
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.pressed || e.button !== 0) return
    e.stopPropagation()
    const wasDragging = this.dragging
    // exit warps the cursor back to where the lock engaged (over the gizmo)
    if (wasDragging && this.locked) document.exitPointerLock()
    this.endDrag()
    if (!wasDragging && this.focusedAxis >= 0) this.callbacks.snapToAxis(AXIS_DIRS[this.focusedAxis]!)
    const p = this.localPoint(e)
    this.setFocus(p.x, p.y)
  }

  /** a press whose release never came: finish it without the click's axis snap */
  private releaseLost(): void {
    if (this.dragging && this.locked) document.exitPointerLock()
    this.endDrag()
    this.canvas.style.cursor = 'default'
  }

  private readonly onBlur = (): void => {
    if (this.pressed) this.releaseLost()
  }

  // Escape while orbiting cancels the orbit and is the gizmo's alone; without the pointer lock (which handles Escape
  // through onLockChange) it otherwise reached the editor and cleared the selection while the orbit went on
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.pressed) return
    e.preventDefault()
    e.stopPropagation()
    this.abortDrag()
  }

  /** right-click abort: restore the camera and tear down the drag without snapping */
  private abortDrag(): void {
    if (!this.pressed) return
    const wasDragging = this.dragging
    if (wasDragging && this.locked) document.exitPointerLock()
    this.endDrag()
    if (wasDragging) this.callbacks.cancelOrbit()
    this.canvas.style.cursor = 'default'
  }

  /** common teardown for pointer-up and Escape (pointer-lock exit mid-drag) */
  private endDrag(): void {
    if (!this.pressed) return
    this.pressed = false
    if (this.activePointerId !== -1 && this.canvas.hasPointerCapture(this.activePointerId)) {
      this.canvas.releasePointerCapture(this.activePointerId)
    }
    this.activePointerId = -1
    if (this.dragging) this.container.style.cursor = ''
    this.dragging = false
  }

  // Escape exits pointer lock without a pointerup; pressed is still set, so
  // finalize the drag here (the later pointerup is then guarded out). The normal
  // release path runs endDrag first, so this no-ops when pressed is already clear.
  // Escape mid-orbit also restores the camera (cancel gesture).
  private readonly onLockChange = (): void => {
    if (this.locked) {
      // The lock is async: a fast click-drag-release can finish the orbit (endDrag
      // ran, dragging is already clear) before requestPointerLock resolves. When it
      // then engages the cursor would stay hidden forever - release it immediately.
      if (!this.dragging) {
        document.exitPointerLock()
        this.container.style.cursor = ''
        this.canvas.style.cursor = 'default'
      }
      return
    }
    if (!this.pressed) return
    const wasDragging = this.dragging
    this.endDrag()
    if (wasDragging) this.callbacks.cancelOrbit()
    this.canvas.style.cursor = 'default'
  }

  private readonly onLeave = (): void => {
    if (this.pressed) return
    if (this.focusedAxis !== -2) {
      this.focusedAxis = -2
      this.dirty = true
    }
    this.canvas.style.cursor = 'default'
  }

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault()
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function remap(v: number, inA: number, inB: number, outA: number, outB: number): number {
  return outA + ((v - inA) / (inB - inA)) * (outB - outA)
}

function fillCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}
