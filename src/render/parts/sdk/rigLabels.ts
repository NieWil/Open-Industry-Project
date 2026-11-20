// Label plates for a rig (buildRig in rig.ts): a `label` link is a flat plane carrying a canvas texture, redrawn as an
// engraved plate from its static text, its text param, or a live value the behavior publishes.

import { BufferGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three'
import type { Material, Texture } from 'three'
import type { RigParams } from '../../../core/rig/rigPose'
import type { RigShape } from '../../../core/parts/partPackage'
import { bumpStructureVersion } from '../structureRev'

/** the longest edge of a label's canvas, in texels; the short edge follows the plane's aspect */
const LABEL_TEXEL = 512
/** requested anisotropy for a caption; both backends clamp this to the device max, so it needs no capability probe */
const MAX_LABEL_ANISOTROPY = 16

/**
 * The canvas a label link draws into, sized to the plane's aspect. A square canvas on a non-square plane
 * stretches every glyph by the aspect ratio. Sizing the canvas to the plane lets a caption be as wide as the
 * surface it is printed on (a legend band above a pushbutton cap is wide and shallow, like a real engraved plate).
 */
function labelCanvasSize(w: number, h: number): { width: number; height: number } {
  const long = Math.max(w, h)
  const px = (n: number): number => Math.max(16, Math.round((LABEL_TEXEL * n) / long))
  return { width: px(w), height: px(h) }
}

/** the legend plate a caption is printed on: pale engraving stock, with a darker edge so it reads as a plate */
const LABEL_PLATE = '#e9e9e6'
const LABEL_PLATE_EDGE = '#8d8f92'

/**
 * Draw a label shape onto its canvas as an engraved plate: the plate colour edge to edge, with the text on top,
 * rather than bare glyphs on a transparent canvas. Empty text leaves the canvas clear (the link hides).
 * `color` is the ink, a CSS colour string.
 *
 * The plate is what makes the caption render. Bare glyphs on a transparent canvas are invisible under WebGPU,
 * while WebGL draws them. A solid fill on the same canvas shows at once (a red test fill did; black and white
 * text on transparent did not), so WebGPU sampling loses thin, mostly-transparent coverage. Headless runs have no
 * WebGPU adapter and fall back to WebGL, so gates and screenshots don't catch this. A solid plate also survives
 * minification: mip-averaging thin strokes over transparency fades a caption to nothing a couple of metres out,
 * while a plate keeps its contrast and just gets smaller. Verify captions on `msedge --enable-unsafe-webgpu`.
 *
 * The caption is fitted to both axes. It takes 72% of the plate height, then shrinks by measured width if it
 * would overrun the plate. A long caption stays inside a narrow plate, and a short one on a wide plate stays
 * as big as the height allows (a character count would ignore what the glyphs actually measure).
 */
function drawLabelText(ctx: CanvasRenderingContext2D, text: string, color: string): void {
  const { width, height } = ctx.canvas
  ctx.clearRect(0, 0, width, height)
  if (!text) return
  ctx.fillStyle = LABEL_PLATE
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = LABEL_PLATE_EDGE
  ctx.lineWidth = Math.max(2, Math.round(height * 0.05))
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth)
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const font = (px: number): string => `bold ${px}px ui-sans-serif, system-ui, sans-serif`
  let size = height * 0.72
  ctx.font = font(size)
  const max = width * 0.9 // a margin either end, so the caption reads as printed ON the plate
  const measured = ctx.measureText(text).width
  if (measured > max) {
    size = Math.max(4, (size * max) / measured)
    ctx.font = font(size)
  }
  ctx.fillText(text, width / 2, height / 2 + size * 0.04)
}

export type RigLabel = { shape: Extract<RigShape, { kind: 'label' }>; mesh: Mesh; ctx: CanvasRenderingContext2D; tex: CanvasTexture; last: string | null }

/** Build a label link's plane under `g`. Its texture, material and geometry go in `disposables`. */
export function addLabelPlane(shape: Extract<RigShape, { kind: 'label' }>, g: Group, labels: RigLabel[], disposables: (Texture | Material | BufferGeometry)[]): void {
  // a flat plane facing local +Z; the canvas/2d context may be absent (headless tests) - then the link is empty
  const [w, h] = shape.size ?? [0.05, 0.05]
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  const c2d = canvas?.getContext('2d') ?? null
  if (canvas && c2d) {
    const size = labelCanvasSize(w, h)
    canvas.width = size.width
    canvas.height = size.height
    const tex = new CanvasTexture(canvas)
    tex.colorSpace = SRGBColorSpace
    // a caption is read at a glancing angle as often as head-on (walking a line, not standing at it), and
    // an unfiltered minified glyph washes out to nothing there - the plate keeps its text off-axis
    tex.anisotropy = MAX_LABEL_ANISOTROPY
    // Opaque: the plate covers its quad edge to edge, so there is nothing to blend and no reason to skip
    // depth. Transparent + depthWrite:false is what a bare-glyph caption would need, and that combination
    // loses the text under WebGPU (see drawLabelText). A solid quad standing clear of the surface behind it
    // needs neither.
    const mat = new MeshBasicMaterial({ map: tex, toneMapped: false })
    const geom = new PlaneGeometry(w, h)
    const mesh = new Mesh(geom, mat)
    mesh.visible = false // shown once the first refresh draws non-empty text
    g.add(mesh)
    labels.push({ shape, mesh, ctx: c2d, tex, last: null })
    disposables.push(tex, mat, geom)
  }
}

/** Repaint the caption plates. A live caption (`textFrom`, published by the behavior) is shown while it is being
 *  published, else the authored `textParam`/`text` - so a stopped scene reads as the engraved legend instead
 *  of going blank. Returns whether anything changed (the bundle-refresh signal). */
export function paintLabelPlates(labels: readonly RigLabel[], displayValues: Readonly<Record<string, number | boolean | string>>, params: RigParams, root: Group): boolean {
  let changed = false
  for (const lb of labels) {
    const live = lb.shape.textFrom !== undefined ? displayValues[lb.shape.textFrom] : undefined
    const raw = live !== undefined ? live : lb.shape.textParam !== undefined ? params[lb.shape.textParam] : lb.shape.text
    const text = raw === undefined || raw === null ? '' : String(raw)
    const shown = text !== ''
    const redraw = text !== lb.last
    if (redraw) {
      lb.last = text
      const col = lb.shape.color
      drawLabelText(lb.ctx, text, col ? `rgb(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)})` : '#000000')
      lb.tex.needsUpdate = true
    }
    const flipped = lb.mesh.visible !== shown
    lb.mesh.visible = shown
    // Only a visibility flip is structural: a recorded render bundle bakes which draws exist. New text is
    // not. The canvas keeps the size it was made with, so three re-uploads into the same GPU texture (no
    // new handle for a bundle to go stale on), and the upload goes out with the part's dirty mark (`changed`
    // → the view marks the part, whose walked draw uploads the texture). Bumping here would re-record every
    // bundle and re-sign the instance pools each time a counter ticks.
    if (flipped) bumpStructureVersion(root)
    if (redraw || flipped) changed = true
  }
  return changed
}
