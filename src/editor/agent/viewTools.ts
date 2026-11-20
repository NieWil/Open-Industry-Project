// Agent tools for seeing the scene and for scene edits that act on groups or on the agent's own history
// (docs/agent-tools.md): a picture of the viewport, the cargo of the running sim, a station copied by an offset,
// taking back the agent's own last edit, and dropping a kept test.

import { cargoKindName } from '../../core/frame'
import { cargoTiltDeg, cargoYawDeg } from '../../core/project/projectProbe'
import { duplicateParts } from '../../core/parts/partDuplicate'
import { assetsBusy, whenAssetsQuiet } from '../../render/gltf'
import type { SceneJSON } from '../../core/types'
import {
  AGENT_LABEL,
  AgentImageResult,
  AgentToolError,
  assertEditable,
  findPart,
  needController,
  optBool,
  optObj,
  optStr,
  optVec3,
  round,
  str,
  strList,
  type AgentTool,
  type CaptureRect,
} from './toolKit'

// ── capture_view ────────────────────────────────────────────────────────────────────────────────────

/** Directions the camera looks FROM, toward the framed parts (+Y up). */
const VIEW_FROM: Record<string, [number, number, number]> = {
  iso: [1, 0.8, 1],
  top: [0, 1, 0.0001], // a hair off vertical, so the orbit controls keep a defined heading
  front: [0, 0.35, 1],
  back: [0, 0.35, -1],
  left: [-1, 0.35, 0],
  right: [1, 0.35, 0],
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

// How long capture_view waits in all (loading assets, held parts, the camera) before it shoots anyway. whenAssetsQuiet's
// own cap is 30 s: after a project reload a cold scene loads that long, and an MCP client gave up on the call first.
// The waits share this one deadline: run one after another (6 s, 5 s, 3 s) they outlasted a client's timeout on a
// scene with many-link parts.
const CAPTURE_WAIT_MS = 6000
/** the frames that draw the framed, outline-free view get this long, even when loading used up the deadline: a
 *  minimized window draws about one frame a second */
const FRAMES_MIN_MS = 2500
/** frames drawn after the camera moves and the outline goes, before the shot */
const FRAMES_BEFORE_SHOT = 2

/** Resolve true when `p` does, or false once `deadline` (a performance.now() time) passes. */
function byDeadline(p: Promise<unknown>, deadline: number): Promise<boolean> {
  return Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), Math.max(0, deadline - performance.now())))])
}

/** Wait for `n` frames to be drawn, or `ms` to pass; true when they were. A minimized or hidden window draws few or
 *  none, and a frame wait without a deadline hung the call. */
async function framesDrawn(n: number, ms: number): Promise<boolean> {
  const end = performance.now() + ms
  for (let i = 0; i < n; i++) if (!(await byDeadline(nextFrame(), end))) return false
  return true
}

/**
 * Hide every element that is not the main canvas or one of its ancestors (visibility, so nothing reflows and the
 * camera's aspect is unchanged), as e2e/_shot.mjs cleanShot does. Returns the canvas rect and the undo.
 */
function bareCanvas(): { rect: CaptureRect; restore: () => void } | null {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  if (!canvas) return null
  const keep = new Set<Element>()
  for (let el: Element | null = canvas; el; el = el.parentElement) keep.add(el)
  const hidden: HTMLElement[] = []
  for (let el: Element | null = canvas; el?.parentElement; el = el.parentElement) {
    for (const sib of el.parentElement.children) {
      if (keep.has(sib) || !(sib instanceof HTMLElement) || sib.style.visibility === 'hidden') continue
      hidden.push(sib)
      sib.style.visibility = 'hidden'
    }
  }
  const r = canvas.getBoundingClientRect()
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    restore: () => {
      for (const el of hidden) el.style.visibility = ''
    },
  }
}

export const captureView: AgentTool = {
  name: 'capture_view',
  description:
    'Take a picture of the 3D view, without the editor around it, the selection outline or the gizmo, to see what ' +
    'was built: whether parts meet, a sensor faces the belt, a model sits inside its footprint, boxes flow or pile ' +
    'up (call it while running). Frames `parts` (default: every part but the building) from `from`: iso (default), top, front ' +
    '(from +Z), back, left (from -X), right, or current (the camera as it is). The camera goes back to where the ' +
    "user had it unless `keepCamera` is true. Returns an image within about 6 s; if the scene is still loading it " +
    'shoots anyway and the result carries `assetsSettled: false` or `partsHeld` (parts not drawn yet), so call it ' +
    "again in a moment for the settled view. `from: 'window'` instead takes the whole editor " +
    'window as the user sees it (panels, banners, dialogs, the selection), without moving the camera: use it only ' +
    'for a question about the editor itself, since the 3D view alone shows a build better.',
  inputSchema: {
    type: 'object',
    properties: {
      parts: { type: 'array', items: { type: 'string' }, description: 'part ids to frame' },
      from: { type: 'string', enum: [...Object.keys(VIEW_FROM), 'current', 'window'] },
      keepCamera: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const capture = ctx.shell?.capture
    if (!capture) throw new AgentToolError('capture_view needs the desktop app')
    if (optStr(args, 'from') === 'window') {
      if (args.parts !== undefined) throw new AgentToolError("'parts' frames the 3D view, so it does not go with from: 'window'")
      const image = await capture({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
      if (!image) throw new AgentToolError('the window could not be captured (is it minimized?)')
      return new AgentImageResult({ from: 'window', running: ctx.store.getState().running }, [image])
    }
    const view = needController(ctx).view
    if (!view) throw new AgentToolError('the viewport is still loading; try again in a moment')
    // the walking character or the headset owns the camera then, and framing would fight it
    if (view.pilotPose() !== null || view.isVRPresenting()) throw new AgentToolError('the user is walking the scene (or in VR), which owns the camera: try again once they leave walk mode')
    const asked = args.parts === undefined ? undefined : strList(args, 'parts')
    const scene = ctx.store.getState().scene
    for (const id of asked ?? []) findPart(scene, id)
    // the default frames what was built, not the building: every first picture of a new line was a speck in it
    const line = scene.parts.filter((p) => p.type !== 'building').map((p) => p.id)
    const parts = asked ?? (line.length > 0 ? line : undefined)
    const from = optStr(args, 'from') ?? 'iso'
    if (from !== 'current' && !VIEW_FROM[from]) throw new AgentToolError(`'from' must be one of: ${[...Object.keys(VIEW_FROM), 'current', 'window'].join(', ')}`)
    const keepCamera = optBool(args, 'keepCamera') ?? false
    const pose0 = view.cameraPose()
    const selected = ctx.store.getState().selectedIds
    let bare: ReturnType<typeof bareCanvas> = null
    // a part placed a moment ago may still be loading or held back from the draw (the canvas keeps its last
    // painted frame meanwhile), and a picture taken then shows the scene before the edit
    const deadline = performance.now() + CAPTURE_WAIT_MS
    const assetsSettled = assetsBusy() ? await byDeadline(whenAssetsQuiet(), deadline) : true
    await byDeadline(view.whenPartsRevealed(), deadline)
    try {
      if (from !== 'current') {
        // aim from the asked side at the current target, then let focusOn frame the parts along that direction
        const [dx, dy, dz] = VIEW_FROM[from]!
        const len = Math.hypot(dx, dy, dz)
        const dist = Math.hypot(pose0.px - pose0.tx, pose0.py - pose0.ty, pose0.pz - pose0.tz) || 10
        view.setCameraPose({ px: pose0.tx + (dx / len) * dist, py: pose0.ty + (dy / len) * dist, pz: pose0.tz + (dz / len) * dist, tx: pose0.tx, ty: pose0.ty, tz: pose0.tz }, { instant: true })
      }
      // placed at once, not eased: an ease advances per frame, and a minimized window draws about one a second
      if (from !== 'current' || parts) view.focusOn(parts ?? [], { instant: true })
      if (selected.length > 0) ctx.store.selectMany([])
      bare = bareCanvas()
      if (!bare) throw new AgentToolError('the 3D view is not on screen')
      // the framed, outline-free, overlay-free frame reaches the screen
      const drawn = await framesDrawn(FRAMES_BEFORE_SHOT, Math.max(FRAMES_MIN_MS, deadline - performance.now()))
      const image = await capture(bare.rect)
      if (!image) throw new AgentToolError('the window could not be captured (is it minimized?)')
      const p = view.cameraPose()
      const held = view.heldParts()
      return new AgentImageResult(
        {
          from,
          framed: asked ?? (parts ? 'every part but the building' : 'the whole scene'),
          camera: { position: [p.px, p.py, p.pz].map(round), target: [p.tx, p.ty, p.tz].map(round) },
          running: ctx.store.getState().running,
          // the shot may show the scene part-loaded: capture again in a moment
          ...(assetsSettled ? {} : { assetsSettled: false }),
          // parts placed or rebuilt a moment ago that the view had not drawn yet
          ...(held > 0 ? { partsHeld: held } : {}),
          // the window drew no new frame in time (minimized, or behind something): the picture is its last one
          ...(drawn ? {} : { viewNotDrawing: 'the editor window drew no new frame (is it minimized?): this picture may show the view from before the camera moved' }),
        },
        [image],
      )
    } finally {
      bare?.restore()
      if (selected.length > 0) ctx.store.selectMany(selected)
      if (!keepCamera) view.setCameraPose(pose0, { instant: true })
    }
  },
}

// ── get_cargo ───────────────────────────────────────────────────────────────────────────────────────

/** get_cargo, and each of run_test's cargo snapshots, lists at most this many bodies (the rest are counted) */
export const CARGO_LIST_MAX = 200

export const getCargo: AgentTool = {
  name: 'get_cargo',
  description:
    'List the cargo of the running sim (boxes, totes, pallets) as the last frame has it: id, kind, position [x,y,z] ' +
    'in metres, size, colour, how far it is tilted from upright in degrees (about 90 = on its side), its heading ' +
    '`yawDeg` about +Y in degrees (as a part\'s rotationY; a box turned 90 has the same footprint), and the scene ' +
    'part it is, for authored cargo. Optional `within`: only bodies whose centre is inside a box { min:[x,y,z], ' +
    'max:[x,y,z] }. Empty while stopped. Running, this is wherever the sim has got to. Paused (pause / step), each ' +
    'body also has its velocity `vel` [x,y,z] in m/s and what it is `touching` (part ids, `cargo <id>`, `floor`). ' +
    'For the cargo at a known sim time the same on every run, use run_test with `cargo`.',
  inputSchema: {
    type: 'object',
    properties: { within: { type: 'object', description: '{ min: [x,y,z], max: [x,y,z] } in metres' } },
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const c = needController(ctx)
    if (!c.lastFrame || !ctx.store.getState().running) return { running: false, count: 0, cargo: [] }
    const within = optObj(args, 'within')
    const min = within ? optVec3(within, 'min') : undefined
    const max = within ? optVec3(within, 'max') : undefined
    if (within && (!min || !max)) throw new AgentToolError("'within' needs min and max, each [x, y, z]")
    // paused, the world stands where the last frame shows it, so the worker's velocities and contacts match its rows
    const paused = ctx.store.getState().paused
    const detail = paused ? await c.sim?.inspectCargo() : null
    const f = c.lastFrame
    if (!f) return { running: false, count: 0, cargo: [] }
    const vel = new Map<number, [number, number, number]>()
    if (detail) for (let i = 0; i < detail.ids.length; i++) vel.set(detail.ids[i]!, [detail.velocities[i * 3]!, detail.velocities[i * 3 + 1]!, detail.velocities[i * 3 + 2]!])
    const touching = new Map(detail?.touching)
    const cargo: Record<string, unknown>[] = []
    let matched = 0
    for (let i = 0; i < f.count; i++) {
      const pos = [f.positions[i * 3]!, f.positions[i * 3 + 1]!, f.positions[i * 3 + 2]!]
      if (min && max && pos.some((v, k) => v < min[k]! || v > max[k]!)) continue
      matched++
      if (cargo.length >= CARGO_LIST_MAX) continue
      const hex = (k: number): string => Math.round(Math.max(0, Math.min(1, f.colors[i * 3 + k]!)) * 255).toString(16).padStart(2, '0')
      const key = f.shapes?.[i]
      const product = key ? f.shapeRefs?.[key]?.packageId : undefined
      cargo.push({
        id: f.ids[i],
        kind: cargoKindName(f.kinds[i]!),
        ...(product ? { product } : {}),
        position: pos.map(round),
        size: [f.halfExtents[i * 3]! * 2, f.halfExtents[i * 3 + 1]! * 2, f.halfExtents[i * 3 + 2]! * 2].map(round),
        color: `#${hex(0)}${hex(1)}${hex(2)}`,
        tiltDeg: Math.round(cargoTiltDeg(f, i)),
        yawDeg: Math.round(cargoYawDeg(f, i)),
        ...(f.partIds[i] ? { part: f.partIds[i] } : {}),
        ...(vel.has(f.ids[i]!) ? { vel: vel.get(f.ids[i]!)!.map(round) } : {}),
        ...(touching.has(f.ids[i]!) ? { touching: touching.get(f.ids[i]!) } : {}),
      })
    }
    return { running: true, ...(paused ? { paused: true } : {}), simTime: round(f.simTime), count: matched, cargo, ...(matched > cargo.length ? { omitted: matched - cargo.length } : {}) }
  },
}

// ── scene edits ─────────────────────────────────────────────────────────────────────────────────────

export const duplicatePartsTool: AgentTool = {
  name: 'duplicate_parts',
  description:
    'Copy a group of placed parts by an `offset` [x,y,z] in metres: a second station from the first, in one call. ' +
    "Parts soft-parented under them come along; links inside the group (parents, a spawner's conveyor) follow the " +
    'copies. Tags are renamed by `rename` ({ old: new }) first, then `tagSuffix` is appended to every other tag; ' +
    'without either the copies share their tags with the originals. Reports a copied tag two parts now write. One undo step.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
      offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      rename: { type: 'object', description: 'old tag -> new tag' },
      tagSuffix: { type: 'string' },
    },
    required: ['ids', 'offset'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    assertEditable(store)
    const scene = store.getState().scene
    const rename = new Map<string, string>()
    for (const [from, to] of Object.entries(optObj(args, 'rename') ?? {})) {
      if (typeof to !== 'string' || to.trim() === '') throw new AgentToolError(`rename '${from}' needs a tag name to rename it to`)
      rename.set(from, to.trim())
    }
    let r: ReturnType<typeof duplicateParts>
    try {
      r = duplicateParts(scene.parts, strList(args, 'ids'), { offset: optVec3(args, 'offset')!, rename, tagSuffix: optStr(args, 'tagSuffix') })
    } catch (e) {
      throw new AgentToolError(e instanceof Error ? e.message : String(e))
    }
    const next: SceneJSON = { ...scene, parts: [...scene.parts, ...r.copies] }
    store.commit(`${AGENT_LABEL}: duplicate ${r.copies.length === 1 ? 'part' : `${r.copies.length} parts`}`, next)
    return {
      copies: Object.fromEntries(r.idMap),
      tags: r.tags.map((t) => ({ part: t.partId, param: t.key, tag: t.tag, from: t.from })),
      ...(r.clashes.length > 0 ? { clashes: r.clashes.map((c) => `${c.copy.partId}.${c.copy.key} writes ${c.copy.tag}, which ${c.writers.map((w) => w.partId).join(', ')} also write${c.writers.length === 1 ? 's' : ''}`) } : {}),
      ...(r.shared.length > 0 ? { shared: r.shared.map((t) => `${t.partId}.${t.key} reads ${t.tag}, as its original does`) } : {}),
      ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}),
    }
  },
}

export const undoTool: AgentTool = {
  name: 'undo',
  description:
    "Take back the agent's own most recent edit (an \"Agent: ...\" step in the History dock), or with `redo` put it " +
    'back. It refuses when the step on top is the user\'s, so it never takes back their work. Not in a shared project.',
  inputSchema: { type: 'object', properties: { redo: { type: 'boolean' } }, additionalProperties: false },
  run: ({ store }, args) => {
    assertEditable(store)
    if (store.getState().collab) throw new AgentToolError('undo is not offered in a shared project: its history is shared')
    const redo = optBool(args, 'redo') ?? false
    const h = store.getEditHistory()
    const entry = redo ? h.events[h.cursor] : h.events[h.cursor - 1]
    if (!entry) throw new AgentToolError(`nothing to ${redo ? 'redo' : 'undo'}`)
    if (!entry.label.startsWith(`${AGENT_LABEL}:`)) throw new AgentToolError(`the step to ${redo ? 'redo' : 'undo'} is the user's ("${entry.label}"), not the agent's`)
    if (redo) store.redo()
    else store.undo()
    return { [redo ? 'redone' : 'undone']: entry.label }
  },
}

export const deleteTest: AgentTool = {
  name: 'delete_test',
  description: 'Remove a kept test from the project by name (list_tests lists them).',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  run: ({ store }, args) => {
    assertEditable(store)
    const name = str(args, 'name')
    if (!(store.snapshotProject().tests ?? []).some((t) => t.name === name)) throw new AgentToolError(`the project keeps no test named '${name}'`)
    if (!store.deleteProjectTest(name)) throw new AgentToolError('this editor cannot keep tests (it is view-only, or in a shared project of someone else\'s, which keeps none)')
    return { tests: (store.snapshotProject().tests ?? []).map((t) => t.name ?? '(unnamed)') }
  },
}
