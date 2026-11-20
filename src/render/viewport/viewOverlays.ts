// The view's screen-space and annotation overlays (extracted from view.ts): the transform readout, the
// ruler (line, bracket, labels), the fly-speed label and the snap ping ring.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three'
import { Group } from 'three'
import type { Material } from 'three'
import { formatLength, formatSpeed, METRIC_DISPLAY } from '../../core/units'
import type { DisplayUnits } from '../../core/units'
import { worldPerPixel } from './editorCamera'
import type { Flash } from './viewTypes'
import type { RenderView } from './view'
// ruler colours: the line/total readout is the editor's
// ruler yellow (1.0, 0.9, 0.0); the Shift+Drag component bracket + per-axis labels use the
// gizmo axis colours (red X / green Y / blue Z).

const RULER_COLOR = 0xffe600
const RULER_CSS = '#ffe600'
const AXIS_COL = { x: new Color(0xf53352), y: new Color(0x87d603), z: new Color(0x298cf5) }
const AXIS_CSS = { x: '#f53352', y: '#87d603', z: '#298cf5' }

const FLASH_DURATION = 0.45
/** peak ring alpha at the instant the snap engages */
const FLASH_OPACITY = 0.9
/** how far the ring expands (× its authored radius) over its life */
const FLASH_GROWTH = 3.6

// The snap "ping" ring. Left in the XY plane and billboarded per frame (see updateFlashes)
// rather than laid flat on XZ. A junction sits at belt height, inside the parts it just
// joined, so a ground-plane ring shows as a squashed ellipse half hidden by the conveyor it
// marks. Camera-facing and drawn over geometry, it looks like one circle from any angle.
const flashGeo = new RingGeometry(0.15, 0.18, 64)

/**
 * The overlays' own state (`view.overlays`): the ruler's meshes and DOM readouts, the transform label,
 * the fly-speed label and the live snap flashes. The group + geometry are built as fields; the rest in
 * {@link build}, from the view's constructor.
 */
export class ViewOverlayState {
  readonly flashes: Flash[] = []
  // text of the live transform label (rotate degrees / translate / scale); null hides it
  labelText: string | null = null
  // where that label sits: beside this world point, or (null) beside the transform gizmo
  labelAnchor: Vector3 | null = null
  // ruler tool: a depth-tested-off measurement line + endpoint dots + a DOM readout
  readonly rulerGroup = new Group()
  readonly rulerGeo = new BufferGeometry()
  rulerEnds: { a: Vector3; b: Vector3 } | null = null
  rulerShift = false
  // the scene's Units, for the measure tool's read-out (setDisplayUnits)
  displayUnits: DisplayUnits = METRIC_DISPLAY
  // freelook's fly speed, shown for a moment after the wheel changes it (showFlySpeed)
  flySpeedTimer = 0
  // built by build(): the DOM labels, then the ruler meshes
  degreeLabel!: HTMLDivElement
  flySpeedLabel!: HTMLDivElement
  rulerLabel!: HTMLDivElement
  rulerAxisLabels!: HTMLDivElement[]
  rulerLine!: Line
  // Shift+Drag: an axis-aligned bracket (start→corner→end) + per-axis component labels
  rulerBracket!: LineSegments
  rulerEndA!: Mesh
  rulerEndB!: Mesh

  /** the DOM labels (appended to `container`), then the ruler meshes - once, from the view's constructor */
  build(container: HTMLElement): void {
    const labels = createOverlayLabels(container)
    this.degreeLabel = labels.degreeLabel
    this.rulerLabel = labels.rulerLabel
    this.flySpeedLabel = labels.flySpeedLabel
    this.rulerAxisLabels = labels.rulerAxisLabels

    const ruler = createRulerMeshes(this.rulerGeo, this.rulerGroup)
    this.rulerLine = ruler.rulerLine
    this.rulerBracket = ruler.rulerBracket
    this.rulerEndA = ruler.rulerEndA
    this.rulerEndB = ruler.rulerEndB
  }

  /** remove the DOM labels and free the ruler's GPU resources (the snap flashes are the view's to free) */
  dispose(): void {
    this.degreeLabel.remove()
    this.rulerLabel.remove()
    window.clearTimeout(this.flySpeedTimer)
    this.flySpeedLabel.remove()
    for (const el of this.rulerAxisLabels) el.remove()
    this.rulerGeo.dispose()
    ;(this.rulerLine.material as Material).dispose()
    this.rulerBracket.geometry.dispose()
    ;(this.rulerBracket.material as Material).dispose()
    this.rulerEndA.geometry.dispose()
    ;(this.rulerEndA.material as Material).dispose()
  }
}

/** what the overlays reach on the view beyond their own {@link ViewOverlayState} */
export type OverlayHost = Pick<
  RenderView,
  | 'camTmp'
  | 'camera'
  | 'container'
  | 'gizmo'
  | 'overlays'
  | 'projTmp'
  | 'renderer'
  | 'scene'
>

/** the transform readout, ruler readout, fly-speed and per-axis ruler labels, appended to `container` in
 *  that order (the view builds them once, in its constructor) */
export function createOverlayLabels(container: HTMLElement): {
  degreeLabel: HTMLDivElement
  rulerLabel: HTMLDivElement
  flySpeedLabel: HTMLDivElement
  rulerAxisLabels: HTMLDivElement[]
} {
  const degreeLabel = document.createElement('div')
  Object.assign(degreeLabel.style, {
    position: 'absolute',
    display: 'none',
    pointerEvents: 'none',
    zIndex: '6',
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    color: '#d6f5dc',
    background: 'rgba(0, 0, 0, 0.6)',
    padding: '2px 6px',
    borderRadius: '3px',
    whiteSpace: 'nowrap',
  })
  container.appendChild(degreeLabel)

  const rulerLabel = degreeLabel.cloneNode() as HTMLDivElement
  rulerLabel.style.color = RULER_CSS
  rulerLabel.style.whiteSpace = 'pre'
  rulerLabel.style.textAlign = 'center'
  container.appendChild(rulerLabel)

  // the cursor is hidden in flight, so the speed sits at a fixed spot (bottom centre) rather than beside it
  const flySpeedLabel = degreeLabel.cloneNode() as HTMLDivElement
  Object.assign(flySpeedLabel.style, {
    left: '50%',
    bottom: '48px',
    transform: 'translateX(-50%)',
    fontSize: '13px',
    transition: 'opacity 0.3s',
  })
  container.appendChild(flySpeedLabel)

  // Shift+Drag shows per-axis component readouts, each tinted with the
  // axis colour (red X / green Y / blue Z). One reusable label per axis slot.
  const rulerAxisLabels = [0, 1, 2].map(() => {
    const el = degreeLabel.cloneNode() as HTMLDivElement
    el.style.whiteSpace = 'nowrap'
    el.style.textAlign = 'center'
    el.style.display = 'none'
    container.appendChild(el)
    return el
  })
  return { degreeLabel, rulerLabel, flySpeedLabel, rulerAxisLabels }
}

/** build the ruler's line, Shift+Drag axis bracket and endpoint dots over `rulerGeo`, parented (hidden)
 *  under `rulerGroup` (the view builds them once, in its constructor) */
export function createRulerMeshes(rulerGeo: BufferGeometry, rulerGroup: Group): {
  rulerLine: Line
  rulerBracket: LineSegments
  rulerEndA: Mesh
  rulerEndB: Mesh
} {
  rulerGeo.setAttribute('position', new BufferAttribute(new Float32Array(6), 3))
  const rulerColor = RULER_COLOR
  const rulerLineMat = new LineBasicMaterial({
    color: rulerColor,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  })
  const rulerLine = new Line(rulerGeo, rulerLineMat)
  rulerLine.renderOrder = 1000
  rulerLine.frustumCulled = false

  // axis bracket: 2 segments (start→corner→end), 4 vertices with per-vertex axis colours
  const bracketGeo = new BufferGeometry()
  bracketGeo.setAttribute('position', new BufferAttribute(new Float32Array(12), 3))
  bracketGeo.setAttribute('color', new BufferAttribute(new Float32Array(12), 3))
  const bracketMat = new LineBasicMaterial({
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  })
  const rulerBracket = new LineSegments(bracketGeo, bracketMat)
  rulerBracket.renderOrder = 1000
  rulerBracket.frustumCulled = false
  rulerBracket.visible = false

  const endGeo = new SphereGeometry(0.05, 12, 8)
  const endMat = new MeshBasicMaterial({ color: rulerColor, depthTest: false, depthWrite: false, toneMapped: false })
  const rulerEndA = new Mesh(endGeo, endMat)
  const rulerEndB = new Mesh(endGeo, endMat)
  rulerEndA.renderOrder = 1000
  rulerEndB.renderOrder = 1000
  rulerGroup.add(rulerLine, rulerBracket, rulerEndA, rulerEndB)
  rulerGroup.visible = false
  return { rulerLine, rulerBracket, rulerEndA, rulerEndB }
}

/** freelook's wheel changed the fly speed: show it for a second, then fade (the next notch restarts the clock) */
export function showFlySpeed(view: OverlayHost, speed: number): void {
  const el = view.overlays.flySpeedLabel
  el.textContent = `Fly speed ${formatSpeed(speed, view.overlays.displayUnits)}`
  el.style.opacity = '1'
  el.style.display = 'block'
  window.clearTimeout(view.overlays.flySpeedTimer)
  view.overlays.flySpeedTimer = window.setTimeout(() => {
    el.style.opacity = '0'
    view.overlays.flySpeedTimer = window.setTimeout(() => hideFlySpeed(view), 300)
  }, 1000)
}

export function hideFlySpeed(view: OverlayHost): void {
  window.clearTimeout(view.overlays.flySpeedTimer)
  view.overlays.flySpeedLabel.style.display = 'none'
}

/**
 * Ping the junction a live snap just engaged (controller.applyLiveSnap, once per new target).
 * Cyan is the snap colour shared with the vertex-snap target marker, and like that marker
 * this is an annotation, not scene geometry: depthTest off + renderOrder 999 so the parts it
 * marks can't clip it. Additive so it shows as a light pulse over both the dark belt and the
 * lit floor instead of a translucent grey washer.
 */
export function flashSnap(view: OverlayHost, x: number, z: number, y = 0): void {
  const material = new MeshBasicMaterial({
    color: 0x66e0ff,
    transparent: true,
    opacity: FLASH_OPACITY,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
  const mesh = new Mesh(flashGeo, material)
  mesh.position.set(x, y, z)
  mesh.quaternion.copy(view.camera.quaternion)
  mesh.renderOrder = 999
  view.scene.add(mesh)
  view.overlays.flashes.push({ mesh, material, age: 0 })
}

export function setRuler(view: OverlayHost, a: [number, number, number] | null, b: [number, number, number] | null): void {
  if (!a || !b) {
    view.overlays.rulerGroup.visible = false
    view.overlays.rulerBracket.visible = false
    view.overlays.rulerLabel.style.display = 'none'
    for (const el of view.overlays.rulerAxisLabels) el.style.display = 'none'
    view.overlays.rulerEnds = null
    return
  }
  const pos = view.overlays.rulerGeo.getAttribute('position') as BufferAttribute
  pos.array.set([a[0], a[1], a[2], b[0], b[1], b[2]])
  pos.needsUpdate = true
  view.overlays.rulerGeo.computeBoundingSphere()
  view.overlays.rulerEndA.position.set(a[0], a[1], a[2])
  view.overlays.rulerEndB.position.set(b[0], b[1], b[2])
  view.overlays.rulerGroup.visible = true
  view.overlays.rulerEnds = { a: new Vector3(a[0], a[1], a[2]), b: new Vector3(b[0], b[1], b[2]) }
  updateRulerLabel(view)
}

/** drive the transform label (rotate/translate/scale): set its text + show, or hide */
export function setLabel(view: OverlayHost, text: string | null): void {
  view.overlays.labelText = text
  if (text === null) {
    view.overlays.degreeLabel.style.display = 'none'
  } else {
    view.overlays.degreeLabel.textContent = text
    updateDegreeLabel(view)
  }
}

export function updateDegreeLabel(view: OverlayHost): void {
  const center = view.overlays.labelAnchor ?? view.gizmo.root.position
  view.camera.updateMatrixWorld()
  view.camTmp.copy(center).applyMatrix4(view.camera.matrixWorldInverse)
  if (view.camTmp.z >= 0) {
    view.overlays.degreeLabel.style.display = 'none'
    return
  }
  const rect = view.renderer.domElement.getBoundingClientRect()
  const host = view.container.getBoundingClientRect()
  view.projTmp.copy(center).project(view.camera)
  const x = rect.left - host.left + ((view.projTmp.x + 1) / 2) * rect.width
  const y = rect.top - host.top + ((1 - view.projTmp.y) / 2) * rect.height
  view.overlays.degreeLabel.style.left = `${Math.round(x + 18)}px`
  view.overlays.degreeLabel.style.top = `${Math.round(y - 28)}px`
  view.overlays.degreeLabel.style.display = 'block'
}

/** keep the ruler endpoint dots a roughly constant on-screen size as the camera dollies */
export function scaleRulerEndpoints(view: OverlayHost): void {
  const h = view.container.clientHeight || 1
  for (const dot of [view.overlays.rulerEndA, view.overlays.rulerEndB]) {
    const d = view.camera.position.distanceTo(dot.position)
    const worldPerPx = worldPerPixel(view.camera, d, h)
    dot.scale.setScalar(Math.max((worldPerPx * 6) / 0.05, 1e-3))
  }
}

export function updateRulerLabel(view: OverlayHost): void {
  const ends = view.overlays.rulerEnds
  if (!ends) return
  view.camera.updateMatrixWorld()
  const a = ends.a
  const b = ends.b
  const center = view.camTmp.copy(a).add(b).multiplyScalar(0.5)

  // total distance - always shown (3-decimal metres or feet-and-inches by the display units, zeroed below 1 mm)
  let dist = a.distanceTo(b)
  if (dist < 0.001) dist = 0
  const len = (m: number): string => formatLength(m, view.overlays.displayUnits)
  let readout = len(dist)
  // Shift also overlays orientation angles derived from the same two endpoints:
  // incline above the ground plane, and plan-view bearing (from +X toward +Z). A
  // plain ruler reports only distance/components; both angles come straight from
  // the endpoints, so no new gesture is needed. Grouped with the (yellow) total;
  // the tinted X/Y/Z component labels stay the axis breakdown.
  if (view.overlays.rulerShift && dist > 0) {
    const horiz = Math.hypot(b.x - a.x, b.z - a.z)
    const incline = (Math.atan2(Math.abs(b.y - a.y), horiz) * 180) / Math.PI
    readout += `\n${incline.toFixed(1)}° incline`
    if (horiz > 0.001) {
      // bearing undefined for a vertical line (no horizontal run) - omit it there
      let bearing = (Math.atan2(b.z - a.z, b.x - a.x) * 180) / Math.PI
      if (bearing < 0) bearing += 360
      readout += `\n${bearing.toFixed(1)}° plan`
    }
  }
  view.overlays.rulerLabel.textContent = readout
  placeRulerLabel(view, view.overlays.rulerLabel, center, -36)

  // show-components: Shift+Drag overlays an axis bracket + per-axis component labels
  let dx = Math.abs(b.x - a.x)
  let dy = Math.abs(b.y - a.y)
  let dz = Math.abs(b.z - a.z)
  if (dx < 0.001) dx = 0
  if (dy < 0.001) dy = 0
  if (dz < 0.001) dz = 0
  const active = (dx > 0 ? 1 : 0) + (dy > 0 ? 1 : 0) + (dz > 0 ? 1 : 0)

  if (!view.overlays.rulerShift || active === 0) {
    view.overlays.rulerBracket.visible = false
    for (const el of view.overlays.rulerAxisLabels) el.style.display = 'none'
    return
  }

  const mid = (p: Vector3, q: Vector3) => p.clone().add(q).multiplyScalar(0.5)
  const labels: { text: string; color: string; world: Vector3 }[] = []
  let corner: Vector3 | null = null
  let c1 = AXIS_COL.x
  let c2 = AXIS_COL.x

  if (active >= 2) {
    if (dz === 0) {
      // XY plane
      corner = new Vector3(b.x, a.y, a.z)
      c1 = AXIS_COL.x
      c2 = AXIS_COL.y
      labels.push({ text: `X: ${len(dx)}`, color: AXIS_CSS.x, world: mid(a, corner) })
      labels.push({ text: `Y: ${len(dy)}`, color: AXIS_CSS.y, world: mid(corner, b) })
    } else if (dy === 0) {
      // XZ plane
      corner = new Vector3(b.x, a.y, a.z)
      c1 = AXIS_COL.x
      c2 = AXIS_COL.z
      labels.push({ text: `X: ${len(dx)}`, color: AXIS_CSS.x, world: mid(a, corner) })
      labels.push({ text: `Z: ${len(dz)}`, color: AXIS_CSS.z, world: mid(corner, b) })
    } else if (dx === 0) {
      // YZ plane
      corner = new Vector3(a.x, a.y, b.z)
      c1 = AXIS_COL.z
      c2 = AXIS_COL.y
      labels.push({ text: `Z: ${len(dz)}`, color: AXIS_CSS.z, world: mid(a, corner) })
      labels.push({ text: `Y: ${len(dy)}`, color: AXIS_CSS.y, world: mid(corner, b) })
    } else {
      // all three axes: bracket spans X then Y; Z is reported on its own label
      corner = new Vector3(b.x, a.y, a.z)
      c1 = AXIS_COL.x
      c2 = AXIS_COL.y
      labels.push({ text: `X: ${len(dx)}`, color: AXIS_CSS.x, world: mid(a, corner) })
      labels.push({ text: `Y: ${len(dy)}`, color: AXIS_CSS.y, world: mid(corner, b) })
      labels.push({ text: `Z: ${len(dz)}`, color: AXIS_CSS.z, world: center.clone().add(new Vector3(0, 0, -0.5)) })
    }
  } else if (dx > 0) {
    labels.push({ text: `X: ${len(dx)}`, color: AXIS_CSS.x, world: center.clone() })
  } else if (dy > 0) {
    labels.push({ text: `Y: ${len(dy)}`, color: AXIS_CSS.y, world: center.clone() })
  } else {
    labels.push({ text: `Z: ${len(dz)}`, color: AXIS_CSS.z, world: center.clone() })
  }

  if (corner) {
    const pos = view.overlays.rulerBracket.geometry.getAttribute('position') as BufferAttribute
    const col = view.overlays.rulerBracket.geometry.getAttribute('color') as BufferAttribute
    ;(pos.array as Float32Array).set([a.x, a.y, a.z, corner.x, corner.y, corner.z, corner.x, corner.y, corner.z, b.x, b.y, b.z])
    ;(col.array as Float32Array).set([c1.r, c1.g, c1.b, c1.r, c1.g, c1.b, c2.r, c2.g, c2.b, c2.r, c2.g, c2.b])
    pos.needsUpdate = true
    col.needsUpdate = true
    view.overlays.rulerBracket.geometry.computeBoundingSphere()
    view.overlays.rulerBracket.visible = true
  } else {
    // single axis: the main line already traces the only leg, so no bracket
    view.overlays.rulerBracket.visible = false
  }

  view.overlays.rulerAxisLabels.forEach((el, i) => {
    const spec = labels[i]
    if (!spec) {
      el.style.display = 'none'
      return
    }
    el.textContent = spec.text
    el.style.color = spec.color
    placeRulerLabel(view, el, spec.world, 0)
  })
}

/** project a world point to viewport pixels and show the DOM label there; hide if behind camera */
export function placeRulerLabel(view: OverlayHost, el: HTMLDivElement, world: Vector3, offsetY: number): void {
  const camZ = view.projTmp.copy(world).applyMatrix4(view.camera.matrixWorldInverse).z
  if (camZ >= 0) {
    el.style.display = 'none'
    return
  }
  const rect = view.renderer.domElement.getBoundingClientRect()
  const host = view.container.getBoundingClientRect()
  view.projTmp.copy(world).project(view.camera)
  const x = rect.left - host.left + ((view.projTmp.x + 1) / 2) * rect.width
  const y = rect.top - host.top + ((1 - view.projTmp.y) / 2) * rect.height
  el.style.left = `${Math.round(x)}px`
  el.style.top = `${Math.round(y + offsetY)}px`
  el.style.transform = 'translateX(-50%)'
  el.style.display = 'block'
}

export function updateFlashes(view: OverlayHost, dt: number): void {
  for (let i = view.overlays.flashes.length - 1; i >= 0; i--) {
    const flash = view.overlays.flashes[i]!
    flash.age += dt
    const k = flash.age / FLASH_DURATION
    if (k >= 1) {
      view.scene.remove(flash.mesh)
      flash.material.dispose()
      view.overlays.flashes.splice(i, 1)
      continue
    }
    // Cubic ease-out on the radius: the ring leaves the junction fast and decelerates, which
    // looks like an impact rather than a linear grow. Alpha falls quadratically so it is
    // nearly gone by the time the (uniformly scaled, hence thickening) stroke is thick.
    const ease = 1 - (1 - k) ** 3
    const s = 1 + FLASH_GROWTH * ease
    flash.mesh.scale.set(s, s, 1)
    flash.mesh.quaternion.copy(view.camera.quaternion) // billboard: a circle from any angle
    flash.material.opacity = FLASH_OPACITY * (1 - k) ** 2
  }
}
