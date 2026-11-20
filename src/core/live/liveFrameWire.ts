// The live-share wire format: a running sim's frames (BoxFrame, core/frame.ts) as compact binary messages, for viewers
// who draw a sharer's run without simulating it (docs/live-share.md).
//
// A worker frame is ~330 KB as JSON on the demo, but only 15-20 of its ~1,100 bodies move in a frame, so a message
// carries what changed since the last one: bodies added, changed or gone, the poses that moved, and the per-part
// records whose value changed. Measured on the demo with the line running, that is ~1 KB a frame. The body-to-part
// list the worker resends whole on every spawn (sim/frameWire.ts) travels here as one record per body, because
// resent whole it was ~170 KB.
//
// Poses are quantised: position to 0.1 mm, rotation as the smallest three quaternion components in 16 bits. A body
// is sent when its quantised pose moved past a small threshold, so a resting body costs nothing. The sharer's PLC
// variables (its watch table, what annotations and the Watch panel read) travel the same way, as changes. The encoder keeps
// a mirror of what a decoder holds, and `snapshot()` writes that mirror whole, so a viewer joining late applies the
// latest snapshot and then every delta after it. Deltas carry a sequence number and a decoder refuses a gap.

import type { BoxFrame, CargoShapeRef, FrameDressing } from '../frame'
import { forEachWatchValue, watchHas, watchKeyCount } from '../watchTable'

const VERSION = 1
export const LIVE_DELTA = 1
export const LIVE_SNAPSHOT = 2

/** metres per position unit */
const POS_UNIT = 1e-4
/** a body is resent when a position moved this many units (0.5 mm) or a rotation component this many */
const POS_EPS = 5
const ROT_EPS = 3
const ROT_SCALE = 32767 * Math.SQRT2

// Per-part records, keyed part id then name. LEAF fields hold one value per part. ROUNDED fields are poses and speeds
// a viewer only draws, so they go to 4 decimals and float noise does not resend them.
const NESTED_FIELDS = ['joints', 'subPoses', 'copySpeeds', 'lamps', 'values', 'displays', 'tags', 'beamHits', 'marks'] as const
const LEAF_FIELDS = ['basePoses', 'conveyorSpeeds'] as const
type RecordField = (typeof NESTED_FIELDS)[number] | (typeof LEAF_FIELDS)[number]
const ROUNDED = new Set<RecordField>(['joints', 'subPoses', 'copySpeeds', 'beamHits', 'basePoses', 'conveyorSpeeds'])

interface BodyMeta {
  halfExtents: [number, number, number]
  color: [number, number, number]
  kind: number
  caps: number | null
  partId: string | null
  shape: string | null
}

interface BodyState extends BodyMeta {
  /** quantised position, POS_UNIT */
  pos: Int32Array
  /** largest-component index, then the other three scaled by ROT_SCALE */
  rot: Int16Array
  /** the encoder's position before this frame, while encode() writes the body's delta */
  prev?: Int32Array
}

/** what a part's records hold per field: part id -> leaf text (LEAF_FIELDS) or name -> leaf text */
type RecordMirror = Map<RecordField, Map<string, string | Map<string, string>>>

/** no program attached: one object, so two frames without one compare the same */
const NO_WATCH: Readonly<Record<string, LiveWatchValue>> = Object.freeze({})

/** a PLC variable's value as the watch table holds it */
export type LiveWatchValue = number | boolean | string

/** the JSON tail of a message: record changes, dressings, new shape refs, PLC variable changes (null = gone) */
interface Tail {
  r?: Record<string, Record<string, unknown>>
  w?: Record<string, LiveWatchValue | null>
  d?: { full: readonly FrameDressing[] } | { length: number; changed: [number, FrameDressing][] } | null
  s?: Record<string, CargoShapeRef>
}

export class LiveFrameEncoder {
  private seq = 0
  private simTime = 0
  private readonly bodies = new Map<number, BodyState>()
  private readonly records: RecordMirror = new Map()
  private dressings: string[] | null = null
  private dressingObjs: FrameDressing[] = []
  private readonly shapeRefs = new Map<string, CargoShapeRef>()
  private readonly watch = new Map<string, LiveWatchValue>()
  /** the table the last diff was taken against */
  private watchOf: object | null = null

  /** the sequence number of the last message encode() returned */
  get lastSeq(): number {
    return this.seq
  }

  /** A delta from the previous frame to this one, and from the previous PLC variables to `watch` (null: none). */
  encode(f: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>> | null = null): Uint8Array {
    this.seq++
    this.simTime = f.simTime
    const w = new Writer()
    w.u8(VERSION)
    w.u8(LIVE_DELTA)
    w.varint(this.seq)
    w.f64(f.simTime)

    const seen = new Set<number>()
    for (let i = 0; i < f.count; i++) seen.add(f.ids[i]!)
    const gone: number[] = []
    for (const id of this.bodies.keys()) if (!seen.has(id)) gone.push(id)
    for (const id of gone) this.bodies.delete(id)
    w.varint(gone.length)
    for (const id of gone) w.varint(id)

    const metaChanged: number[] = []
    const moved: number[] = []
    const pos = new Int32Array(3)
    const rot = new Int16Array(4)
    for (let i = 0; i < f.count; i++) {
      const id = f.ids[i]!
      const meta = metaOf(f, i)
      quantise(f, i, pos, rot)
      let b = this.bodies.get(id)
      if (!b) {
        b = { ...meta, pos: new Int32Array(3), rot: new Int16Array(4) }
        this.bodies.set(id, b)
        metaChanged.push(id)
        moved.push(id)
      } else {
        if (!sameMeta(b, meta)) {
          Object.assign(b, meta)
          metaChanged.push(id)
        }
        if (!poseNear(b, pos, rot)) moved.push(id)
      }
      if (moved[moved.length - 1] === id) {
        b.prev = b.pos.slice()
        b.pos.set(pos)
        b.rot.set(rot)
      }
    }
    w.varint(metaChanged.length)
    for (const id of metaChanged) writeMeta(w, id, this.bodies.get(id)!)
    w.varint(moved.length)
    for (const id of moved) {
      const b = this.bodies.get(id)!
      const prev = b.prev ?? ZERO3
      w.varint(id)
      for (let k = 0; k < 3; k++) w.zigzag(b.pos[k]! - prev[k]!)
      w.u8(b.rot[0]!)
      for (let k = 1; k < 4; k++) w.i16(b.rot[k]!)
      b.prev = undefined
    }

    const tail: Tail = {}
    const r = this.diffRecords(f)
    if (r) tail.r = r
    const d = this.diffDressings(f.dressings)
    if (d !== undefined) tail.d = d
    const s = this.newShapeRefs(f.shapeRefs)
    if (s) tail.s = s
    const wd = this.diffWatch(watch)
    if (wd) tail.w = wd
    w.str(Object.keys(tail).length ? JSON.stringify(tail) : '')
    return w.bytes()
  }

  /** Everything a decoder holds after the last encode(), for a viewer starting from nothing. */
  snapshot(): Uint8Array {
    const w = new Writer()
    w.u8(VERSION)
    w.u8(LIVE_SNAPSHOT)
    w.varint(this.seq)
    w.f64(this.simTime)
    w.varint(0)
    w.varint(this.bodies.size)
    for (const [id, b] of this.bodies) writeMeta(w, id, b)
    w.varint(this.bodies.size)
    for (const [id, b] of this.bodies) {
      w.varint(id)
      for (let k = 0; k < 3; k++) w.zigzag(b.pos[k]!)
      w.u8(b.rot[0]!)
      for (let k = 1; k < 4; k++) w.i16(b.rot[k]!)
    }
    const r: Record<string, Record<string, unknown>> = {}
    for (const [field, parts] of this.records) {
      const out: Record<string, unknown> = {}
      for (const [pid, v] of parts) out[pid] = typeof v === 'string' ? JSON.parse(v) : Object.fromEntries([...v].map(([k, x]) => [k, JSON.parse(x)]))
      r[field] = out
    }
    const tail: Tail = { r }
    if (this.dressings !== null) tail.d = { full: this.dressingObjs }
    if (this.shapeRefs.size) tail.s = Object.fromEntries(this.shapeRefs)
    if (this.watch.size) tail.w = Object.fromEntries(this.watch)
    w.str(JSON.stringify(tail))
    return w.bytes()
  }

  private diffRecords(f: BoxFrame): Tail['r'] | null {
    let out: Record<string, Record<string, unknown>> | null = null
    const put = (field: string, pid: string, v: unknown): void => {
      ;((out ??= {})[field] ??= {})[pid] = v
    }
    for (const field of LEAF_FIELDS) {
      const now = (f[field] ?? {}) as Record<string, unknown>
      let mirror = this.records.get(field)
      if (!mirror) this.records.set(field, (mirror = new Map()))
      for (const [pid, v] of Object.entries(now)) {
        const text = JSON.stringify(ROUNDED.has(field) ? round(v) : v)
        if (mirror.get(pid) === text) continue
        mirror.set(pid, text)
        put(field, pid, JSON.parse(text))
      }
      for (const pid of [...mirror.keys()]) {
        if (pid in now) continue
        mirror.delete(pid)
        put(field, pid, null)
      }
    }
    for (const field of NESTED_FIELDS) {
      const now = (f[field] ?? {}) as Record<string, Record<string, unknown>>
      let mirror = this.records.get(field)
      if (!mirror) this.records.set(field, (mirror = new Map()))
      for (const [pid, rec] of Object.entries(now)) {
        let m = mirror.get(pid) as Map<string, string> | undefined
        let change: Record<string, unknown> | null = null
        if (!m) {
          mirror.set(pid, (m = new Map()))
          change = {}
        }
        for (const [name, v] of Object.entries(rec)) {
          const text = JSON.stringify(ROUNDED.has(field) ? round(v) : v)
          if (m.get(name) === text) continue
          m.set(name, text)
          ;(change ??= {})[name] = JSON.parse(text)
        }
        for (const name of [...m.keys()]) {
          if (name in rec) continue
          m.delete(name)
          ;(change ??= {})[name] = null
        }
        if (change) put(field, pid, change)
      }
      for (const pid of [...mirror.keys()]) {
        if (pid in now) continue
        mirror.delete(pid)
        put(field, pid, null)
      }
    }
    return out
  }

  /** undefined = unchanged; null = gone */
  private diffDressings(dressings: readonly Readonly<FrameDressing>[] | undefined): Tail['d'] | undefined {
    if (!dressings) {
      if (this.dressings === null) return undefined
      this.dressings = null
      this.dressingObjs = []
      return null
    }
    const json = dressings.map((d) => JSON.stringify(d))
    const prev = this.dressings
    this.dressings = json
    this.dressingObjs = json.map((t) => JSON.parse(t) as FrameDressing)
    if (prev === null) return { full: this.dressingObjs }
    const changed: [number, FrameDressing][] = []
    for (let i = 0; i < json.length; i++) if (json[i] !== prev[i]) changed.push([i, this.dressingObjs[i]!])
    if (!changed.length && json.length === prev.length) return undefined
    return { length: json.length, changed }
  }

  private diffWatch(watch: Readonly<Record<string, LiveWatchValue>> | null): Record<string, LiveWatchValue | null> | null {
    let out: Record<string, LiveWatchValue | null> | null = null
    const now = watch ?? NO_WATCH
    // the table is replaced when new values arrive, a few times a second: the same one again holds nothing new
    if (now === this.watchOf) return null
    this.watchOf = now
    forEachWatchValue(now, (k, v) => {
      if (this.watch.get(k) === v) return
      this.watch.set(k, v)
      ;(out ??= {})[k] = v
    })
    // a key that went: only another program's table has other keys
    if (this.watch.size !== watchKeyCount(now)) {
      for (const k of [...this.watch.keys()]) {
        if (watchHas(now, k)) continue
        this.watch.delete(k)
        ;(out ??= {})[k] = null
      }
    }
    return out
  }

  private newShapeRefs(refs: Readonly<Record<string, CargoShapeRef>> | undefined): Record<string, CargoShapeRef> | null {
    let fresh: Record<string, CargoShapeRef> | null = null
    for (const [key, ref] of Object.entries(refs ?? {})) {
      if (this.shapeRefs.has(key)) continue
      this.shapeRefs.set(key, ref)
      ;(fresh ??= {})[key] = ref
    }
    return fresh
  }
}

/** What applying a message did: applied, or refused because it does not follow what this decoder holds. */
export type LiveApply = 'applied' | 'gap'

export class LiveFrameDecoder {
  // a new decoder holds what a stream holds before its first message, so it takes delta 1 as a snapshot at 0 would
  private seq = 0
  private simTime = 0
  private readonly bodies = new Map<number, BodyState>()
  private records: Record<string, Record<string, unknown>> = {}
  private dressings: FrameDressing[] | undefined
  private shapeRefs: Record<string, CargoShapeRef> = {}
  private watchVars: Record<string, LiveWatchValue> = {}
  private cached: BoxFrame | null = null

  get lastSeq(): number {
    return this.seq
  }

  apply(msg: Uint8Array): LiveApply {
    const r = new Reader(msg)
    if (r.u8() !== VERSION) throw new Error('live frame: unknown version')
    const type = r.u8()
    const seq = r.varint()
    if (type === LIVE_SNAPSHOT) {
      this.bodies.clear()
      this.records = {}
      this.dressings = undefined
      this.shapeRefs = {}
      this.watchVars = {}
    } else if (type !== LIVE_DELTA) throw new Error(`live frame: unknown message type ${type}`)
    else if (seq !== this.seq + 1) return 'gap'
    this.seq = seq
    this.simTime = r.f64()

    for (let n = r.varint(); n > 0; n--) this.bodies.delete(r.varint())
    for (let n = r.varint(); n > 0; n--) {
      const id = r.varint()
      const meta = readMeta(r)
      const b = this.bodies.get(id)
      if (b) Object.assign(b, meta)
      else this.bodies.set(id, { ...meta, pos: new Int32Array(3), rot: new Int16Array(4) })
    }
    for (let n = r.varint(); n > 0; n--) {
      const id = r.varint()
      const b = this.bodies.get(id)
      if (!b) throw new Error(`live frame: pose for unknown body ${id}`)
      for (let k = 0; k < 3; k++) b.pos[k] = b.pos[k]! + r.zigzag()
      b.rot[0] = r.u8()
      for (let k = 1; k < 4; k++) b.rot[k] = r.i16()
    }
    const text = r.str()
    if (text) {
      const tail = JSON.parse(text) as Tail
      if (tail.r) this.applyRecords(tail.r)
      if (tail.d === null) this.dressings = undefined
      else if (tail.d && 'full' in tail.d) this.dressings = tail.d.full.slice()
      else if (tail.d) {
        const next = (this.dressings ?? []).slice(0, tail.d.length)
        for (const [i, d] of tail.d.changed) next[i] = d
        this.dressings = next
      }
      if (tail.s) this.shapeRefs = { ...this.shapeRefs, ...tail.s }
      if (tail.w) {
        const next = { ...this.watchVars }
        for (const [k, v] of Object.entries(tail.w)) {
          if (v === null) delete next[k]
          else next[k] = v
        }
        this.watchVars = next
      }
    }
    this.cached = null
    return 'applied'
  }

  private applyRecords(diff: Record<string, Record<string, unknown>>): void {
    const leaf = new Set<string>(LEAF_FIELDS)
    for (const [field, parts] of Object.entries(diff)) {
      const cur = (this.records[field] = { ...(this.records[field] ?? {}) })
      for (const [pid, v] of Object.entries(parts)) {
        if (v === null) delete cur[pid]
        else if (leaf.has(field)) cur[pid] = v
        else {
          const rec = { ...((cur[pid] as Record<string, unknown> | undefined) ?? {}) }
          for (const [name, x] of Object.entries(v as Record<string, unknown>)) {
            if (x === null) delete rec[name]
            else rec[name] = x
          }
          cur[pid] = rec
        }
      }
    }
  }

  /** The sharer's PLC variables as last sent; a new object when one changed, so a reader can compare by identity. */
  watch(): Readonly<Record<string, LiveWatchValue>> {
    return this.watchVars
  }

  /** The frame as the worker would have posted it, from what this decoder holds. The same object until the next apply. */
  frame(): BoxFrame {
    if (this.cached) return this.cached
    const n = this.bodies.size
    const ids = new Uint32Array(n)
    const positions = new Float32Array(n * 3)
    const quats = new Float32Array(n * 4)
    const halfExtents = new Float32Array(n * 3)
    const colors = new Float32Array(n * 3)
    const kinds = new Uint8Array(n)
    const caps = new Uint8Array(n)
    const partIds: (string | null)[] = Array(n).fill(null)
    const shapes: (string | null)[] = Array(n).fill(null)
    let anyCaps = false
    let anyShape = false
    let i = 0
    for (const [id, b] of this.bodies) {
      ids[i] = id
      for (let k = 0; k < 3; k++) {
        positions[i * 3 + k] = b.pos[k]! * POS_UNIT
        halfExtents[i * 3 + k] = b.halfExtents[k]!
        colors[i * 3 + k] = b.color[k]!
      }
      dequantiseRot(b.rot, quats, i * 4)
      kinds[i] = b.kind
      if (b.caps !== null) {
        caps[i] = b.caps
        anyCaps = true
      }
      partIds[i] = b.partId
      shapes[i] = b.shape
      if (b.shape !== null) anyShape = true
      i++
    }
    const frame: BoxFrame = { count: n, ids, positions, quats, halfExtents, colors, kinds, partIds, simTime: this.simTime }
    if (anyCaps) frame.caps = caps
    if (anyShape) {
      frame.shapes = shapes
      frame.shapeRefs = this.shapeRefs
    }
    for (const field of [...NESTED_FIELDS, ...LEAF_FIELDS]) {
      const rec = this.records[field]
      if (rec && Object.keys(rec).length) (frame as unknown as Record<string, unknown>)[field] = rec
    }
    if (this.dressings) frame.dressings = this.dressings
    this.cached = frame
    return frame
  }
}

const ZERO3 = new Int32Array(3)

function metaOf(f: BoxFrame, i: number): BodyMeta {
  return {
    halfExtents: [f.halfExtents[i * 3]!, f.halfExtents[i * 3 + 1]!, f.halfExtents[i * 3 + 2]!],
    color: [f.colors[i * 3]!, f.colors[i * 3 + 1]!, f.colors[i * 3 + 2]!],
    kind: f.kinds[i]!,
    caps: f.caps ? f.caps[i]! : null,
    partId: f.partIds[i] ?? null,
    shape: f.shapes?.[i] ?? null,
  }
}

function sameMeta(a: BodyMeta, b: BodyMeta): boolean {
  return (
    a.kind === b.kind &&
    a.caps === b.caps &&
    a.partId === b.partId &&
    a.shape === b.shape &&
    a.halfExtents[0] === b.halfExtents[0] &&
    a.halfExtents[1] === b.halfExtents[1] &&
    a.halfExtents[2] === b.halfExtents[2] &&
    a.color[0] === b.color[0] &&
    a.color[1] === b.color[1] &&
    a.color[2] === b.color[2]
  )
}

function writeMeta(w: Writer, id: number, b: BodyMeta): void {
  w.varint(id)
  for (const v of b.halfExtents) w.f32(v)
  for (const v of b.color) w.f32(v)
  w.u8(b.kind)
  w.u8(b.caps === null ? 0 : 1)
  if (b.caps !== null) w.u8(b.caps)
  w.nstr(b.partId)
  w.nstr(b.shape)
}

function readMeta(r: Reader): BodyMeta {
  const halfExtents: [number, number, number] = [r.f32(), r.f32(), r.f32()]
  const color: [number, number, number] = [r.f32(), r.f32(), r.f32()]
  const kind = r.u8()
  const caps = r.u8() ? r.u8() : null
  return { halfExtents, color, kind, caps, partId: r.nstr(), shape: r.nstr() }
}

function quantise(f: BoxFrame, i: number, pos: Int32Array, rot: Int16Array): void {
  for (let k = 0; k < 3; k++) pos[k] = Math.round(f.positions[i * 3 + k]! / POS_UNIT)
  const q = [f.quats[i * 4]!, f.quats[i * 4 + 1]!, f.quats[i * 4 + 2]!, f.quats[i * 4 + 3]!]
  let big = 0
  for (let k = 1; k < 4; k++) if (Math.abs(q[k]!) > Math.abs(q[big]!)) big = k
  const sign = q[big]! < 0 ? -1 : 1
  const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1
  rot[0] = big
  let o = 1
  for (let k = 0; k < 4; k++) if (k !== big) rot[o++] = Math.round(((sign * q[k]!) / len) * ROT_SCALE)
}

function dequantiseRot(rot: Int16Array, out: Float32Array, o: number): void {
  const big = rot[0]!
  let sum = 0
  let j = 1
  for (let k = 0; k < 4; k++) {
    if (k === big) continue
    const v = rot[j++]! / ROT_SCALE
    out[o + k] = v
    sum += v * v
  }
  out[o + big] = Math.sqrt(Math.max(0, 1 - sum))
}

function poseNear(b: BodyState, pos: Int32Array, rot: Int16Array): boolean {
  if (b.rot[0] !== rot[0]) return false
  for (let k = 0; k < 3; k++) if (Math.abs(b.pos[k]! - pos[k]!) >= POS_EPS) return false
  for (let k = 1; k < 4; k++) if (Math.abs(b.rot[k]! - rot[k]!) >= ROT_EPS) return false
  return true
}

function round(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 1e4) / 1e4
  if (Array.isArray(v)) return v.map(round)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]))
  return v
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

class Writer {
  private buf = new Uint8Array(1024)
  private view = new DataView(this.buf.buffer)
  private n = 0

  private room(k: number): void {
    if (this.n + k <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.n + k) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.n))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number): void {
    this.room(1)
    this.buf[this.n++] = v
  }

  i16(v: number): void {
    this.room(2)
    this.view.setInt16(this.n, v, true)
    this.n += 2
  }

  f32(v: number): void {
    this.room(4)
    this.view.setFloat32(this.n, v, true)
    this.n += 4
  }

  f64(v: number): void {
    this.room(8)
    this.view.setFloat64(this.n, v, true)
    this.n += 8
  }

  varint(v: number): void {
    this.room(8)
    while (v >= 0x80) {
      this.buf[this.n++] = (v % 0x80) | 0x80
      v = Math.floor(v / 0x80)
    }
    this.buf[this.n++] = v
  }

  zigzag(v: number): void {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v)
  }

  str(s: string): void {
    const b = utf8Encoder.encode(s)
    this.varint(b.length)
    this.room(b.length)
    this.buf.set(b, this.n)
    this.n += b.length
  }

  /** a string or null: length + 1, 0 = null */
  nstr(s: string | null): void {
    if (s === null) return this.varint(0)
    const b = utf8Encoder.encode(s)
    this.varint(b.length + 1)
    this.room(b.length)
    this.buf.set(b, this.n)
    this.n += b.length
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.n)
  }
}

class Reader {
  private readonly view: DataView
  private n = 0

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  private need(k: number): void {
    if (this.n + k > this.buf.length) throw new Error('live frame: message ends early')
  }

  u8(): number {
    this.need(1)
    return this.buf[this.n++]!
  }

  i16(): number {
    this.need(2)
    const v = this.view.getInt16(this.n, true)
    this.n += 2
    return v
  }

  f32(): number {
    this.need(4)
    const v = this.view.getFloat32(this.n, true)
    this.n += 4
    return v
  }

  f64(): number {
    this.need(8)
    const v = this.view.getFloat64(this.n, true)
    this.n += 8
    return v
  }

  varint(): number {
    let v = 0
    let scale = 1
    for (;;) {
      const b = this.u8()
      v += (b & 0x7f) * scale
      if (b < 0x80) return v
      scale *= 0x80
      if (scale > 2 ** 49) throw new Error('live frame: varint too long')
    }
  }

  zigzag(): number {
    const v = this.varint()
    return v % 2 ? -(v + 1) / 2 : v / 2
  }

  private bytesOf(len: number): string {
    this.need(len)
    const s = utf8Decoder.decode(this.buf.subarray(this.n, this.n + len))
    this.n += len
    return s
  }

  str(): string {
    return this.bytesOf(this.varint())
  }

  nstr(): string | null {
    const len = this.varint()
    return len === 0 ? null : this.bytesOf(len - 1)
  }
}
