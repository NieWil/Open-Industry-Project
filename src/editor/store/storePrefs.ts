// localStorage-backed editor preferences (view/snap toggles): the storage keys, the boot-time read
// helpers the EditorStore constructor seeds state from, and the best-effort writer its set*/toggle*
// methods persist through. Extracted from store.ts verbatim - keys and defaults must stay stable
// (they're the user's persisted preferences).
import { isAmsNetId } from '../../core/io/ads'
import { isEipFamily } from '../../core/io/eipTarget'
import type { EipFamily } from '../../core/io/eipTarget'
import { MAX_BROWSE_ROOTS, opcUaBrowseRoot } from '../../core/io/opcUa'
import { isControllerName } from '../../core/io/controllerTag'
import { MAX_SCENE_PLCS } from '../../core/scene/scenePlcs'
import type { PlcProtocol } from '../../core/scene/scenePlcs'
import { DEFAULT_ROTATE_SNAP_DEG, DEFAULT_TRANSLATE_SNAP } from '../../core/types'
import type { ProjectionMode } from '../../render/api'
import type { GridSnap, TransformSpace } from './store'

export const LIVESNAP_KEY = 'oip-web/livesnap'
export const FACESNAP_KEY = 'oip-web/facesnap'
export const SPACE_KEY = 'oip-web/space'
export const GRIDSNAP_KEY = 'oip-web/gridsnap'
export const FLOWARROWS_KEY = 'oip-web/flowarrows'
export const SHOWGRID_KEY = 'oip-web/showgrid'
export const SHOWNOTES_KEY = 'oip-web/shownotes'
export const SHOWSTATS_KEY = 'oip-web/showstats'
export const TREETYPES_KEY = 'oip-web/tree-types'
export const TRACKBALL_KEY = 'oip-web/trackball'
export const VSNAP_ORIGIN_KEY = 'oip-web/vsnap-origin'
export const VSNAP_COLLISION_KEY = 'oip-web/vsnap-collision'

export function readLiveSnap(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(LIVESNAP_KEY) !== 'false'
  } catch {
    return true
  }
}

/** the generic face-flush fallback (Shift+N): part of live snap, but separately toggleable - default ON */
export function readFaceSnap(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(FACESNAP_KEY) !== 'false'
  } catch {
    return true
  }
}

export function readSpace(): TransformSpace {
  if (typeof localStorage === 'undefined') return 'local'
  try {
    return localStorage.getItem(SPACE_KEY) === 'global' ? 'global' : 'local'
  } catch {
    return 'local'
  }
}

export function readFlowArrows(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(FLOWARROWS_KEY) === 'true'
  } catch {
    return false
  }
}

export function readShowGrid(): boolean {
  // defaults off; only an explicit 'true' shows the floor grid
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(SHOWGRID_KEY) === 'true'
  } catch {
    return false
  }
}

export function readShowNotes(): boolean {
  // defaults ON, unlike the grid: a note the author placed is content, and content that needs a preference
  // switched on to appear may as well not have been placed. Only an explicit 'false' hides them.
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(SHOWNOTES_KEY) !== 'false'
  } catch {
    return true
  }
}

/**
 * `?stats` (and `?stats=0|false|off` for the reverse) - a URL override for the perf overlay, for
 * surfaces that have no toggle. Phones drop the ViewportToolbar entirely (App.tsx), and the
 * toggle lives on it, so the URL is the only way to reach the overlay there - and its backend
 * badge is the only in-app proof of which renderer you got. That matters most on exactly those
 * devices: WebGPU is default-OFF on the mobile tier and `?webgpu` can still fall back silently
 * (no adapter / a software one - createRenderer.ts + App.tsx's catch), so the flag you typed is
 * only a request.
 *
 * Not persisted: it is a diagnostic you turn on for one load. Reading
 * it here rather than in the component also keeps the toggle authoritative afterwards - the URL
 * only seeds the store's initial state.
 */
function statsParamOverride(): boolean | null {
  if (typeof location === 'undefined') return null
  try {
    const v = new URLSearchParams(location.search).get('stats')
    if (v === null) return null
    return !(v === '0' || v === 'false' || v === 'off')
  } catch {
    return null
  }
}

export function readShowStats(): boolean {
  const override = statsParamOverride()
  if (override !== null) return override
  // defaults off; only an explicit 'true' shows the perf overlay
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(SHOWSTATS_KEY) === 'true'
  } catch {
    return false
  }
}

/** show the dim type subtitle on scene-tree rows - default ON; hiding yields the width to part names */
export function readTreeTypes(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(TREETYPES_KEY) !== 'false'
  } catch {
    return true
  }
}

export function readTrackball(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(TRACKBALL_KEY) === 'true'
  } catch {
    return false
  }
}

export function readVertexSnapOrigin(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(VSNAP_ORIGIN_KEY) === 'true'
  } catch {
    return false
  }
}

export function readVertexSnapCollision(): boolean {
  // defaults to collision vertices ("Snap to Collision Vertices"), per project preference
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(VSNAP_COLLISION_KEY) !== 'false'
  } catch {
    return true
  }
}

export function readGridSnap(): GridSnap {
  const translate = DEFAULT_TRANSLATE_SNAP
  const fallback: GridSnap = { enabled: false, translate, rotate: DEFAULT_ROTATE_SNAP_DEG }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(GRIDSNAP_KEY)
    if (!raw) return fallback
    const d = JSON.parse(raw) as Partial<GridSnap>
    const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def)
    return {
      enabled: d.enabled === true,
      translate: num(d.translate, translate),
      rotate: num(d.rotate, DEFAULT_ROTATE_SNAP_DEG),
    }
  } catch {
    return fallback
  }
}

export function persistPref(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, value)
  } catch {
    // best-effort persistence
  }
}

// ── Per-scene viewport state ────────────────────────────────────────────────────────────────────
//
// The camera pose (and the projection framed at it) is workspace state, not document state and not
// session state - the same tier as `oip-web/dock-layout`, `oip-web/dock-sizes` and the popout window
// rects, all of which already survive a reload. It does not live in SceneJSON/ProjectJSON:
// that is the portable document, so a camera there would change scene-file bytes for a change nobody
// made - two people who opened the same scene and merely looked at it would have different files - and,
// in a room, one person's orbit would yank everyone else's view.
//
// Keyed per document slot (documentStore.sceneSlotKey), so each project, room or demo keeps its own framing.
// Every project's slot is `scene-1`, and a bare id would open each project at the last one's camera. Rooms and
// the ephemeral `?scene=demo` peek get their own synthetic keys - see EditorController.viewportKey.

export const VIEWPORT_KEY = 'oip-web/viewport-state'

/** how many scene slots keep a remembered camera; oldest-written are dropped past this */
const VIEWPORT_SLOTS = 20

export interface CameraPose {
  px: number
  py: number
  pz: number
  tx: number
  ty: number
  tz: number
}

export interface ViewportState {
  pose: CameraPose
  /** the projection this pose was framed at - meaningless restored apart from it (see store.setProjection) */
  projection: ProjectionMode
  /**
   * Whether that orthographic view was an axis-snap auto-ortho (orbiting off the axis reverts to
   * perspective) rather than an explicit O-key one, so it comes back behaving the way it was left
   * Optional: a slot written before it existed restores as the explicit kind.
   */
  auto?: boolean
}

interface ViewportSlot extends ViewportState {
  /** scene slot id, or a synthetic key for a room / the demo peek */
  key: string
}

const isPose = (v: unknown): v is CameraPose => {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (['px', 'py', 'pz', 'tx', 'ty', 'tz'] as const).every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
}

/** Read the whole map, MRU first. Anything malformed is dropped rather than thrown: a corrupt
 *  preference must never stop someone's scene from opening. */
function readSlots(): ViewportSlot[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(VIEWPORT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is ViewportSlot => {
      if (typeof s !== 'object' || s === null) return false
      const slot = s as Record<string, unknown>
      return (
        typeof slot.key === 'string' &&
        slot.key.length > 0 &&
        isPose(slot.pose) &&
        (slot.projection === 'perspective' || slot.projection === 'orthographic')
      )
    })
  } catch {
    return []
  }
}

/**
 * The camera remembered for `key`, or null when this slot has never been framed (a brand-new scene,
 * a first visit, or one evicted by the cap) - the caller then applies the scene's opening view.
 *
 * `legacyKey` is the same slot under its pre-document key (a bare scene id, from before cameras were kept
 * per document). When `key` has nothing, a slot there is taken - re-keyed to `key`, so no second document
 * can inherit it too - and returned. The first document to ask for a scene after the upgrade is the one
 * that was open, which is the best owner there is to guess.
 */
export function readViewportState(key: string, legacyKey?: string): ViewportState | null {
  const slots = readSlots()
  let slot = slots.find((s) => s.key === key)
  if (!slot && legacyKey !== undefined && legacyKey !== key) {
    const legacy = slots.find((s) => s.key === legacyKey)
    if (legacy) {
      slot = { ...legacy, key }
      try {
        localStorage.setItem(VIEWPORT_KEY, JSON.stringify(slots.map((s) => (s === legacy ? slot! : s))))
      } catch {
        // best-effort persistence: the camera still comes back this once
      }
    }
  }
  // `auto` is only meaningful for an orthographic view, and anything but a literal true reads as the explicit kind
  return slot ? { pose: slot.pose, projection: slot.projection, auto: slot.projection === 'orthographic' && slot.auto === true } : null
}

/**
 * Move the camera kept under `fromKey` to `toKey`, unless `toKey` already has one (then `fromKey`'s is left
 * alone). For a document that has just been given its id: whatever it saved under bare scene ids before
 * that is its own.
 */
export function moveViewportState(fromKey: string, toKey: string): void {
  if (typeof localStorage === 'undefined' || fromKey === toKey) return
  const slots = readSlots()
  if (slots.some((s) => s.key === toKey) || !slots.some((s) => s.key === fromKey)) return
  try {
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify(slots.map((s) => (s.key === fromKey ? { ...s, key: toKey } : s))))
  } catch {
    // best-effort persistence
  }
}

/** Remember `key`'s camera, moving it to the front of the MRU list. Best-effort, like every pref. */
export function persistViewportState(key: string, state: ViewportState): void {
  if (typeof localStorage === 'undefined') return
  const next: ViewportSlot[] = [{ key, ...state }, ...readSlots().filter((s) => s.key !== key)]
  try {
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify(next.slice(0, VIEWPORT_SLOTS)))
  } catch {
    // best-effort persistence
  }
}

/** Forget `key`'s camera, so the next load falls back to the scene's opening view ("Reset View"). */
export function clearViewportState(key: string): void {
  if (typeof localStorage === 'undefined') return
  const kept = readSlots().filter((s) => s.key !== key)
  try {
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify(kept))
  } catch {
    // best-effort persistence
  }
}

export const EXTERNAL_PLC_KEY = 'oip-web/external-plc'

/**
 * One link to a PLC outside the app (editor/links/externalPlc.ts): how it connects, and where. For the main
 * controller `enabled` is whether Play hands the scene's I/O to this PLC instead of running the in-process program;
 * for a named one ({@link NamedPlcLink}) whether Play connects it at all.
 */
export interface PlcLinkSettings {
  enabled: boolean
  /**
   * How the link runs. `serve`: the simulator is a Modbus server and the PLC polls it (OpenPLC). `poll`: the
   * PLC runs a Modbus server device and the simulator polls it - core/io/externalIo.ts says why
   * both exist. `opcua`: the simulator reads and writes the PLC's tags by name on its OPC UA server
   * (core/io/opcUa.ts). `eip`: the same, by name, on a Logix controller over EtherNet/IP (core/io/eip.ts). `s7`: the
   * simulator reads and writes an S7-1200/1500 CPU's I, Q and M memory and data blocks over PUT/GET (core/io/s7Io.ts).
   * `slmp`: the simulator reads and writes a MELSEC CPU's devices (X, Y, M, D) over SLMP (core/io/slmpIo.ts).
   * `ads`: a TwinCAT PLC's symbols by name, through TwinCAT's own router on this PC (core/io/ads.ts).
   */
  mode: PlcProtocol
  /** serve: the port the simulator listens on */
  port: number
  /** serve: listen on every interface (a PLC on the network), not only this machine */
  network: boolean
  /** poll: the PLC's Modbus server */
  plcHost: string
  plcPort: number
  /** poll: the %IW word the server device's holding register 0 is, and the %QW word its input register 0 is */
  inputBase: number
  outputBase: number
  /** opcua: the PLC's OPC UA server */
  opcUaEndpoint: string
  /** opcua: where the browse for tags starts, as typed (core/io/opcUa.ts opcUaBrowseRoot); empty: Objects */
  opcUaBrowseFrom: readonly string[]
  /** eip: the controller's address (or its Ethernet module's), host[:port] */
  eipGateway: string
  /** eip: the route from that module to the controller's CPU, `1,0` = the backplane, slot 0; '' for none. Not sent to a Micro800 */
  eipPath: string
  /** eip: a Logix controller (ControlLogix, CompactLogix) or a Micro800 */
  eipFamily: EipFamily
  /** s7: the CPU's address, its ISO-on-TCP port (102), and where it sits: rack 0, slot 1 on an S7-1200/1500 */
  s7Host: string
  s7Port: number
  s7Rack: number
  s7Slot: number
  /** slmp: the MELSEC CPU's address, and the port its SLMP server answers on (5000 unless something forwards it) */
  slmpHost: string
  slmpPort: number
  /** ads: the PLC's AMS Net ID ('' = the TwinCAT runtime on this PC) and its AMS port (851 = the first PLC) */
  adsNetId: string
  adsPort: number
  /** read every tag and write none (the scene's ScenePlc.watch); the project's, so never kept as a preference */
  watch?: boolean
}

/**
 * A simulated controller's own OPC UA server (editor/links/opcUaServer.ts): its program, published by name for a
 * SCADA or HMI, on a port of its own, as each PLC on a line has a server of its own.
 */
export interface UaServerSettings {
  uaServer: boolean
  uaServerPort: number
  /** listen on every interface (a SCADA on another machine), not only this one */
  uaServerNetwork: boolean
}

/**
 * This computer's settings for a controller other than the default one, by the name a part's tag gives it:
 * `Cell2::%IX0.0` is wired to the controller named Cell2 (core/io/controllerTag.ts). Its link to a PLC, and its
 * OPC UA server for when the simulator runs it.
 */
export interface NamedPlcLink extends PlcLinkSettings, UaServerSettings {
  name: string
}

/**
 * The external-PLC settings: the default controller's link, the named controllers' links, and the simulated PLC's
 * OPC UA server. A machine setting, not the document's: which port this workstation listens on, where its PLCs
 * are, and whether its firewall should let a PLC on the network in, belongs to the workstation. What the document
 * carries is the wiring, the addresses and controller names in the parts' tags.
 */
export interface ExternalPlcSettings extends PlcLinkSettings, UaServerSettings {
  /** the named controllers, in the order Controller Properties lists them; names are unique */
  controllers: readonly NamedPlcLink[]
}

/**
 * The simulated PLC's OPC UA server port. Not the standard 4840: on a machine with PLC software installed, the OPC
 * Foundation's Local Discovery Server often holds that one, and a PLC runtime moved off it usually goes to 4841
 * (src/plc/DEVICE-IO.md).
 */
export const DEFAULT_UA_SERVER_PORT = 4843

export const DEFAULT_EXTERNAL_PLC: ExternalPlcSettings = {
  enabled: false,
  mode: 'serve',
  port: 5020,
  network: false,
  plcHost: '127.0.0.1',
  plcPort: 502,
  inputBase: 0,
  outputBase: 0,
  opcUaEndpoint: 'opc.tcp://127.0.0.1:4840',
  opcUaBrowseFrom: [],
  eipGateway: '127.0.0.1',
  eipPath: '1,0',
  eipFamily: 'logix',
  s7Host: '192.168.0.1',
  s7Port: 102,
  s7Rack: 0,
  s7Slot: 1,
  slmpHost: '192.168.0.1',
  slmpPort: 5000,
  adsNetId: '',
  adsPort: 851,
  uaServer: false,
  uaServerPort: DEFAULT_UA_SERVER_PORT,
  uaServerNetwork: false,
  controllers: [],
}

/** How many named controllers a scene lists beside its default one (core/scene/scenePlcs.ts MAX_SCENE_PLCS). */
export const MAX_NAMED_PLCS = MAX_SCENE_PLCS - 1

/** How many controllers' addresses this computer keeps, across every project it has opened (store/storePlcs.ts). */
export const MAX_KEPT_ADDRESSES = 64

const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535
const isWord = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535
const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
/** A host name or an IPv4/IPv6 address: letters, digits and the punctuation those use, nothing that could be a URL. */
export const isPlcHost = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,253}$/.test(v)

/** An `opc.tcp://host[:port][/path]` address, and nothing that could be another scheme. */
export const isOpcUaEndpoint = (v: unknown): v is string => typeof v === 'string' && v.length <= 512 && /^opc\.tcp:\/\/[A-Za-z0-9._\-[\]:]+(\/\S*)?$/.test(v)

/** A CIP route: port,link pairs as numbers (`1,0`), or '' when the gateway is the controller. */
export const isEipPath = (v: unknown): v is string => typeof v === 'string' && /^(\d{1,3}(,\d{1,3})*)?$/.test(v)

/** A settings object with every field valid: anything malformed falls back to its default. */
export function sanitizeExternalPlc(raw: unknown): ExternalPlcSettings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_EXTERNAL_PLC
  const controllers: NamedPlcLink[] = []
  for (const c of Array.isArray(o.controllers) ? o.controllers : []) {
    const name = typeof c === 'object' && c !== null ? (c as Record<string, unknown>).name : undefined
    if (typeof name !== 'string' || !isControllerName(name) || controllers.some((k) => k.name.toLowerCase() === name.toLowerCase())) continue
    if (controllers.length < MAX_KEPT_ADDRESSES) controllers.push({ name, ...sanitizePlcLink(c), ...sanitizeUaServer(c, DEFAULT_UA_SERVER_PORT + 1 + controllers.length) })
  }
  return {
    ...sanitizePlcLink(o),
    uaServer: o.uaServer === true,
    uaServerPort: isPort(o.uaServerPort) ? o.uaServerPort : d.uaServerPort,
    uaServerNetwork: o.uaServerNetwork === true,
    controllers,
  }
}

/**
 * After sanitizing a patch, an address or number the patch set but sanitizing refused keeps its last valid value
 * (the field then snaps back) instead of falling to the default.
 */
export function keepLastValid(next: PlcLinkSettings, cur: PlcLinkSettings, patch: Partial<PlcLinkSettings>): void {
  for (const key of ['port', 'plcHost', 'plcPort', 'inputBase', 'outputBase', 'opcUaEndpoint', 'eipGateway', 'eipPath'] as const) {
    if (patch[key] !== undefined && next[key] !== patch[key]) (next as Record<typeof key, unknown>)[key] = cur[key]
  }
}

/**
 * The link that serves on the same port as `who`'s (null: the default controller), when both serve on Play: two cannot
 * listen on one port. Its name, '' for the default controller, or null when the port is its own.
 */
export function servePortClash(settings: ExternalPlcSettings, who: string | null): string | null {
  const serving = [
    ...(settings.enabled && settings.mode === 'serve' ? [{ name: '', port: settings.port }] : []),
    ...settings.controllers.filter((c) => c.enabled && c.mode === 'serve').map((c) => ({ name: c.name, port: c.port })),
  ]
  const self = serving.find((s) => s.name === (who ?? ''))
  if (!self) return null
  return serving.find((s) => s !== self && s.port === self.port)?.name ?? null
}

/** An OPC UA server's settings with every field valid; `port` when the port is not one. */
export function sanitizeUaServer(raw: unknown, port: number): UaServerSettings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return { uaServer: o.uaServer === true, uaServerPort: isPort(o.uaServerPort) ? o.uaServerPort : port, uaServerNetwork: o.uaServerNetwork === true }
}

/** One link's settings with every field valid. */
export function sanitizePlcLink(raw: unknown): PlcLinkSettings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_EXTERNAL_PLC
  return {
    enabled: o.enabled === true,
    mode: o.mode === 'poll' || o.mode === 'opcua' || o.mode === 'eip' || o.mode === 's7' || o.mode === 'slmp' || o.mode === 'ads' ? o.mode : 'serve',
    port: isPort(o.port) ? o.port : d.port,
    network: o.network === true,
    plcHost: isPlcHost(o.plcHost) ? o.plcHost : d.plcHost,
    plcPort: isPort(o.plcPort) ? o.plcPort : d.plcPort,
    inputBase: isWord(o.inputBase) ? o.inputBase : d.inputBase,
    outputBase: isWord(o.outputBase) ? o.outputBase : d.outputBase,
    opcUaEndpoint: isOpcUaEndpoint(o.opcUaEndpoint) ? o.opcUaEndpoint : d.opcUaEndpoint,
    // a start point that is not a path or a NodeId is dropped, and the rest kept
    opcUaBrowseFrom: Array.isArray(o.opcUaBrowseFrom)
      ? o.opcUaBrowseFrom.filter((r): r is string => typeof r === 'string' && opcUaBrowseRoot(r) !== null).slice(0, MAX_BROWSE_ROOTS)
      : d.opcUaBrowseFrom,
    eipGateway: isPlcHost(o.eipGateway) ? o.eipGateway : d.eipGateway,
    eipPath: isEipPath(o.eipPath) ? o.eipPath : d.eipPath,
    eipFamily: isEipFamily(o.eipFamily) ? o.eipFamily : d.eipFamily,
    s7Host: isPlcHost(o.s7Host) ? o.s7Host : d.s7Host,
    s7Port: isPort(o.s7Port) ? o.s7Port : d.s7Port,
    s7Rack: isWhole(o.s7Rack, 0, 7) ? o.s7Rack : d.s7Rack,
    s7Slot: isWhole(o.s7Slot, 0, 31) ? o.s7Slot : d.s7Slot,
    slmpHost: isPlcHost(o.slmpHost) ? o.slmpHost : d.slmpHost,
    slmpPort: isPort(o.slmpPort) ? o.slmpPort : d.slmpPort,
    adsNetId: isAmsNetId(o.adsNetId) ? o.adsNetId : d.adsNetId,
    adsPort: isPort(o.adsPort) ? o.adsPort : d.adsPort,
  }
}

export function readExternalPlc(): ExternalPlcSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_EXTERNAL_PLC }
  try {
    const text = localStorage.getItem(EXTERNAL_PLC_KEY)
    return sanitizeExternalPlc(text ? JSON.parse(text) : null)
  } catch {
    return { ...DEFAULT_EXTERNAL_PLC }
  }
}
