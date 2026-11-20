import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { Text as YText } from 'yjs'
import type { Extension } from '@codemirror/state'
import type { PackageGate } from './codeTrust'

/**
 * A tiny external store (useSyncExternalStore-shaped) holding the live collaboration state
 * for the UI - connection status, peer count, the remote-peer presence list, and the shared
 * ST-editor binding - so React can read it without threading the provider through the tree.
 * Solo mode leaves everything at its default (room: null), so collab UI doesn't show.
 */
export interface CollabSnapshot {
  room: string | null
  status: 'offline' | 'connecting' | 'connected'
  /** number of people in the room, including this client */
  peers: number
  /** this client's presence id, which others name when they watch it */
  selfId: number | null
  /** the other people running now, whose runs can be watched (docs/live-share.md) */
  runners: readonly Runner[]
  /** how many other people are watching this client's run */
  watchers: number
  /** the presence id of the room's owner, as the server vouches for it (server/roomOwners.mjs), or null */
  owner: number | null
  /** the owner asks everyone to watch its run */
  spotlight: boolean
  /** when this tab last lost (or never had) its connection to the room's server, while it is not connected; else null */
  offlineSince: number | null
}

/** someone running, and the stream their run goes out on */
export interface Runner {
  id: number
  name: string
  stream: string
}

/** an in-progress pose of a part being dragged, streamed live (not committed to the doc) */
export interface DragPose {
  id: string
  position: [number, number, number]
  rotationY: number
  rotationX?: number
  rotationZ?: number
}

/** one other person in the room, as broadcast over Yjs awareness (ephemeral, not persisted) */
export interface RemotePeer {
  clientId: number
  name: string
  color: string
  /** part ids this peer has selected (for the "who's editing what" markers) */
  selection: string[]
  /** this peer's pointer position on the floor, or null when off-canvas */
  cursor: { x: number; y: number; z: number } | null
  /** parts this peer is dragging right now, at their live (uncommitted) poses */
  drag: DragPose[] | null
  /** true while this peer is running their own (private) simulation preview */
  running: boolean
  /** this peer's first-person pose (feet world position + heading) while in pilot mode, else null */
  pilot: PilotPose | null
  /** packageId of the custom part this peer has open in the behavior editor right now (soft-lock holder), else null */
  editingPart: string | null
  /** the stream this peer's run goes out on while it runs (collab/liveShare.ts), else null */
  stream: string | null
  /** the presence id of whoever this peer follows, else null */
  watching: number | null
  /** this peer's camera, published while someone follows them (controller/liveCamera.ts), else null */
  view: PeerView | null
}

/** a camera as followers need it: position, orbit target, and whether it is orthographic */
export interface PeerView {
  px: number
  py: number
  pz: number
  tx: number
  ty: number
  tz: number
  ortho: boolean
}

/** a peer's first-person walk-around pose, broadcast over awareness (ephemeral, not persisted) */
export interface PilotPose {
  x: number
  y: number
  z: number
  /** heading in radians (atan2(-fwd.x, -fwd.z)), for the avatar's facing indicator */
  yaw: number
}

/** the shared ST program (Y.Text) + the prebuilt CodeMirror collab extension, for StEditor */
export interface CollabContext {
  ytext: YText
  stExtension: Extension
}

/** minimal structural view of a y-protocols Awareness (provider.awareness), to avoid the dep */
interface AwarenessLike {
  clientID: number
  getStates(): Map<number, Record<string, unknown>>
  on(event: 'change', cb: () => void): void
}

const OFFLINE: CollabSnapshot = { room: null, status: 'offline', peers: 0, selfId: null, runners: [], watchers: 0, owner: null, spotlight: false, offlineSince: null }
let snapshot: CollabSnapshot = OFFLINE
const statusListeners = new Set<() => void>()

let provider: HocuspocusProvider | null = null
let peers: RemotePeer[] = []
const peerListeners = new Set<() => void>()

let context: CollabContext | null = null

// --- connection status (the toolbar presence chip) ---

export function getCollabSnapshot(): CollabSnapshot {
  return snapshot
}

export function subscribeCollab(cb: () => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

function setStatus(next: Partial<CollabSnapshot>): void {
  // Awareness fires on every peer cursor move, and this runs on each with the same counts. A new snapshot object
  // re-rendered the whole toolbar per move (3 moving peers held a viewer at ~25 fps); publish only a real change.
  if ((Object.keys(next) as (keyof CollabSnapshot)[]).every((k) => sameValue(snapshot[k], next[k]))) return
  snapshot = { ...snapshot, ...next }
  for (const cb of statusListeners) cb()
}

/** the runners list is rebuilt on every awareness change; equal contents are the same snapshot */
const sameValue = (a: unknown, b: unknown): boolean => a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b))

/** try the room's server again now, rather than at the provider's next retry (its back-off grows to many seconds) */
export function retryConnection(): void {
  void provider?.configuration.websocketProvider.connect()
}

/** who owns the room and whether they ask everyone to watch, as the server says (liveRelay.mjs `o`) */
export function setRoomState(owner: number | null, spotlight: boolean): void {
  setStatus({ owner, spotlight })
}

// --- remote presence (cursors + selection markers) ---

export function getPeers(): RemotePeer[] {
  return peers
}

export function subscribePeers(cb: () => void): () => void {
  peerListeners.add(cb)
  return () => peerListeners.delete(cb)
}

/**
 * The most part ids a presence field carries, and the longest id it carries. Presence is one JSON
 * state per client, resent whole on every change, and the server refuses an awareness message
 * over 256 KB (server/index.mjs MAX_AWARENESS_BYTES) by closing the connection, so the publisher
 * has to stay under it: 500 drag poses plus 500 selected ids, at their longest, are ~155 KB.
 * A selection past the cap shows rings on its first 500 parts; a drag past it is not streamed at
 * all (peers see the group land on commit, rather than part of it gliding and the rest jumping).
 */
export const PRESENCE_MAX_IDS = 500
export const PRESENCE_MAX_ID_LENGTH = 64
/** the longest display name shown for a peer (setDisplayName trims ours to 40) */
export const PRESENCE_MAX_NAME = 40
const PRESENCE_DEFAULT_COLOR = '#888888'
const COLOR_RE = /^#[0-9a-f]{6}$/i
/** a live-share stream id, as liveShare.ts makes them and the server accepts (server/liveRelay.mjs) */
const STREAM_RE = /^[A-Za-z0-9-]{1,64}$/

const presenceId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= PRESENCE_MAX_ID_LENGTH

/** publish this client's current selection so peers can mark "who's editing what" */
export function setLocalSelection(ids: readonly string[]): void {
  provider?.setAwarenessField('selection', ids.filter(presenceId).slice(0, PRESENCE_MAX_IDS))
}

/** publish this client's floor cursor (null when the pointer leaves the canvas) */
export function setLocalCursor(pt: { x: number; y: number; z: number } | null): void {
  provider?.setAwarenessField('cursor', pt)
}

/** publish whether this client is running its (private) simulation preview, for peer presence */
export function setLocalRunning(running: boolean): void {
  provider?.setAwarenessField('running', running)
}

/** publish the stream this client's run goes out on while it runs, so others can watch it */
export function setLocalStream(stream: string | null): void {
  provider?.setAwarenessField('stream', stream)
}

/** publish this client's camera while someone follows it, or null */
export function setLocalView(view: PeerView | null): void {
  provider?.setAwarenessField('view', view)
}

/** publish whom this client follows, so they can see their audience and the people list can say */
export function setLocalWatching(watching: number | null): void {
  provider?.setAwarenessField('watching', watching)
}

/** publish this client's first-person pilot pose (null when not piloting); ephemeral presence */
export function setLocalPilot(pose: PilotPose | null): void {
  provider?.setAwarenessField('pilot', pose)
}

let localDragging = false

/** true while a live provider is attached - presence publishing has somewhere to go. Lets hot
 *  per-frame publishers (the drag-pose stream) skip building their payload entirely in solo mode. */
export function hasCollabProvider(): boolean {
  return provider !== null
}

/** publish this client's in-progress drag poses (null ends the drag); ephemeral, never committed */
export function setLocalDrag(poses: DragPose[] | null): void {
  localDragging = poses !== null && poses.length > 0
  const publishable = poses && poses.length <= PRESENCE_MAX_IDS && poses.every((p) => presenceId(p.id)) ? poses : null
  provider?.setAwarenessField('drag', publishable)
}

/** true while THIS client is mid-drag - the bridge skips remote-drag overrides so the local drag owns the view */
export function isLocalDragging(): boolean {
  return localDragging
}

/**
 * Publish the custom-part package this client is actively editing in the behavior editor (null = none).
 * This is the soft-lock signal: a peer opening the same part sees a holder and starts read-only. Ephemeral,
 * so a holder who disconnects (closes the tab, drops network) releases it automatically.
 */
export function setLocalEditingPart(packageId: string | null): void {
  provider?.setAwarenessField('editingPart', packageId)
}

/** OTHER peers who currently have this package open in the behavior editor (the soft-lock holders) */
export function peersEditingPart(packageId: string): RemotePeer[] {
  return peers.filter((p) => p.editingPart === packageId)
}

/** merged live drag poses from all OTHER peers, keyed by part id (latest peer wins on overlap) */
export function remoteDragPoses(): Map<string, DragPose> {
  const out = new Map<string, DragPose>()
  for (const peer of peers) {
    if (!peer.drag) continue
    for (const pose of peer.drag) out.set(pose.id, pose)
  }
  return out
}

// --- shared ST editor context ---

export function setCollabContext(ctx: CollabContext | null): void {
  context = ctx
  for (const cb of statusListeners) cb() // the PLC editor binds to it, and a room can be entered after it mounted
}

export function getCollabContext(): CollabContext | null {
  return context
}

// --- the room's code trust gate (codeTrust.ts) ---

let codeGate: PackageGate | null = null

/** how this room treats code someone else wrote: run it in the part sandbox, or hold it until allowed */
export interface RoomCodeMode {
  /** true: the part sandbox is on (core/parts/partSandbox.ts), so room code runs by default */
  sandboxed: boolean
  /** the server doc name, the key an Allow is remembered under (codeTrust.ts) */
  docName: string
  /** why this open holds other people's code even though the room would run it: the link said `?nocode`, or the
   *  last open never finished (codeTrust.ts roomOpenDidNotFinish). Null: an ordinary open. */
  safe?: 'link' | 'recovered' | null
}
let codeMode: RoomCodeMode | null = null

/** set by the room boot; the join prompt and the behavior editor read it (null solo: nothing is ever held) */
export function setRoomCodeGate(gate: PackageGate | null, mode: RoomCodeMode | null = null): void {
  codeGate = gate
  codeMode = gate ? mode : null
}

export function getRoomCodeGate(): PackageGate | null {
  return codeGate
}

export function getRoomCodeMode(): RoomCodeMode | null {
  return codeMode
}

// The room's shared program is not read from here: the Y.Text is mirrored into store state by the
// collab bridge (applyRemoteStProgram) and written back through the store's program sink, so the
// controller, the exporter and the room seeder all read one program. This context is only
// CodeMirror's binding to the shared text.

// --- wiring ---

const DISPLAY_NAME_KEY = 'oip-web/display-name'

/** the user's chosen display name ('' = none set; presence falls back to the animal) */
export function getDisplayName(): string {
  try {
    return localStorage.getItem(DISPLAY_NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

/** set (or clear with '') the display name and republish presence under it, live */
export function setDisplayName(name: string): void {
  const trimmed = name.trim().slice(0, 40)
  try {
    if (trimmed) localStorage.setItem(DISPLAY_NAME_KEY, trimmed)
    else localStorage.removeItem(DISPLAY_NAME_KEY)
  } catch {
    /* ignore */
  }
  provider?.setAwarenessField('user', localIdentity())
}

/** this client's current presence name (display name, else the tab's animal) - stamped onto
 *  shared edit-feed events at write time by the collab bridge */
export function getLocalActorName(): string {
  return localIdentity().name
}

/** this client's name and colour as the others see them (the toolbar's own avatar) */
export function getLocalIdentity(): { name: string; color: string } {
  return localIdentity()
}

/**
 * The identity broadcast over awareness: a per-tab random animal + color (no accounts),
 * with the name overridden by the user's persisted display name when one is set.
 */
function localIdentity(): { name: string; color: string } {
  const animals = ['Otter', 'Falcon', 'Bison', 'Heron', 'Lynx', 'Marten', 'Gannet', 'Ibex']
  const colors = ['#e6550d', '#3182bd', '#31a354', '#9467bd', '#d6616b', '#17becf', '#bcbd22', '#e377c2']
  // sessionStorage keeps one identity per tab across reloads within the room
  let id: { name: string; color: string } | null = null
  try {
    const raw = sessionStorage.getItem('oip-web/identity')
    if (raw) id = JSON.parse(raw) as { name: string; color: string }
  } catch {
    /* ignore */
  }
  if (!id) {
    const r = Math.floor(Math.random() * animals.length)
    id = { name: animals[r] ?? 'Guest', color: colors[r] ?? '#3182bd' }
    try {
      sessionStorage.setItem('oip-web/identity', JSON.stringify(id))
    } catch {
      /* ignore */
    }
  }
  const custom = getDisplayName()
  return custom ? { ...id, name: custom } : id
}

// --- reading a peer's presence ---
//
// Everything in an awareness state was written by another client, viewers included, and the
// server relays it without looking inside. So it is read as untrusted input: each field is checked
// for the shape this file publishes and replaced by its "absent" value otherwise. The color is the
// pointed one: it is written into inline styles and an SVG fill (PresenceOverlay.tsx, and the ST
// editor's remote carets, stBinding.ts), where `url(https://...)` would make every peer's browser
// fetch an address of the sender's choosing, so it must be a plain #rrggbb.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** a peer's color as a #rrggbb string, else the neutral default */
export function presenceColor(v: unknown): string {
  return typeof v === 'string' && COLOR_RE.test(v) ? v : PRESENCE_DEFAULT_COLOR
}

/** a peer's display name: a non-blank string, capped; else 'Guest' */
export function presenceName(v: unknown): string {
  if (typeof v !== 'string') return 'Guest'
  const name = v.trim().slice(0, PRESENCE_MAX_NAME)
  return name.length > 0 ? name : 'Guest'
}

/** a camera this far from the origin is no camera a scene is framed with; a follower's would be put there */
const MAX_VIEW_COORD = 1e5

/** a camera of finite, bounded coordinates, or null */
function readView(v: unknown): PeerView | null {
  if (!isRecord(v)) return null
  const keys = ['px', 'py', 'pz', 'tx', 'ty', 'tz'] as const
  if (!keys.every((k) => finite(v[k]) && Math.abs(v[k] as number) <= MAX_VIEW_COORD)) return null
  return { px: v.px as number, py: v.py as number, pz: v.pz as number, tx: v.tx as number, ty: v.ty as number, tz: v.tz as number, ortho: v.ortho === true }
}

function readPoint(v: unknown): { x: number; y: number; z: number } | null {
  if (!isRecord(v) || !finite(v.x) || !finite(v.y) || !finite(v.z)) return null
  return { x: v.x, y: v.y, z: v.z }
}

function readPilot(v: unknown): PilotPose | null {
  const p = readPoint(v)
  return p && isRecord(v) && finite(v.yaw) ? { ...p, yaw: v.yaw } : null
}

function readDragPose(v: unknown): DragPose | null {
  if (!isRecord(v) || !presenceId(v.id) || !finite(v.rotationY)) return null
  const pos = v.position
  if (!Array.isArray(pos) || pos.length !== 3) return null
  const [x, y, z] = pos as unknown[]
  if (!finite(x) || !finite(y) || !finite(z)) return null
  const pose: DragPose = { id: v.id, position: [x, y, z], rotationY: v.rotationY }
  if (v.rotationX !== undefined) {
    if (!finite(v.rotationX)) return null
    pose.rotationX = v.rotationX
  }
  if (v.rotationZ !== undefined) {
    if (!finite(v.rotationZ)) return null
    pose.rotationZ = v.rotationZ
  }
  return pose
}

/** a drag is all-or-nothing, like the publisher's: one bad pose drops the whole stream */
function readDrag(v: unknown): DragPose[] | null {
  if (!Array.isArray(v) || v.length > PRESENCE_MAX_IDS) return null
  const out: DragPose[] = []
  for (const item of v) {
    const pose = readDragPose(item)
    if (!pose) return null
    out.push(pose)
  }
  return out
}

function readSelection(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, PRESENCE_MAX_IDS).filter(presenceId)
}

/** one remote awareness state as a RemotePeer, every field checked (see above) */
export function readPeer(clientId: number, st: unknown): RemotePeer {
  const s = isRecord(st) ? st : {}
  const user = isRecord(s.user) ? s.user : {}
  return {
    clientId,
    name: presenceName(user.name),
    color: presenceColor(user.color),
    selection: readSelection(s.selection),
    // The ST editor's binding (y-codemirror) publishes its text caret under this same `cursor` key
    // as {anchor, head} while that editor has focus; that shape is not a floor point and reads as null.
    cursor: readPoint(s.cursor),
    drag: readDrag(s.drag),
    running: s.running === true,
    pilot: readPilot(s.pilot),
    // a package id, not a part id; 256 is far past any real one and only stops a megabyte string
    editingPart: typeof s.editingPart === 'string' && s.editingPart.length <= 256 ? s.editingPart : null,
    stream: typeof s.stream === 'string' && STREAM_RE.test(s.stream) ? s.stream : null,
    watching: Number.isSafeInteger(s.watching) && (s.watching as number) >= 0 ? (s.watching as number) : null,
    view: readView(s.view),
  }
}

function recomputePeers(awareness: AwarenessLike): void {
  const self = awareness.clientID
  const out: RemotePeer[] = []
  awareness.getStates().forEach((st, id) => {
    if (id === self) return
    out.push(readPeer(id, st))
  })
  peers = out
  for (const cb of peerListeners) cb()
}

/**
 * Wire the provider's connection + awareness into the snapshot/presence stores, and publish
 * this client's identity so it counts toward presence (and renders as a remote cursor/marker
 * for everyone else).
 */
export function initCollabSession(room: string, prov: HocuspocusProvider): void {
  provider = prov
  setStatus({ room, status: 'connecting', peers: 1, offlineSince: Date.now() })
  prov.setAwarenessField('user', localIdentity())

  prov.on('status', (event: { status: string }) => {
    const connected = event.status === 'connected'
    setStatus({ status: connected ? 'connected' : 'connecting', offlineSince: connected ? null : (snapshot.offlineSince ?? Date.now()) })
  })

  const awareness = prov.awareness as AwarenessLike | undefined
  if (awareness) {
    const update = (): void => {
      recomputePeers(awareness)
      setStatus({
        peers: Math.max(1, awareness.getStates().size),
        selfId: awareness.clientID,
        runners: peers.flatMap((p) => (p.stream !== null && p.running ? [{ id: p.clientId, name: p.name, stream: p.stream }] : [])),
        watchers: peers.filter((p) => p.watching === awareness.clientID).length,
      })
    }
    awareness.on('change', update)
    update()
  }
}
