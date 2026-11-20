import * as Y from 'yjs'
import { sanitizeParents } from '../core/scene/hierarchy'
import { normalizePart } from '../core/scene/scene'
import { PART_DEFS, SCENE_VERSION, toSimRate } from '../core/types'
import { fromRoomEntry, toRoomEntry } from './roomAssets'
import type { ParamSpec, ParamValue, PartInstance, PartType, SceneJSON, SdkPart, SimRate } from '../core/types'
import { upgradeStoredPackage } from '../core/parts/partUpgrade'
import type { PartPackage } from '../core/parts/partPackage'
import { validateController } from '../core/controller'
import { validateScenePlcs } from '../core/scene/scenePlcs'
import { readSavedUnits } from '../core/scene/sceneUnits'
import { readDisplayList } from '../core/scene/sceneDisplay'
import type { Controller } from '../core/controller'
import { storedDialect } from '../core/dialect'
import { changedSpan } from '../core/textDiff'

/**
 * Yjs document schema for a collaboratively-edited scene, and the pure conversions
 * between it and the editor's `SceneJSON`.
 *
 * Layout (one `Y.Doc` per room):
 *   parts : Y.Map<id, Y.Map>   one Y.Map per part: scalar fields plain, `params` a nested Y.Map,
 *                              so two concurrent edits to the same part (a drag vs an Inspector
 *                              toggle) merge field-by-field instead of clobbering.
 *   order : Y.Array<string>    canonical part order (reorder / move up-down / tree); the standard
 *                              Yjs map-of-data + array-of-keys pattern.
 *   meta  : Y.Map              version (the SceneJSON version) + the shared program's scan time.
 *
 * Position is three keys px/py/pz, not a Y.Array, so concurrent moves land last-writer-wins per
 * axis instead of a torn [newX, oldY, newZ] merge. List/object params (segments, rules,
 * guardOpenings, ...) are JSON-string atoms: the editor always rewrites them as whole arrays, so
 * a per-element CRDT would gain nothing and conflict with that contract.
 *
 * SDK parts (`type: 'part'`) are package-driven, not PART_DEFS-driven:
 *   - `packageId` is the instance's identity; without it a peer materializes a blank placeholder.
 *   - the static spec walk writes nothing for them (`PART_DEFS['part'].params` is empty by
 *     design), so the param bag is carried verbatim. Its values are all Yjs Any, so decoding
 *     doesn't depend on the package being registered yet (a part can arrive before its package).
 */

export const PARTS_KEY = 'parts'
export const ORDER_KEY = 'order'
export const META_KEY = 'meta'
/** top-level Y.Text holding the shared ST program (co-edited via y-codemirror.next) */
export const ST_PROGRAM_TEXT = 'stProgram'
/** `meta` key holding the shared program's scan (cycle) time in ms. The scan time is part of the
 *  program, so a room carries it too - otherwise every peer runs the author's logic at their own
 *  cycle rate, and a scene exported from the room loses the timing it was tuned at. */
export const ST_SCAN_MS_META = 'stScanMs'
/** `meta` key holding the shared program's controller table (core/controller.ts) as a JSON string: the
 *  tasks it runs on, part of the program for the same reason as the scan time. One atom rather than a
 *  nested map: the table is small and edited a row at a time, so last writer wins is the right merge. */
export const ST_CONTROLLER_META = 'stController'
/** `meta` key holding the shared program's dialect (core/dialect.ts) as a plain string: part of the program for the
 *  same reason as the table. Absent for IEC, so a room with an IEC program never gains the key; any other value is
 *  kept as the room holds it, which is what lets a build that cannot run it leave it alone. */
export const ST_DIALECT_META = 'stDialect'
/**
 * packages : Y.Map<packageId, Y.Map>   one Y.Map per custom-part PACKAGE (geometry + behavior script +
 *   params). A custom part instance in `parts` is just a packageId reference; this is where the definition
 *   it points to lives, so an authored/edited part travels with the room (not only with a saved file). Each
 *   package Y.Map splits into three fields so an edit re-syncs only what changed: `behavior` (the script -
 *   the common edit), `def` (everything else: geometry/params/name - JSON), and `blob` (the heavy
 *   assets/materials/thumbnail - JSON, only when present, so a script edit never re-sends an embedded GLB).
 */
export const PACKAGES_KEY = 'packages'
/**
 * events : Y.Array<FeedEvent>   the room's shared edit feed (the History dock's activity list):
 *   one small JSON atom per committed edit - label, time, kind, actor name, writer clientID.
 *   Append-only with a rolling cap; events are immutable once appended, except the coalesce
 *   replace (a rapid same-key edit run by the same client updates its last event in place, so
 *   an inspector drag is one row, not thirty). Carries no scene data: the feed
 *   is for legibility ("who did what when"), never a sync channel. It is not in the undo
 *   scope: undoing an edit moves the scene back but the feed keeps the row (an activity feed
 *   records that it happened, not current truth).
 */
export const EVENTS_KEY = 'events'
/** rolling cap on the shared edit feed (old events fall off the front) */
export const EVENT_CAP = 200
/** same-client same-key edits within this window replace the previous event (mirrors the
 *  editor store's undo coalescing window, so the feed and solo history group edits alike) */
export const EVENT_COALESCE_MS = 800

/** transaction origin for our own writes, so the doc observer can ignore the echo */
export const LOCAL_ORIGIN = Symbol('oip-collab-local')

/** one entry of the shared edit feed (see EVENTS_KEY) */
export interface FeedEvent {
  label: string
  time: number
  kind: 'scene' | 'package' | 'program'
  /** the writer's display name at write time (feeds are historical; a later rename doesn't rewrite them) */
  actor: string
  /** the writer's Y.Doc clientID - coalesce scoping + lets a client mark its own rows */
  client: number
  /** coalesce key of the commit that produced this event, when it had one */
  ck?: string
}

/** ParamSpec kinds whose value is an array/object, stored as a JSON-string atom (typed: a retired kind can't linger) */
const LIST_PARAM_KINDS: ReadonlySet<ParamSpec['kind']> = new Set<ParamSpec['kind']>(['wallRules', 'numberList'])

export function partsMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap<Y.Map<unknown>>(PARTS_KEY)
}
export function orderArray(ydoc: Y.Doc): Y.Array<string> {
  return ydoc.getArray<string>(ORDER_KEY)
}
export function metaMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(META_KEY)
}
export function packagesMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap<Y.Map<unknown>>(PACKAGES_KEY)
}
export function eventsArray(ydoc: Y.Doc): Y.Array<FeedEvent> {
  return ydoc.getArray<FeedEvent>(EVENTS_KEY)
}
export function stProgramText(ydoc: Y.Doc): Y.Text {
  return ydoc.getText(ST_PROGRAM_TEXT)
}

/** The room's shared program + scan time as the doc holds them. `scanMs` is undefined when the room
 *  never set one (a room seeded before this field existed) - the reader keeps its own.
 *  `dialect` is present only when the room's program is not IEC (a non-string atom reads as none). */
export function readStDoc(ydoc: Y.Doc): { source: string; scanMs: number | undefined; controller: Controller | null; dialect?: string } {
  const raw = metaMap(ydoc).get(ST_SCAN_MS_META)
  const dialect = readDialect(metaMap(ydoc).get(ST_DIALECT_META))
  return {
    source: stProgramText(ydoc).toString(),
    scanMs: typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined,
    controller: readController(metaMap(ydoc).get(ST_CONTROLLER_META)),
    ...(dialect !== undefined ? { dialect } : {}),
  }
}

/** A dialect from its doc atom, in its kept form (core/dialect.ts storedDialect): undefined for IEC or none. */
function readDialect(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? storedDialect(raw) : undefined
}

/** A controller table from its doc atom; null when the room has none, or when a peer wrote one this
 *  client cannot read (validated like every other way a table arrives). */
function readController(raw: unknown): Controller | null {
  if (typeof raw !== 'string') return null
  try {
    const checked = validateController(JSON.parse(raw))
    return checked.ok ? checked.controller : null
  } catch {
    return null
  }
}

/**
 * Replace the room's shared program (and its scan time) in ONE transaction, so peers and a bound
 * CodeMirror see a single replacement rather than a delete followed by an insert. A no-op when the
 * doc already holds this exact pair - that early-out is what stops store -> doc -> store from
 * looping. Pass LOCAL_ORIGIN (the default) so the bridge ignores the echo.
 */
export function writeStDoc(
  ydoc: Y.Doc,
  source: string,
  scanMs?: number,
  origin: unknown = LOCAL_ORIGIN,
  /** the program's controller table; null clears it, undefined leaves the room's as it is */
  controller?: Controller | null,
  /** the program's dialect; null (or 'iec') clears it back to IEC, undefined leaves the room's as it is */
  dialect?: string | null,
): void {
  const cur = readStDoc(ydoc)
  const scanChanged = scanMs !== undefined && cur.scanMs !== scanMs
  // compared with the atom the room holds, not with the table read from it: a peer's table this client
  // cannot read reads as none, and clearing it must still clear it rather than look like a no-op
  const atom = metaMap(ydoc).get(ST_CONTROLLER_META)
  const controllerChanged = controller !== undefined && (controller === null ? atom !== undefined : atom !== JSON.stringify(controller))
  // the same with the dialect's atom; IEC is never written, only cleared to
  const nextDialect = dialect === undefined ? undefined : storedDialect(dialect)
  const dialectAtom = metaMap(ydoc).get(ST_DIALECT_META)
  const dialectChanged = dialect !== undefined && (nextDialect === undefined ? dialectAtom !== undefined : dialectAtom !== nextDialect)
  if (cur.source === source && !scanChanged && !controllerChanged && !dialectChanged) return
  ydoc.transact(() => {
    const text = stProgramText(ydoc)
    if (cur.source !== source) {
      // only the span that differs, so a bound editor keeps its place and a peer typing elsewhere is left alone
      const { from, removed, inserted } = changedSpan(cur.source, source)
      if (removed > 0) text.delete(from, removed)
      if (inserted !== '') text.insert(from, inserted)
    }
    if (scanChanged) metaMap(ydoc).set(ST_SCAN_MS_META, scanMs)
    if (controllerChanged) {
      if (controller === null) metaMap(ydoc).delete(ST_CONTROLLER_META)
      else metaMap(ydoc).set(ST_CONTROLLER_META, JSON.stringify(controller))
    }
    if (dialectChanged) {
      if (nextDialect === undefined) metaMap(ydoc).delete(ST_DIALECT_META)
      else metaMap(ydoc).set(ST_DIALECT_META, nextDialect)
    }
  }, origin)
}

/** `meta` keys holding the room's scene's Units and Length (SceneJSON.units, .lengthUnit). Unlike the step rate they
 *  ARE part of the scene (a document edit, undoable), so docToScene reads them and a change to either rebuilds the
 *  scene like a part edit does (bridge.ts `movedScene`). Absent = metric, each length in its own unit. */
export const UNITS_META = 'units'
export const LENGTH_UNIT_META = 'lengthUnit'

/** the room scene's Units and Length, as SceneJSON carries them (a room holding `'metric-mm'` reads as metric in mm) */
export function readUnits(ydoc: Y.Doc): Pick<SceneJSON, 'units' | 'lengthUnit'> {
  const meta = metaMap(ydoc)
  return readSavedUnits(meta.get(UNITS_META), meta.get(LENGTH_UNIT_META))
}

/** write the room scene's Units and Length, each a no-op when unchanged. Both keys are written as given, so a room
 *  that held `'metric-mm'` takes the two values it reads as. Call inside the caller's transaction. */
export function writeUnits(ydoc: Y.Doc, scene: Pick<SceneJSON, 'units' | 'lengthUnit'>): void {
  const meta = metaMap(ydoc)
  for (const [key, v] of [[UNITS_META, scene.units], [LENGTH_UNIT_META, scene.lengthUnit]] as const) {
    if (meta.get(key) === v) continue
    if (v === undefined) meta.delete(key)
    else meta.set(key, v)
  }
}

/** `meta` key holding the room's scene's controllers (SceneJSON.plcs, core/scene/scenePlcs.ts) as JSON. Part of the
 *  scene like the Units: an edit, undoable, read by docToScene, and a change to it rebuilds the scene (bridge.ts). */
export const PLCS_META = 'plcs'

// the last list read from each room, by its text: every remote transaction re-reads the scene, and a new list each time
// would re-derive the controller setup (store/storePlcs.ts plcSetupOf, keyed on the list) at a peer's drag rate
const lastPlcs = new WeakMap<Y.Doc, { text: string; plcs: SceneJSON['plcs'] }>()

/** the room scene's controllers, read like any other untrusted copy of them; absent when the room has none */
export function readPlcs(ydoc: Y.Doc): SceneJSON['plcs'] {
  const v = metaMap(ydoc).get(PLCS_META)
  if (typeof v !== 'string') return undefined
  const last = lastPlcs.get(ydoc)
  if (last?.text === v) return last.plcs
  let plcs: SceneJSON['plcs']
  try {
    plcs = validateScenePlcs(JSON.parse(v), [])
  } catch {
    plcs = undefined
  }
  lastPlcs.set(ydoc, { text: v, plcs })
  return plcs
}

/** write the room scene's controllers; a no-op when unchanged. Call inside the caller's transaction. */
export function writePlcs(ydoc: Y.Doc, plcs: SceneJSON['plcs']): void {
  const text = plcs === undefined ? undefined : JSON.stringify(plcs)
  if (metaMap(ydoc).get(PLCS_META) === text) return
  if (text === undefined) metaMap(ydoc).delete(PLCS_META)
  else metaMap(ydoc).set(PLCS_META, text)
}

/** `meta` key holding the room's scene's display list (SceneJSON.display, core/scene/sceneDisplay.ts) as JSON. Part of
 *  the scene like the controllers: an edit, undoable, read by docToScene, and a change to it rebuilds the scene. */
export const DISPLAY_META = 'display'

// the last list read from each room, by its text, as lastPlcs: the same array while a peer drags, so Present and the
// toolbar don't re-render on every remote transaction
const lastDisplay = new WeakMap<Y.Doc, { text: string; display: SceneJSON['display'] }>()

/** the room scene's display list, read like any other untrusted copy of it; absent when the room has none */
export function readDisplay(ydoc: Y.Doc): SceneJSON['display'] {
  const v = metaMap(ydoc).get(DISPLAY_META)
  if (typeof v !== 'string') return undefined
  const last = lastDisplay.get(ydoc)
  if (last?.text === v) return last.display
  let display: SceneJSON['display']
  try {
    display = readDisplayList(JSON.parse(v))
  } catch {
    display = undefined
  }
  lastDisplay.set(ydoc, { text: v, display })
  return display
}

/** write the room scene's display list; a no-op when unchanged. Call inside the caller's transaction. */
export function writeDisplay(ydoc: Y.Doc, display: SceneJSON['display']): void {
  const text = display === undefined || display.length === 0 ? undefined : JSON.stringify(display)
  if (metaMap(ydoc).get(DISPLAY_META) === text) return
  if (text === undefined) metaMap(ydoc).delete(DISPLAY_META)
  else metaMap(ydoc).set(DISPLAY_META, text)
}

/** `meta` key holding the room's scene's physics step rate (Hz; core/project/project.ts ProjectMachine.simHz). It sits beside the scene's version, not with the
 *  program: the rate is a property of the world, and every peer steps its own - so a room that did not
 *  carry it would have two people watching the same line behave differently. */
export const SIM_HZ_META = 'simHz'

/** The room's physics step rate. A room that never set one runs at the default, which is also what every
 *  peer ran before rooms carried a rate - so absent and DEFAULT_SIM_HZ mean the same thing. */
export function readSimHz(ydoc: Y.Doc): SimRate {
  return toSimRate(metaMap(ydoc).get(SIM_HZ_META))
}

/** Set the room's step rate. A no-op when the room already runs at it, which is what stops
 *  store -> doc -> store from looping (and keeps a default-rate seed from writing anything). */
export function writeSimHz(ydoc: Y.Doc, hz: SimRate, origin: unknown = LOCAL_ORIGIN): void {
  if (readSimHz(ydoc) === hz) return
  ydoc.transact(() => metaMap(ydoc).set(SIM_HZ_META, hz), origin)
}

/**
 * The newest build of the app that has joined the room as an editor, as the build stamp that orders builds (the
 * commit time of its source, vite.config.ts `__BUILD_TIME__`).
 *
 * Two builds in one room is normal after a deploy (an open tab keeps the old one), and an older build loses what it
 * cannot read on every write-back (params normalized, mesh data re-written, order without what it couldn't decode).
 * Which fields a build added is unknowable in general, so the rule is by build: an editor claims the room for its
 * build on join, and an older client goes view-only until it reloads (collab/bridge.ts).
 *
 * Kept for good, since what the newer build wrote outlives it. The downside: a deploy rolled back leaves rooms it
 * touched view-only until a build at least as new ships. `meta.version` (the scene format) is a different key, and unread.
 */
export const ROOM_BUILD_META = 'build'

/**
 * The shared project's name (editor/project/sharedProject.ts), written by its owner, so everyone in the room sees what
 * they are in by name rather than as a room. Absent in a room from before it was written.
 */
export const PROJECT_NAME_META = 'projectName'
/** Its own origin, like a build claim's: an undo never takes the name back. */
export const PROJECT_NAME_ORIGIN = Symbol('oip-collab-project-name')

export function readProjectName(ydoc: Y.Doc): string | undefined {
  const v = metaMap(ydoc).get(PROJECT_NAME_META)
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, 200) : undefined
}

export function writeProjectName(ydoc: Y.Doc, name: string): void {
  if (readProjectName(ydoc) === name) return
  ydoc.transact(() => metaMap(ydoc).set(PROJECT_NAME_META, name), PROJECT_NAME_ORIGIN)
}

/** The origin a build claim is written in. Not LOCAL_ORIGIN, so this client's undo never takes a claim back. */
export const ROOM_BUILD_ORIGIN = Symbol('oip-collab-room-build')

/** The newest build stamp that has claimed the room, or undefined when none has (a room older than the claim). */
export function readRoomBuild(ydoc: Y.Doc): number | undefined {
  const v = metaMap(ydoc).get(ROOM_BUILD_META)
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Claim the room for `build`: a no-op when an equal or newer build already has. */
export function claimRoomBuild(ydoc: Y.Doc, build: number): void {
  const cur = readRoomBuild(ydoc)
  if (cur !== undefined && cur >= build) return
  ydoc.transact(() => metaMap(ydoc).set(ROOM_BUILD_META, build), ROOM_BUILD_ORIGIN)
}

/**
 * Append an edit event to the shared feed, coalescing a rapid same-client same-key run into
 * one entry (delete + reinsert - atoms are immutable) and trimming the front past EVENT_CAP.
 * Call inside a LOCAL_ORIGIN transaction (like writePackage). Concurrent appends from two
 * clients interleave; the coalesce check only ever touches this client's own last
 * event, so it can't eat a peer's row.
 */
export function appendEditEvent(arr: Y.Array<FeedEvent>, e: FeedEvent): void {
  const last = arr.length > 0 ? arr.get(arr.length - 1) : undefined
  if (
    last &&
    last.client === e.client &&
    e.ck !== undefined &&
    last.ck === e.ck &&
    e.time - last.time < EVENT_COALESCE_MS
  ) {
    arr.delete(arr.length - 1, 1)
  }
  arr.push([e])
  if (arr.length > EVENT_CAP) arr.delete(0, arr.length - EVENT_CAP)
}

/** the shared edit feed in display (chronological) order, skipping malformed entries */
export function readEditFeed(ydoc: Y.Doc): FeedEvent[] {
  return eventsArray(ydoc)
    .toArray()
    .filter(
      (e): e is FeedEvent =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as FeedEvent).label === 'string' &&
        typeof (e as FeedEvent).time === 'number' &&
        ((e as FeedEvent).kind === 'scene' || (e as FeedEvent).kind === 'package' || (e as FeedEvent).kind === 'program') &&
        typeof (e as FeedEvent).actor === 'string' &&
        typeof (e as FeedEvent).client === 'number',
    )
}

/** split a package into its three doc fields (see PACKAGES_KEY) - `blob` is '' when there's nothing heavy */
function packageFields(pkg: PartPackage): { behavior: string; def: string; blob: string } {
  const { behavior, assets, materials, thumbnail, ...def } = pkg
  const heavy = (assets && assets.length) || (materials && materials.length) || thumbnail
  return {
    behavior: behavior ?? '',
    def: JSON.stringify(def),
    // an embedded asset goes in as its hash, its bytes to the room's asset store (roomAssets.ts)
    blob: heavy ? JSON.stringify({ assets: assets?.map(toRoomEntry), materials, thumbnail }) : '',
  }
}

/** reconstruct a package from its per-package Y.Map, or null if it's malformed */
export function packageFromMap(id: string, m: Y.Map<unknown>): PartPackage | null {
  const def = m.get('def')
  const behavior = m.get('behavior')
  if (typeof def !== 'string' || typeof behavior !== 'string') return null
  let base: Record<string, unknown>
  try {
    base = JSON.parse(def) as Record<string, unknown>
  } catch {
    return null
  }
  // the map key is authoritative for the id (a renamed/edited def can't desync the key it's stored under).
  // A room outlives the build that wrote it, so the entry is upgraded here, as every other load does.
  const pkg = upgradeStoredPackage({ ...base, id, behavior } as unknown as PartPackage).pkg
  const blob = m.get('blob')
  if (typeof blob === 'string' && blob !== '') {
    try {
      const b = JSON.parse(blob) as Partial<Pick<PartPackage, 'assets' | 'materials' | 'thumbnail'>>
      if (b.assets) {
        // an asset kept by hash whose bytes are not here yet: the package waits for them (roomAssets.ts fetches
        // them and says when), rather than arriving with a model missing
        const assets = b.assets.map(fromRoomEntry)
        if (assets.some((a) => a === undefined)) return null
        pkg.assets = assets as NonNullable<PartPackage['assets']>
      }
      if (b.materials) pkg.materials = b.materials
      if (b.thumbnail) pkg.thumbnail = b.thumbnail
    } catch {
      // a malformed blob loses the meshes but keeps geometry+behavior loadable
    }
  }
  return pkg
}

/**
 * Write a package into the doc's packages map, setting only the fields that actually changed (so editing a
 * behavior script doesn't re-broadcast an unchanged embedded GLB). Call inside a LOCAL_ORIGIN transaction.
 *
 * `edited` marks the entry as someone's EDIT of the part rather than a snapshot of it (see {@link editedPackageIds}).
 * It is only ever set, never cleared by a later write: a snapshot write can't un-fork a part (an undo can, since the
 * flag is a field of the tracked entry).
 */
export function writePackage(map: Y.Map<Y.Map<unknown>>, pkg: PartPackage, opts?: { edited?: boolean }): void {
  const f = packageFields(pkg)
  let m = map.get(pkg.id)
  if (!(m instanceof Y.Map)) {
    m = new Y.Map<unknown>()
    map.set(pkg.id, m)
  }
  if (m.get('behavior') !== f.behavior) m.set('behavior', f.behavior)
  if (m.get('def') !== f.def) m.set('def', f.def)
  if (m.get('blob') !== f.blob) m.set('blob', f.blob)
  if (opts?.edited && m.get('edited') !== true) m.set('edited', true)
}

/**
 * The ids whose room entry is an EDIT (a part authored or changed in a room, or brought in from its creator's own
 * library), as opposed to a SNAPSHOT: every placed part's package lands in the room too, first-party ones included,
 * so the definition travels with the scene. The difference only matters for an id a client SHIPS (a bundled part):
 * a snapshot of one is whatever build placed it, and must lose to the client's own copy, or a room made before a
 * built-in part changed shows the old part forever; an edit is a deliberate fork and wins, as a fork does solo.
 * An entry written before this flag existed reads as a snapshot.
 */
export function editedPackageIds(ydoc: Y.Doc): Set<string> {
  const out = new Set<string>()
  packagesMap(ydoc).forEach((m, id) => {
    if (m instanceof Y.Map && m.get('edited') === true) out.add(id)
  })
  return out
}

/** every custom-part package currently in the doc (for initial registration on join) */
export function readPackages(ydoc: Y.Doc): PartPackage[] {
  const out: PartPackage[] = []
  packagesMap(ydoc).forEach((m, id) => {
    if (!(m instanceof Y.Map)) return
    const pkg = packageFromMap(id, m)
    if (pkg) out.push(pkg)
  })
  return out
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** the scalar (non-params) fields of a part, omitting defaults exactly like serializeScene */
export function partScalars(part: PartInstance): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    type: part.type,
    px: part.position[0],
    py: part.position[1],
    pz: part.position[2],
    ry: part.rotationY,
  }
  // An SDK part is defined by its package reference: geometry, params and behavior all come from it. Omitting
  // it materializes an unresolvable blank on every peer and on the writer, which re-reads its own
  // doc through docToScene (see CollabBridge.applyDisplay).
  if (part.type === 'part') out.packageId = (part as SdkPart).packageId
  if (part.rotationX) out.rx = part.rotationX
  if (part.rotationZ) out.rz = part.rotationZ
  if (typeof part.name === 'string' && part.name !== '') out.name = part.name
  if (part.visible === false) out.visible = false
  if (part.locked === true) out.locked = true
  if (part.grouped === true) out.grouped = true
  if (typeof part.parent === 'string' && part.parent !== '') out.parent = part.parent
  // (A room doc written while assemblies were linked may still hold masterId / instanceId / masterKey / overrides
  // keys on its part maps, and one written before tag scope was retired a tagScope key; partFromMap ignores them.)
  return out
}

/**
 * One SDK param value as the doc stores it, or undefined if it isn't a value the SDK can hold.
 * Scalars pass through; a numberList's rows are COPIED in both directions so the doc and the
 * materialized scene never alias each other's arrays.
 */
function sdkParamValue(raw: unknown): ParamValue | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'boolean' || typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.map((row) => (Array.isArray(row) ? row.slice() : row)) as ParamValue
  return undefined
}

/** param key -> stored value (scalars verbatim, lists/objects as JSON strings) */
export function paramEntries(part: PartInstance): Array<[string, ParamValue | string]> {
  const src = part.params as unknown as Record<string, ParamValue>
  const out: Array<[string, ParamValue | string]> = []
  // package-driven: walk the instance's own params, since PART_DEFS['part'].params is empty
  if (part.type === 'part') {
    for (const [key, v] of Object.entries(src)) {
      const stored = sdkParamValue(v)
      if (stored !== undefined) out.push([key, stored])
    }
    return out
  }
  for (const spec of PART_DEFS[part.type].params) {
    const v = src[spec.key] ?? spec.default
    out.push([spec.key, LIST_PARAM_KINDS.has(spec.kind) ? JSON.stringify(v) : v])
  }
  // openDoors rides alongside the spec params (see serializeScene)
  const openDoors = src.openDoors
  if (Array.isArray(openDoors) && openDoors.length > 0) out.push(['openDoors', JSON.stringify(openDoors)])
  return out
}

function paramsFromY(type: PartType, yparams: Y.Map<unknown> | undefined): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  if (!(yparams instanceof Y.Map)) return out
  // package-driven, and not resolved against the package registry: a part whose
  // package hasn't arrived/registered yet still materializes with its authored values, and
  // normalizePart clamps them once the schema is known
  if (type === 'part') {
    yparams.forEach((raw, key) => {
      const v = sdkParamValue(raw)
      if (v !== undefined) out[key] = v
    })
    return out
  }
  for (const spec of PART_DEFS[type].params) {
    const raw = yparams.get(spec.key)
    if (raw === undefined) continue
    out[spec.key] = LIST_PARAM_KINDS.has(spec.kind) && typeof raw === 'string' ? safeJson(raw) : (raw as ParamValue)
  }
  const openDoors = yparams.get('openDoors')
  if (typeof openDoors === 'string') out.openDoors = safeJson(openDoors) as ParamValue
  return out
}

function safeJson(s: string): ParamValue {
  try {
    return JSON.parse(s) as ParamValue
  } catch {
    return [] as unknown as ParamValue
  }
}

/** build a fresh part Y.Map from a part (used when seeding or adding a part) */
export function makePartMap(part: PartInstance): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(partScalars(part))) m.set(k, v)
  const yp = new Y.Map<unknown>()
  for (const [k, v] of paramEntries(part)) yp.set(k, v)
  m.set('params', yp)
  return m
}

/** reconstruct a single part from its Y.Map, or null if it's malformed/unknown */
function partFromMap(id: string, m: Y.Map<unknown>): PartInstance | null {
  const type = m.get('type')
  if (typeof type !== 'string' || !(type in PART_DEFS)) return null
  // an SDK part without its package reference resolves to no geometry, no params and no behavior:
  // malformed, not renderable. (Also the shape written by pre-fix clients, which dropped packageId.)
  const packageId = m.get('packageId')
  if (type === 'part' && (typeof packageId !== 'string' || packageId === '')) return null
  const part: Record<string, unknown> = {
    id,
    type,
    ...(type === 'part' ? { packageId } : {}),
    position: [num(m.get('px')), num(m.get('py')), num(m.get('pz'))],
    rotationY: num(m.get('ry')),
    params: paramsFromY(type as PartType, m.get('params') as Y.Map<unknown> | undefined),
  }
  const rx = m.get('rx')
  if (typeof rx === 'number' && rx) part.rotationX = rx
  const rz = m.get('rz')
  if (typeof rz === 'number' && rz) part.rotationZ = rz
  const name = m.get('name')
  if (typeof name === 'string' && name !== '') part.name = name
  if (m.get('visible') === false) part.visible = false
  if (m.get('locked') === true) part.locked = true
  if (m.get('grouped') === true) part.grouped = true
  const parent = m.get('parent')
  if (typeof parent === 'string' && parent !== '') part.parent = parent
  return part as unknown as PartInstance
}

/** keep the first building (in converged order), drop the rest - the scene's singleton invariant */
function reconcileBuildings(parts: PartInstance[]): PartInstance[] {
  let kept = false
  return parts.filter((p) => {
    if (p.type !== 'building') return true
    if (kept) return false
    kept = true
    return true
  })
}

/**
 * Rebuild a SceneJSON from the doc. Walks `order` (the converged Y.Array) first so every
 * client materializes parts in the same order, then appends any map-only stragglers. Runs
 * `sanitizeParents` (breaks the same merge-induced cycle on every client) and the
 * one-building reconciler so live CRDT state - which never passes through validateScene -
 * still loads as a structurally valid scene.
 */
export function docToScene(ydoc: Y.Doc): SceneJSON {
  const parts = partsMap(ydoc)
  const order = orderArray(ydoc)
  const seen = new Set<string>()
  const list: PartInstance[] = []
  // live CRDT state never passes through validateScene, so normalize each part here: a
  // malformed/out-of-range param from a peer (or a buggy client) gets clamped on the way in
  for (const id of order.toArray()) {
    if (typeof id !== 'string' || seen.has(id)) continue
    const m = parts.get(id)
    if (!(m instanceof Y.Map)) continue
    const p = partFromMap(id, m)
    if (p) {
      list.push(normalizePart(p))
      seen.add(id)
    }
  }
  parts.forEach((m, id) => {
    if (seen.has(id) || !(m instanceof Y.Map)) return
    const p = partFromMap(id, m)
    if (p) {
      list.push(normalizePart(p))
      seen.add(id)
    }
  })
  // carry the room's custom-part packages onto the scene so a file saved from a room stays self-contained
  // (every custom part's packageId resolves). Live registration is separate - see CollabBridge.
  const packages = readPackages(ydoc)
  const scene: SceneJSON = { version: SCENE_VERSION, parts: reconcileBuildings(sanitizeParents(list)) }
  if (packages.length > 0) scene.packages = packages
  Object.assign(scene, readUnits(ydoc))
  const plcs = readPlcs(ydoc)
  if (plcs !== undefined) scene.plcs = plcs
  const display = readDisplay(ydoc)
  if (display !== undefined) scene.display = display
  return scene
}

/**
 * seed an (assumed empty) doc from a scene; pass LOCAL_ORIGIN so the bridge ignores it. `edited` names the packages
 * the creator authored or forked (their library), which enter the room as edits, not snapshots (editedPackageIds).
 */
export function sceneToDoc(scene: SceneJSON, ydoc: Y.Doc, origin: unknown = LOCAL_ORIGIN, edited?: ReadonlySet<string>): void {
  const parts = partsMap(ydoc)
  const order = orderArray(ydoc)
  const meta = metaMap(ydoc)
  const packages = packagesMap(ydoc)
  ydoc.transact(() => {
    for (const p of scene.parts) {
      parts.set(p.id, makePartMap(p))
      order.push([p.id])
    }
    // carry the scene's embedded custom-part packages into the room, so a custom part a peer joins to has
    // its definition (not just its packageId reference)
    for (const pkg of scene.packages ?? []) writePackage(packages, pkg, { edited: edited?.has(pkg.id) })
    meta.set('version', scene.version)
    writeUnits(ydoc, scene)
    writePlcs(ydoc, scene.plcs)
    writeDisplay(ydoc, scene.display)
  }, origin)
}
