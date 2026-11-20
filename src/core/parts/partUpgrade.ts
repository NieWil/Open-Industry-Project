// Upgrades from older stored package formats to PACKAGE_FORMAT, and the retired kinds a stored package may still
// name: each loads with its links dropped for a grace period.

import type { ParamSchema } from './partApi'
import { evalPartGeometry } from '../geometry/geometryEval'
import { resolvePartParams } from './partScript'
import { type ConveyorDecl, PACKAGE_FORMAT, type PackageUpgrade, type PartOrigin, type RigGeometry } from './partPackage'

/** How long a retired kind keeps loading after its retirement reaches main. Covers an autosave or a file that
 *  someone opens rarely. */
export const RETIRED_KIND_GRACE_MONTHS = 6

/** Rig shape kinds a package may no longer declare, with what to do instead. Authoring refuses them
 *  (validatePartPackage); a stored package goes through {@link upgradeStoredPackage} first, so older content still
 *  opens. Empty: the engine-built `chain` lane and `roller` bed are not listed, so an older save that still holds
 *  one of those links fails to load.
 *
 *  Each entry expires; the table and its handling stay. `npm run retired-kinds` works out the expiry: the grace
 *  period ({@link RETIRED_KIND_GRACE_MONTHS}) starts on the first main commit after which no shipped manifest
 *  (examples/parts) declares the kind. The grace period alone does not make removal safe: an older save with the
 *  link fails to load rather than loading without it, and an unopened collab room from before the deploy would feed
 *  the raw link to the renderer. So remove one only when `npm run retired-kinds -- --db <collab.sqlite>`, against a
 *  fresh backup of the production collab database (server/DEPLOY.md), reports it REMOVABLE: the grace period is over
 *  and no stored room or snapshot declares it. Keep this table and dropRetiredRigLinks when empty: the next retirement
 *  needs them. */
export const RETIRED_SHAPE_KINDS: Readonly<Record<string, {
  /** what to do instead, quoted in the authoring error */
  advice: string
  /** the day the kind was retired in the source (YYYY-MM-DD). Not the day its grace period starts: that is when the
   *  retirement reaches main, which `npm run retired-kinds` reads from git (scripts/retired-kinds.mjs) */
  retired: string
}>> = {}

/**
 * A stored package (a scene's embedded snapshot, a project's parts, a room) with its retired rig links removed:
 * each link whose shape kind is retired, every link parented beneath one (part of the same retired visual), and
 * every joint driving one of those. Returns the input itself when there is nothing to drop, so the common case
 * never copies. Only for loading what was saved: an author's manifest is refused instead, with
 * the reason (validatePartPackage). Every retired kind was render-only, so dropping one loses a visual, never a body.
 * Load points call {@link upgradeStoredPackage}, which runs this after any format upgrade. `retired` is the table to
 * judge by; only a test passes another.
 */
export function dropRetiredRigLinks<T>(raw: T, retired: Readonly<Record<string, unknown>> = RETIRED_SHAPE_KINDS): { pkg: T; dropped: string[] } {
  const geo = (raw as { geometry?: { kind?: unknown; links?: unknown; joints?: unknown } } | null)?.geometry
  if (!geo || geo.kind !== 'rig' || !Array.isArray(geo.links)) return { pkg: raw, dropped: [] }
  const links = geo.links as { name?: unknown; parent?: unknown; shape?: { kind?: unknown } }[]
  const gone = new Set<unknown>(links.filter((l) => typeof l?.shape?.kind === 'string' && Object.hasOwn(retired, l.shape.kind)).map((l) => l.name))
  if (gone.size === 0) return { pkg: raw, dropped: [] }
  // descendants go with their retired ancestor (fixed point: links may be listed in any order)
  for (let grew = true; grew; ) {
    grew = false
    for (const l of links) if (!gone.has(l?.name) && l?.parent !== undefined && gone.has(l.parent)) { gone.add(l.name); grew = true }
  }
  const joints = Array.isArray(geo.joints) ? (geo.joints as { link?: unknown }[]).filter((j) => !gone.has(j?.link)) : geo.joints
  const pkg = { ...(raw as object), geometry: { ...geo, links: links.filter((l) => !gone.has(l?.name)), ...(joints !== undefined ? { joints } : {}) } } as T
  return { pkg, dropped: [...gone].map(String) }
}

/**
 * How a stored package of an older format is carried forward, keyed by the format each step upgrades from.
 *   1 -> 2: a rig link's seven lamp fields became one {@link RigLink.lamps} list plus
 *          {@link RigLink.squash} ({@link upgradeLampsToFormat2}).
 *   2 -> 3: the stair-and-platform words became general ones: `snap.stairMount` is an `edgeMount`
 *          facing into the deck, `railing` is `onEdge`, `stairFoot` is `anchor: 'floor'`, and a diverter's
 *          guard-opening mount says `opens` ({@link upgradeCutsToFormat3}).
 *   3 -> 4: the vocabulary pass (docs/sdk-vocabulary.md): one word per idea, one place per
 *          declaration ({@link upgradeToFormat4}).
 *   4 -> 5: a sensor beam names its params (`rangeParam` / `showParam`) instead of the host reading params
 *          named `maxRange` / `showBeam` ({@link upgradeBeamsToFormat5}).
 *   5 -> 6: `basedOn` and `fromShelf` became one {@link PartOrigin} keyed by source, `origin.app` and
 *          `origin.shelf` (docs/part-sources.md; {@link canonicalOrigin}).
 *
 * This is how a manifest field is renamed, merged or removed without a grace period. Scenes, project libraries and
 * collab rooms embed every package they use, so a shipped field is read forever unless rewritten on the way in. To
 * change one: bump PACKAGE_FORMAT, add the step from the old number here, and make the validator and renderer know
 * only the new spelling. A step stays forever (a document of that format may always exist) and costs one function.
 *
 * The cost of a bump: an older build (an open tab from before the deploy, a peer in the same room) refuses a newer
 * format by name ("saved by a newer version"). So bump only for a change a step has to translate; an added
 * optional field needs no bump, since an older build never reads it.
 */
export const PACKAGE_UPGRADES: Readonly<Record<number, PackageUpgrade>> = {
  1: upgradeLampsToFormat2,
  2: upgradeCutsToFormat3,
  3: upgradeToFormat4,
  4: upgradeBeamsToFormat5,
  5: (pkg) => ({ pkg: canonicalOrigin(pkg), notes: [] }),
}

/**
 * A stored package or manifest with its record in the current spelling: before package format 6 it was two fields,
 * `basedOn` (the built-in a project's version was made from) and `fromShelf` (the shelf version it was copied from);
 * they become `origin.app` and `origin.shelf`. A key `origin` already has keeps its value. Returns the argument itself when there
 * is nothing to move. Used by the format 6 upgrade step (a stored package, {@link PACKAGE_UPGRADES}) and the package
 * build (a manifest a project folder or the shelf wrote before format 6: those carry no format number to upgrade by).
 */
export function canonicalOrigin<T>(raw: T): T {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || (!('basedOn' in r) && !('fromShelf' in r))) return raw
  const { basedOn, fromShelf, ...rest } = r
  const legacy: Record<string, unknown> = {}
  if (typeof basedOn === 'string' && basedOn !== '') legacy.app = basedOn
  if (typeof fromShelf === 'string' && fromShelf !== '') legacy.shelf = fromShelf
  const had = rest.origin && typeof rest.origin === 'object' ? (rest.origin as PartOrigin) : undefined
  const origin = { ...legacy, ...had }
  return (Object.keys(origin).length > 0 ? { ...rest, origin } : rest) as T
}

/**
 * The rig a retired one-box `deck` geometry becomes (format 4), in the current spelling: the same conveyor in the
 * general form. A conveying box `thick` deep with its top at the origin (the body the sim always built: conveyor
 * friction, surface velocity from the behavior), in the concrete deck finish, plus the yellow bar the deck drew
 * near its discharge end; bounds that give the same footprint (y from -thick to 0.05). Also what a retired sweep
 * becomes ({@link replaceSweepGeometry}).
 */
export function deckRig(length: number, width: number, thick = 0.1): RigGeometry {
  const bar = Math.max(length * 0.07, 0.06)
  return {
    kind: 'rig',
    links: [
      { name: 'deck', shape: { kind: 'box', size: [length, thick, width] }, offset: [0, -thick / 2, 0], conveys: true, finish: 'deck', notchable: true },
      // the deck's discharge-end bar: sRGB #f2bd0f in linear, decoration only
      { name: 'accent', shape: { kind: 'box', size: [bar, 0.012, Math.max(width * 0.8, 0.05)] }, offset: [length / 2 - bar, 0.008, 0], color: [0.888, 0.509, 0.0048], metalness: 0.1, roughness: 0.5, collision: 'none' },
    ],
    joints: [],
    bounds: { length, width, top: 0.05, bottom: -thick },
  }
}

/**
 * A snap declaration in the current spelling. `snap` is read out of a part's behavior (`definePart({ snap })`), and
 * behavior code is stored verbatim in documents and rooms, so a script written for an older format keeps declaring
 * the old words forever; the package build reads it through here (sim/validatePart.ts), and the format 4 upgrade
 * step uses it on a stored package's `snap`. Format 4: `edges` -> `tile`. Returns the argument itself when nothing
 * changed.
 */
export function canonicalSnap<T>(snap: T): T {
  const s = snap as Record<string, unknown> | undefined
  if (!s || typeof s !== 'object' || !('edges' in s)) return snap
  const { edges, ...rest } = s
  return (rest.tile === undefined && edges !== undefined ? { ...rest, tile: edges } : rest) as T
}

/**
 * The conveyor format 3 inferred from a package, as a declaration (the format 4 upgrade step). Each test is the one
 * the host's classifiers applied in format 3 (the belt, curve, straight, spur and turntable views then in
 * core/parts/partGeometry.ts), frozen here: they are what an old package meant, whatever the live rules become.
 */
function inferConveyorV3(pkg: Record<string, unknown>): ConveyorDecl | undefined {
  const params = (pkg.params ?? {}) as Record<string, { handle?: Record<string, unknown> } | undefined>
  const handles = Object.values(params).map((spec) => (spec && typeof spec === 'object' ? spec.handle : undefined)).filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
  const geo = (pkg.geometry ?? {}) as { kind?: unknown; conveys?: unknown; links?: unknown; joints?: unknown }
  const links = Array.isArray(geo.links) ? (geo.links as Record<string, unknown>[]) : []
  const conveys = geo.kind === 'drawn' ? geo.conveys === true : geo.kind === 'rig' ? links.some((l) => l && l.conveys === true) : false
  const faceX = handles.find((h) => h.kind === 'face' && h.axis === 'x')
  const faceZ = handles.some((h) => h.kind === 'face' && h.axis === 'z')
  let bed: ConveyorDecl['bed']
  if (handles.some((h) => h.kind === 'path')) bed = 'path'
  else if (conveys && handles.some((h) => h.kind === 'arc')) bed = 'arc'
  else if (conveys && faceX && faceZ) bed = faceX.angleFrontParam !== undefined || faceX.angleBackParam !== undefined ? 'spur' : 'straight'
  else if (geo.kind === 'rig' && Array.isArray(geo.joints)) {
    const joint = (geo.joints as { type?: unknown; link?: unknown }[]).find((j) => j && j.type === 'revolute')
    const deck = joint ? links.find((l) => l && l.name === joint.link) : undefined
    if ((deck?.shape as { kind?: unknown } | undefined)?.kind === 'cylinder') bed = 'turntable'
  }
  let belt = bed === 'path'
  if (!belt && geo.kind === 'drawn' && conveys && typeof pkg.behavior === 'string') {
    const parts = evalPartGeometry(pkg.behavior, resolvePartParams(pkg.params as ParamSchema, {}))
    belt = (parts ?? []).some((mp) => mp.finish === 'belt')
  }
  // the names format 3's host mirrored, on a part that conveys
  const speedParam = conveys && (params.speed as { type?: unknown } | undefined)?.type === 'number' ? 'speed' : undefined
  const reverseParam = conveys && (params.reverse as { type?: unknown } | undefined)?.type === 'boolean' ? 'reverse' : undefined
  if (!bed && !belt && !speedParam) return undefined
  return { ...(bed ? { bed } : {}), surface: belt ? 'belt' : 'roller', ...(speedParam ? { speedParam } : {}), ...(reverseParam ? { reverseParam } : {}) }
}

/** Which side of the bed (-Z = left) a link sits on, from its Z offset (base, else the sign of a width-scaled
 *  offsetParam); null when centred. What format 3 read a guard's or frame's side from; format 4 declares it. */
function linkZSide(link: RawLink): 'left' | 'right' | null {
  const offset = Array.isArray(link.offset) ? (link.offset as unknown[]) : []
  let z = typeof offset[2] === 'number' ? offset[2] : 0
  if (z === 0 && Array.isArray(link.offsetParams)) {
    const p = (link.offsetParams as { axis?: unknown; scale?: unknown }[]).find((o) => o && o.axis === 2)
    z = typeof p?.scale === 'number' ? p.scale : 0
  }
  return z === 0 ? null : z < 0 ? 'left' : 'right'
}

/** A rig link as a plain record, for the upgrade steps (which read stored JSON, not typed packages). */
type RawLink = Record<string, unknown> & { shape?: Record<string, unknown> }

/**
 * Format 3 -> 4: the vocabulary pass (docs/sdk-vocabulary.md), one small function per rename over a link or the
 * package, in the order they were made.
 *   link.edges (a wireframe colour)          -> link.outline
 *   link.noCollision: true                   -> link.collision: 'none'
 *   a mesh shape's collision: { size }       -> the link's collision: { box: size }
 *   geometry kind 'function'                 -> 'drawn'
 *   link.array.enabledParam / .grid.enabledParam -> link.showParam (an array that was only the gate is dropped)
 *   a primitive lamp link's color            -> lamps[0].offColor (the colour the lamp shows while dark)
 *   a boolean param named enableComms        -> commsParam: 'enableComms'
 *   no conveyor declaration                  -> conveyor: { bed, surface } where format 3 inferred one, by the same
 *                                               tests (inferConveyorV3): a path handle, a conveying arc handle,
 *                                               conveying x + z face handles (spur when the length handle names
 *                                               splay angles), a revolute joint on a cylinder link; surface belt
 *                                               for a path bed or a drawn bed that draws a belt (default params),
 *                                               else roller; on a conveying part, a number param named speed ->
 *                                               speedParam, a boolean named reverse -> reverseParam
 *   link.grabZone / grabRadius / grabParams  -> link.grip: { zone, radius, radiusParams }
 *   bounds { height, floorY }                -> bounds { top, bottom } (rig, drawn); a cargo box's bounds -> size
 *   snap.edges                               -> snap.tile (also for a snap read from stored behavior code,
 *                                               {@link canonicalSnap})
 *   link role: r                             -> finish: r, plus what the role switched on: a guard / frame box
 *                                               off the centreline -> sideGuard / sideRail: its side; a frame on
 *                                               a conveying rig -> bed: true; a deck box -> notchable: true.
 *                                               (A centred guard-finish box loses its zero friction; no shipped
 *                                               part had one.)
 *   geometry kind 'deck' { length, width }   -> the rig {@link deckRig} builds (same body, footprint and look)
 *   shape kind 'deck' { length, width, h }   -> a box [length, h ?? 0.1, width] with conveys: true
 */
function upgradeToFormat4(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; notes: string[] } {
  const notes: string[] = []
  let geo = pkg.geometry as { kind?: unknown; links?: unknown; length?: unknown; width?: unknown; height?: unknown } | undefined
  let out = pkg
  if (geo && geo.kind === 'function') {
    geo = { ...geo, kind: 'drawn' }
    out = { ...out, geometry: geo }
  }
  if (geo && geo.kind === 'deck') {
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)
    geo = deckRig(num(geo.length, 1), num(geo.width, 1), num(geo.height, 0.1)) as unknown as typeof geo
    out = { ...out, geometry: geo }
  }
  if (geo && geo.kind === 'rig' && Array.isArray(geo.links)) {
    const rigConveys = (geo.links as RawLink[]).some((l) => l && typeof l === 'object' && l.conveys === true)
    const links = (geo.links as RawLink[]).map((raw) => (raw && typeof raw === 'object' ? upgradeLinkTo4(raw, rigConveys, notes) : raw))
    out = { ...out, geometry: { ...geo, links } }
  }
  // bounds: height / floorY -> top / bottom (rig, drawn); a cargo box's bounds -> size
  const g4 = out.geometry as Record<string, unknown> | undefined
  if (g4 && typeof g4 === 'object') {
    const b = g4.bounds as Record<string, unknown> | undefined
    if (g4.kind === 'cargo' && b !== undefined && g4.size === undefined) {
      const { bounds: _b, ...rest } = g4
      out = { ...out, geometry: { ...rest, size: b } }
    } else if (b && typeof b === 'object' && ('height' in b || 'floorY' in b)) {
      const { height, floorY, ...rest } = b
      out = { ...out, geometry: { ...g4, bounds: { ...rest, ...(height !== undefined ? { top: height } : {}), ...(floorY !== undefined ? { bottom: floorY } : {}) } } }
    }
  }
  if (out.snap && typeof out.snap === 'object') {
    const snap = canonicalSnap(out.snap)
    if (snap !== out.snap) out = { ...out, snap }
  }
  if (out.conveyor === undefined) {
    const conveyor = inferConveyorV3(out)
    if (conveyor) out = { ...out, conveyor }
  }
  if (out.commsParam === undefined && ((out.params ?? {}) as Record<string, { type?: unknown } | undefined>).enableComms?.type === 'boolean') out = { ...out, commsParam: 'enableComms' }
  return { pkg: out, notes }
}

/**
 * Package format 4 -> 5: a beam's params become its own declaration. Format 4 drew every beam of a part out to the
 * part's `maxRange` number param when the beam named no `rangeParam`, and hid them all on a false `showBeam` boolean
 * param. This writes those names onto each beam that relied on them. A `rangeParam` also sets the sensing reach,
 * which format 4's name did not (sensing used the static `range`), so the note says so.
 */
function upgradeBeamsToFormat5(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; notes: string[] } {
  const notes: string[] = []
  const geo = pkg.geometry as { kind?: unknown; links?: unknown } | undefined
  if (!geo || geo.kind !== 'rig' || !Array.isArray(geo.links)) return { pkg, notes }
  const params = (pkg.params ?? {}) as Record<string, { type?: unknown } | undefined>
  const range = params.maxRange?.type === 'number'
  const show = params.showBeam?.type === 'boolean'
  if (!range && !show) return { pkg, notes }
  let changed = false
  const links = (geo.links as RawLink[]).map((l) => {
    const beam = l && typeof l === 'object' ? (l.beam as Record<string, unknown> | undefined) : undefined
    if (!beam || typeof beam !== 'object') return l
    const next = { ...beam }
    if (range && next.rangeParam === undefined) {
      next.rangeParam = 'maxRange'
      notes.push(`link "${String(l.name)}": its beam now takes its length from the maxRange param by name (beam.rangeParam), which also sets how far it senses`)
    }
    if (show && next.showParam === undefined) next.showParam = 'showBeam'
    if (next.rangeParam === beam.rangeParam && next.showParam === beam.showParam) return l
    changed = true
    return { ...l, beam: next }
  })
  return changed ? { pkg: { ...pkg, geometry: { ...geo, links } }, notes } : { pkg, notes }
}

function upgradeLinkTo4(raw: RawLink, rigConveys: boolean, notes: string[]): RawLink {
  const { edges, noCollision, role, grabZone, grabRadius, grabParams, ...link } = raw
  const next: RawLink = { ...link }
  if (grabZone !== undefined || grabRadius !== undefined || grabParams !== undefined) {
    next.grip = { ...(grabZone !== undefined ? { zone: grabZone } : {}), ...(grabRadius !== undefined ? { radius: grabRadius } : {}), ...(grabParams !== undefined ? { radiusParams: grabParams } : {}) }
  }
  if (edges !== undefined) next.outline = edges
  if (noCollision === true) next.collision = 'none'
  const array = raw.array as (Record<string, unknown> & { grid?: Record<string, unknown> }) | undefined
  if (array && typeof array === 'object') {
    // array.enabledParam / array.grid.enabledParam -> the link's showParam; an array that was only the gate goes
    const gate = array.enabledParam ?? array.grid?.enabledParam
    if (gate !== undefined) {
      const { enabledParam: _g, ...restArray } = array
      if (restArray.grid && typeof restArray.grid === 'object') {
        const { enabledParam: _gg, ...grid } = restArray.grid
        restArray.grid = grid
      }
      if (restArray.distribute === undefined && restArray.count === undefined && restArray.grid === undefined) delete next.array
      else next.array = restArray
      if (next.showParam === undefined) next.showParam = gate
      else if (next.showParam !== gate) notes.push(`link "${String(raw.name)}" had both showParam "${String(next.showParam)}" and an array gate "${String(gate)}"; format 4 has one switch per link, so it keeps showParam and the link no longer follows "${String(gate)}"`)
    }
  }
  // a primitive lamp link's colour was its lamp's unlit colour: say it on the lamp
  const lamps = raw.lamps
  if (raw.color !== undefined && raw.shape?.kind !== 'mesh' && Array.isArray(lamps) && lamps.length > 0 && lamps[0] && typeof lamps[0] === 'object') {
    const [first, ...others] = lamps as Record<string, unknown>[]
    next.lamps = [first!.offColor === undefined ? { ...first, offColor: raw.color } : first, ...others]
    delete next.color
  }
  if (role !== undefined) {
    next.finish = role
    // what the role switched on, spelled out (format 3 read these off the finish): a guard or frame box off the
    // centreline was a side wall, a frame on a conveying rig joined the conveyor gates, a deck box took notches
    const isBox = raw.shape?.kind === 'box'
    const side = isBox ? linkZSide(raw) : null
    if (role === 'guard' && side) next.sideGuard = side
    if (role === 'frame' && side) next.sideRail = side
    if (role === 'frame' && rigConveys) next.bed = true
    if (role === 'deck' && isBox) next.notchable = true
  }
  const shape = raw.shape
  if (shape && shape.kind === 'deck') {
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)
    next.shape = { kind: 'box', size: [num(shape.length, 1), num(shape.height, 0.1), num(shape.width, 1)] }
    next.conveys = true
  }
  if (shape && shape.kind === 'mesh' && shape.collision !== undefined) {
    const { collision, ...rest } = shape
    next.shape = rest
    const size = (collision as { size?: unknown } | null)?.size
    if (size !== undefined) next.collision = { box: size }
  }
  return next
}

/**
 * Format 2 -> 3: the words that tied neighbour cuts to one pairing (docs/part-snap-cuts.md).
 *   link.railing: edge                 -> link.onEdge: edge
 *   link.stairFoot: true               -> link.anchor: 'floor'
 *   snap.stairMount { accepts, widthParam, stepsParam, reach, risePerStep, treadRun, landingDepth, topOffset }
 *                                      -> snap.edgeMount { accepts, alongParam: widthParam, reach, facing: 'into',
 *                                           at: [landingDepth, topOffset, 0], atParams: steps x tread along X and
 *                                           steps x rise up, fromFloor: { param: stepsParam }, opens, notch, lift }
 *   a mount facing OUT onto a conveyorGuard  -> the same mount with opens: true (format 2 read the facing as "opens")
 * A part carrying both a stairMount and an edgeMount keeps its edgeMount and loses the stairMount, with a note: a
 * package has one edge connector, and no shipped part ever declared both.
 */
function upgradeCutsToFormat3(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; notes: string[] } {
  const notes: string[] = []
  let out = pkg
  const geo = pkg.geometry as { kind?: unknown; links?: unknown } | undefined
  if (geo && geo.kind === 'rig' && Array.isArray(geo.links)) {
    const links = (geo.links as Record<string, unknown>[]).map((raw) => {
      if (!raw || typeof raw !== 'object' || !('railing' in raw || 'stairFoot' in raw)) return raw
      const { railing, stairFoot, ...link } = raw
      return { ...link, ...(railing !== undefined ? { onEdge: railing } : {}), ...(stairFoot === true ? { anchor: 'floor' } : {}) }
    })
    out = { ...out, geometry: { ...geo, links } }
  }
  const snap = pkg.snap as Record<string, unknown> | undefined
  if (snap && typeof snap === 'object') {
    let next: Record<string, unknown> = snap
    const sm = snap.stairMount as Record<string, unknown> | undefined
    if (sm !== undefined) {
      const { stairMount: _gone, ...rest } = next
      next = rest
      if (snap.edgeMount !== undefined) notes.push('snap.stairMount dropped: the part also declares an edgeMount, and a package has one edge connector')
      else if (sm && typeof sm === 'object') {
        const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
        // format 2's defaults, frozen here: they are what an old stairMount meant, whatever the live ones become
        const TREAD_V2 = 0.28
        const RISE_V2 = 0.178
        const steps = sm.stepsParam
        next = {
          ...next,
          edgeMount: {
            accepts: sm.accepts,
            alongParam: sm.widthParam,
            reach: sm.reach,
            facing: 'into',
            at: [num(sm.landingDepth, 0), num(sm.topOffset, 0), 0],
            atParams: [
              { axis: 0, param: steps, scale: num(sm.treadRun, TREAD_V2) },
              { axis: 1, param: steps, scale: num(sm.risePerStep, RISE_V2) },
            ],
            fromFloor: { param: steps },
            opens: true,
            notch: true,
            lift: true,
          },
        }
      }
    }
    if (Array.isArray(next.mounts)) {
      const mounts = (next.mounts as Record<string, unknown>[]).map((m) => (m && m.face === 'out' && m.accepts === 'conveyorGuard' && m.opens === undefined ? { ...m, opens: true } : m))
      next = { ...next, mounts }
    }
    if (next !== snap) out = { ...out, snap: next }
  }
  return { pkg: out, notes }
}

/**
 * Format 1 -> 2: a rig link's lamp fields, spelled seven ways, become {@link RigLink.lamps} + {@link RigLink.squash}.
 *   link.emissive, lampParam, lampOpacity      -> lamps: [{ emissive, param, opacity }]     (a primitive's own lamp)
 *   mesh shape.lamp + link.emissive            -> lamps: [{ emissive, material, param, opacity }]
 *   mesh shape.lamps[{ name, material, ... }]  -> lamps: [{ name, material, emissive, opacity }]
 *   link.lampSquash, squashLamp                -> squash: { amount, lamp }
 * A format-1 `lampParam` lit the lamp named like the link, so it goes to that lamp. Two things format 1 accepted
 * that did nothing are dropped with a note, because format 2 refuses them: an `emissive` on a mesh link with no
 * `lamp` material (nothing to light), and a `lampSquash` off a mesh link (only a mesh link's clones squash).
 */
function upgradeLampsToFormat2(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; notes: string[] } {
  const geo = pkg.geometry as { kind?: unknown; links?: unknown } | undefined
  if (!geo || geo.kind !== 'rig' || !Array.isArray(geo.links)) return { pkg, notes: [] }
  const notes: string[] = []
  const links = (geo.links as Record<string, unknown>[]).map((raw) => {
    if (!raw || typeof raw !== 'object') return raw
    const { emissive, lampParam, lampOpacity, lampSquash, squashLamp, ...link } = raw as Record<string, unknown>
    const shapeIn = link.shape as Record<string, unknown> | undefined
    const mesh = shapeIn?.kind === 'mesh'
    let shape = shapeIn
    const lamps: Record<string, unknown>[] = []
    if (mesh && shapeIn) {
      const { lamp, lamps: specs, ...rest } = shapeIn
      shape = rest
      if (Array.isArray(specs)) for (const spec of specs as Record<string, unknown>[]) lamps.push({ ...spec })
      else if (typeof lamp === 'string' && emissive !== undefined) lamps.push({ emissive, material: lamp })
      else if (emissive !== undefined) notes.push(`link "${String(link.name)}": emissive on a mesh with no lamp material lit nothing; dropped`)
    } else if (emissive !== undefined) lamps.push({ emissive })
    for (const lamp of lamps) {
      if ((lamp.name ?? link.name) !== link.name) continue
      if (lampParam !== undefined) lamp.param = lampParam
      if (lampOpacity !== undefined && lamp.opacity === undefined) lamp.opacity = lampOpacity
    }
    const out: Record<string, unknown> = { ...link, ...(shape ? { shape } : {}) }
    if (lamps.length > 0) out.lamps = lamps
    if (lampSquash !== undefined) {
      if (mesh) out.squash = { amount: lampSquash, ...(squashLamp !== undefined ? { lamp: squashLamp } : {}) }
      else notes.push(`link "${String(link.name)}": lampSquash off a mesh link squashed nothing; dropped`)
    }
    return out
  })
  return { pkg: { ...pkg, geometry: { ...geo, links } }, notes }
}

/**
 * The one way in for a stored package (a scene's embedded snapshot, a project's parts, a room entry): upgraded
 * step by step to {@link PACKAGE_FORMAT}, then its retired rig links dropped ({@link dropRetiredRigLinks}), so
 * every load point handles every old document the same way. Validate the result with validatePartPackage as
 * before. `repairs` lists what was lost or replaced, for the load's repair report; a format upgrade that only
 * respells is not listed. `pkg` is the input itself, uncopied, when nothing at all changed.
 *
 * Anything it cannot carry forward (not an object, no numeric format, a format newer than this build, a missing
 * step) comes back unchanged, and validatePartPackage names the reason. An author's own manifest does not come
 * through here: it is refused with the reason instead (validatePartPackage, check-part).
 */
export function upgradeStoredPackage<T>(raw: T, upgrades: Readonly<Record<number, PackageUpgrade>> = PACKAGE_UPGRADES, current: number = PACKAGE_FORMAT): { pkg: T; repairs: string[] } {
  const repairs: string[] = []
  let pkg: unknown = raw
  const from = (raw as { format?: unknown } | null)?.format
  if (typeof raw === 'object' && raw !== null && Number.isInteger(from) && (from as number) < current) {
    let f = from as number
    let next = raw as Record<string, unknown>
    const notes: string[] = []
    for (; f < current; f++) {
      const step = upgrades[f]
      if (!step) break
      const out = step(next)
      next = { ...out.pkg, format: f + 1 }
      notes.push(...out.notes)
    }
    if (f === current) {
      pkg = next
      // a respelling that loses nothing is not a repair (validate-project --strict fails on repairs, and every
      // document saved before a bump would trip it); only what a step had to drop is reported
      if (notes.length > 0) repairs.push(`package format ${from as number} -> ${current}: ${notes.join('; ')}`)
    }
  }
  const { pkg: kept, dropped } = dropRetiredRigLinks(pkg)
  if (dropped.length > 0) repairs.push(`retired rig link(s) ${dropped.join(', ')} dropped`)
  const { pkg: flat, replaced } = replaceSweepGeometry(kept)
  if (replaced) repairs.push(`retired sweep geometry replaced by a flat deck of the same footprint`)
  const { pkg: unexposed, dropped: exposes } = dropRetiredExposes(flat)
  if (exposes) repairs.push(`retired exposes (a scoped cell's public tags) dropped`)
  const { pkg: snapped, dropped: snapKinds } = dropRetiredSnapKinds(unexposed)
  if (snapKinds.length > 0) repairs.push(`retired ${snapKinds.join(' and ')} dropped`)
  return { pkg: dropServoRamps(snapped) as T, repairs }
}

/** A stored package with its servo joints' `ramp` / `maxJerk` removed. Older parts can carry them, and every servo move
 *  is a trapezoid, so they mean nothing. The input itself when there are none. */
function dropServoRamps<T>(raw: T): T {
  const geo = (raw as { geometry?: { joints?: unknown } } | null)?.geometry
  const joints = geo?.joints
  if (!Array.isArray(joints)) return raw
  const has = (j: unknown): boolean => {
    const s = (j as { servo?: unknown } | null)?.servo
    return typeof s === 'object' && s !== null && ('ramp' in s || 'maxJerk' in s)
  }
  if (!joints.some(has)) return raw
  const next = joints.map((j: unknown) => {
    if (!has(j)) return j
    const { ramp: _ramp, maxJerk: _jerk, ...servo } = (j as { servo: Record<string, unknown> }).servo
    return { ...(j as object), servo }
  })
  return { ...(raw as object), geometry: { ...geo, joints: next } } as T
}

/**
 * `snap.ports` (point-to-point mates, every conveyor end an implicit port) and `snap.rails` (an explicit segment a
 * mount slides along) are retired snap kinds. No first-party or example part declares one. A stored package that
 * still carries one loses it here, with a repair line (a custom part could have declared one; the part keeps
 * loading and stops snapping by it).
 * An author's manifest is refused with the reason instead (validateSnap). Returns the input itself when neither is
 * present.
 */
export const RETIRED_SNAP_KINDS = ['ports', 'rails'] as const
export const RETIRED_SNAP_ADVICE = "A device seats on a host with `mounts` (onto a conveyor's guards, a declared `surfaces` entry, or any footprint `'face'`)."

export function dropRetiredSnapKinds<T>(raw: T): { pkg: T; dropped: string[] } {
  const snap = (raw as { snap?: unknown } | null)?.snap
  if (typeof snap !== 'object' || snap === null) return { pkg: raw, dropped: [] }
  const dropped: string[] = RETIRED_SNAP_KINDS.filter((k) => k in snap)
  if (dropped.length === 0) return { pkg: raw, dropped: [] }
  const kept = Object.fromEntries(Object.entries(snap).filter(([k]) => !dropped.includes(k)))
  return { pkg: { ...(raw as object), snap: kept } as T, dropped: dropped.map((k) => `snap.${k}`) }
}

/**
 * `exposes` listed the tags a part offered a scene program when it was placed as a scoped cell: the public half of
 * PLC tag scoping, retired with it. A part's PLC interface is its `'tag'` params, wired by name. A stored
 * package that still carries the field loses it here (it described nothing that runs, so nothing changes); an
 * author's manifest is refused with the reason instead (sim/validatePart.ts). Returns the input itself when absent.
 */
export function dropRetiredExposes<T>(raw: T): { pkg: T; dropped: boolean } {
  if (typeof raw !== 'object' || raw === null || !('exposes' in raw)) return { pkg: raw, dropped: false }
  const { exposes: _retired, ...rest } = raw as Record<string, unknown>
  return { pkg: rest as T, dropped: true }
}

/** The retired whole-part geometry kind: a declarative swept bed, `{ kind: 'mesh', sweep, bounds, conveys? }`.
 *  `geometry()` draws any swept, inclined or curved bed and more, and the sweep is not on the authoring ladder
 *  (docs/procedural-geometry.md). Its physics was a flat deck (an arc or incline was drawn curved but carried
 *  cargo flat), so a stored one becomes exactly that deck ({@link replaceSweepGeometry}).
 *  Not to be confused with a rig link's `shape.kind: 'mesh'`, a GLB model, which stays. Retired. */
export const RETIRED_SWEEP_KIND = 'mesh'
export const RETIRED_SWEEP_ADVICE = "draw the bed in the behavior's geometry() with g.sweep (a function geometry, `conveys: true` for a conveyor), as examples/parts/belt-conveyor does"

/**
 * A stored package whose geometry is the retired sweep ({@link RETIRED_SWEEP_KIND}) with a flat `deck` in its
 * place: the footprint the sim already built for it (the sweep's own length, its profile's width), so cargo rides
 * it as before. What is lost is the drawn profile and any param-driven length, which a deck does not have. Unlike
 * a retired rig link this never expires: it converts rather than drops, so it costs a few lines and no grace
 * period. Returns the input itself when there is nothing to replace.
 */
export function replaceSweepGeometry<T>(raw: T): { pkg: T; replaced: boolean } {
  const geo = (raw as { geometry?: { kind?: unknown; sweep?: { profile?: unknown; length?: unknown }; bounds?: { length?: unknown; width?: unknown } } } | null)?.geometry
  if (!geo || geo.kind !== RETIRED_SWEEP_KIND) return { pkg: raw, replaced: false }
  const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  const profile = Array.isArray(geo.sweep?.profile) ? (geo.sweep.profile as unknown[]) : []
  const ws = profile.map((pt) => (Array.isArray(pt) ? pt[1] : undefined)).filter((w): w is number => typeof w === 'number' && Number.isFinite(w))
  const profileWidth = ws.length ? Math.max(...ws) - Math.min(...ws) : 0
  const length = positive(geo.sweep?.length) ? geo.sweep.length : positive(geo.bounds?.length) ? geo.bounds.length : 1
  const width = positive(profileWidth) ? profileWidth : positive(geo.bounds?.width) ? geo.bounds.width : 1
  return { pkg: { ...(raw as object), geometry: deckRig(length, width) } as T, replaced: true }
}
