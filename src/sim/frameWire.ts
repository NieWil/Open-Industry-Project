import type { BoxFrame, CargoShapeRef, FrameDressing } from '../core/frame'

/**
 * The two BoxFrame fields that cross the worker boundary only as far as they changed (protocol.ts 'frame').
 *
 * Every other per-body column is a typed array the worker transfers (zero-copy). `partIds` (a string per body)
 * and `dressings` (objects) have to be structured-cloned. Sent whole, on the demo that is ~0.4 ms of main-thread
 * deserialization per frame (~840 ids and ~9 KB across ~50 dressings) for content that barely changes: the ids
 * change when cargo spawns, leaves or changes hands, and of the dressings only the one a wrapper is wrapping
 * changes per frame (its film web follows the turning arm). So:
 *  - `partIds` goes out whole when it changed, else `partIdsKept`;
 *  - `dressings` goes out whole on the first frame (or when all of it changed), else as a patch: the new
 *    length plus just the entries whose content changed, by index;
 *  - `shapes` (each body's own shape key, core/cargoBody.ts) goes like `partIds`, and `shapeRefs` (what each key
 *    is) only as the keys the client has not had: a run's set of shapes only grows.
 *  - the records by part (`lamps`, `tags`, `beamHits` and the rest of {@link FRAME_RECORDS}) go out whole the
 *    first time, then as the parts whose entry changed, or not at all when none did ({@link RecordEncoder}). On an
 *    800-part line they are 180 KB a frame, 2 ms of main-thread deserialization sixty times a second, and between
 *    two frames a sensor or two changed.
 * The client rebuilds all of them, and every consumer keeps seeing a complete BoxFrame.
 *
 * Change is judged by content, never by a revision counter: a box's owner can change without the box list
 * changing (a hand-off, a promotion), and the world's dressings are live objects it mutates in place, so
 * neither identity nor a rev the world forgot to bump could be trusted. Comparing per index stays exact when
 * entries are inserted or removed: every shifted index compares unequal and is re-sent.
 */
/** The frame's records keyed by part id, each of which crosses only as far as it changed. */
export const FRAME_RECORDS = ['joints', 'subPoses', 'copySpeeds', 'lamps', 'values', 'displays', 'tags', 'basePoses', 'conveyorSpeeds', 'beamHits', 'marks'] as const
export type FrameRecordField = (typeof FRAME_RECORDS)[number]
export type FrameRecords = Pick<BoxFrame, FrameRecordField>

/** What changed in a record since the client's copy: the entries to set, and the keys it no longer has. */
export interface RecordPatch {
  set?: Record<string, unknown>
  drop?: readonly string[]
}

/**
 * One record (a value per key) as it crosses: whole, as a patch on the copy the receiver holds, 'kept' when that
 * copy is still right, or 'none' when there is no record.
 *
 * Change is judged per entry by content, as the dressings are, since the world's records are live objects. A patch
 * is used only while the keys keep their order: a new key goes out with the whole record, so the receiver's copy
 * lists its keys as the sender's does. Numbers compare as JSON writes them, which tells neither -0 from 0 nor NaN
 * from Infinity: an entry that changed only that way stays as the receiver has it.
 */
export class RecordEncoder {
  private sent: Map<string, string> | null = null // per-key JSON of what the receiver holds; null = it holds none

  reset(): void {
    this.sent = null
  }

  encode<V>(record: Readonly<Record<string, V>> | undefined): { whole: Readonly<Record<string, V>> } | { patch: RecordPatch } | 'kept' | 'none' {
    if (!record) {
      this.sent = null
      return 'none'
    }
    const prev = this.sent
    const next = new Map<string, string>()
    let set: Record<string, unknown> | undefined
    let added = false
    for (const key of Object.keys(record)) {
      // serialized now, while the live object holds this frame's values (postMessage clones at the same moment)
      const json = JSON.stringify(record[key]) ?? ''
      next.set(key, json)
      const had = prev?.get(key)
      if (had === json) continue
      if (had === undefined) added = true
      ;(set ??= {})[key] = record[key]
    }
    this.sent = next
    if (prev === null || added) return { whole: record }
    let drop: string[] | undefined
    if (prev.size !== next.size) for (const key of prev.keys()) if (!next.has(key)) (drop ??= []).push(key)
    if (!set && !drop) return 'kept'
    return { patch: { ...(set ? { set } : {}), ...(drop ? { drop } : {}) } }
  }
}

/** The receiving half of {@link RecordEncoder}: the last copy, a new object whenever it changed. */
export class RecordDecoder<V> {
  value: Readonly<Record<string, V>> | undefined = undefined

  accept(whole: Readonly<Record<string, V>> | undefined, patch: RecordPatch | undefined, kept: boolean): Readonly<Record<string, V>> | undefined {
    if (whole) this.value = whole
    else if (patch) {
      // (a new object, so a consumer holding the last frame's never sees it change; entries that did not change
      // are the same objects as before, and a set key keeps its place)
      const next: Record<string, V> = { ...this.value }
      for (const key of patch.drop ?? []) delete next[key]
      Object.assign(next, patch.set)
      this.value = next
    } else if (!kept) this.value = undefined
    return this.value
  }
}

export interface FrameWireFields extends Partial<FrameRecords> {
  /** the records the client's copy of is still right ({@link FRAME_RECORDS}) */
  recordsKept?: readonly FrameRecordField[]
  /** the records that changed in part, as what to change in the client's copy */
  recordPatches?: Partial<Record<FrameRecordField, RecordPatch>>
  partIds?: readonly (string | null)[]
  partIdsKept?: true
  dressings?: readonly Readonly<FrameDressing>[]
  dressingsPatch?: { length: number; changed: [number, Readonly<FrameDressing>][] }
  shapes?: readonly (string | null)[]
  shapesKept?: true
  shapeRefsNew?: Record<string, CargoShapeRef>
}

/** worker side: one per worker, `reset()` whenever the world is rebuilt or dropped */
export class FrameWireEncoder {
  private sentPartIds: readonly (string | null)[] | null = null
  private sentDressings: string[] | null = null // per-entry JSON of what the client holds; null = it holds none
  private sentShapes: readonly (string | null)[] | null = null
  private sentShapeRefs = new Set<string>()
  private readonly records = new Map(FRAME_RECORDS.map((field) => [field, new RecordEncoder()]))

  /** a frame's records by part, each as far as it changed since the last frame */
  encodeRecords(frame: Partial<FrameRecords>): FrameWireFields {
    const out: FrameWireFields = {}
    let kept: FrameRecordField[] | undefined
    let patches: Partial<Record<FrameRecordField, RecordPatch>> | undefined
    for (const [field, encoder] of this.records) {
      const sent = encoder.encode(frame[field] as Readonly<Record<string, unknown>> | undefined)
      if (sent === 'none') continue
      if (sent === 'kept') (kept ??= []).push(field)
      else if ('patch' in sent) (patches ??= {})[field] = sent.patch
      else (out as Record<string, unknown>)[field] = sent.whole
    }
    if (kept) out.recordsKept = kept
    if (patches) out.recordPatches = patches
    return out
  }

  /** a new world's first frame must carry both in full */
  reset(): void {
    for (const encoder of this.records.values()) encoder.reset()
    this.sentPartIds = null
    this.sentDressings = null
    this.sentShapes = null
    this.sentShapeRefs = new Set()
  }

  encode(
    partIds: readonly (string | null)[],
    dressings: readonly Readonly<FrameDressing>[] | undefined,
    shapes?: readonly (string | null)[],
    shapeRefs?: Readonly<Record<string, CargoShapeRef>>,
  ): FrameWireFields {
    const idsKept = this.sentPartIds !== null && sameIds(this.sentPartIds, partIds)
    if (!idsKept) this.sentPartIds = partIds
    return { ...(idsKept ? { partIdsKept: true as const } : { partIds }), ...this.encodeDressings(dressings), ...this.encodeShapes(shapes, shapeRefs) }
  }

  private encodeShapes(shapes: readonly (string | null)[] | undefined, refs: Readonly<Record<string, CargoShapeRef>> | undefined): FrameWireFields {
    let fresh: Record<string, CargoShapeRef> | undefined
    for (const [key, ref] of Object.entries(refs ?? {})) {
      if (this.sentShapeRefs.has(key)) continue
      this.sentShapeRefs.add(key)
      ;(fresh ??= {})[key] = ref
    }
    const out: FrameWireFields = fresh ? { shapeRefsNew: fresh } : {}
    if (!shapes) {
      this.sentShapes = null // absent on the wire = no body has its own shape this frame
      return out
    }
    const kept = this.sentShapes !== null && sameIds(this.sentShapes, shapes)
    if (!kept) this.sentShapes = shapes
    return { ...out, ...(kept ? { shapesKept: true as const } : { shapes }) }
  }

  private encodeDressings(dressings: readonly Readonly<FrameDressing>[] | undefined): FrameWireFields {
    if (!dressings) {
      this.sentDressings = null // absent on the wire = the client drops its copy
      return {}
    }
    // serialized now, while the live objects hold this frame's values (postMessage clones at the same moment)
    const json = dressings.map((d) => JSON.stringify(d))
    const prev = this.sentDressings
    this.sentDressings = json
    if (prev === null) return { dressings }
    const changed: [number, Readonly<FrameDressing>][] = []
    for (let i = 0; i < json.length; i++) if (json[i] !== prev[i]) changed.push([i, dressings[i]!])
    if (changed.length === json.length && json.length > 0) return { dressings } // all of it moved: send it plainly
    return { dressingsPatch: { length: json.length, changed } }
  }
}

/** client side: holds the last copies; the array and its entries are shared by consecutive frames, so read-only */
export class FrameWireDecoder {
  partIds: readonly (string | null)[] = []
  dressings: readonly Readonly<FrameDressing>[] | undefined = undefined
  shapes: readonly (string | null)[] | undefined = undefined
  /** every shape the run has used; a new object when one is added, so a consumer can compare by identity */
  shapeRefs: Readonly<Record<string, CargoShapeRef>> = {}
  /** the frame's records by part: each the last copy, a new object when it changed, absent when the frame has none */
  records: Partial<FrameRecords> = {}
  private readonly recordDecoders = new Map(FRAME_RECORDS.map((field) => [field, new RecordDecoder<unknown>()]))

  /** call on every frame message, including ones the caller then drops, or the copies fall a frame behind */
  accept(msg: FrameWireFields): void {
    const records: Record<string, unknown> = {}
    for (const [field, decoder] of this.recordDecoders) {
      const value = decoder.accept(msg[field] as Readonly<Record<string, unknown>> | undefined, msg.recordPatches?.[field], msg.recordsKept?.includes(field) === true)
      if (value) records[field] = value
    }
    this.records = records as Partial<FrameRecords>
    if (msg.partIds) this.partIds = msg.partIds
    if (msg.shapeRefsNew) this.shapeRefs = { ...this.shapeRefs, ...msg.shapeRefsNew }
    if (msg.shapes) this.shapes = msg.shapes
    else if (!msg.shapesKept) this.shapes = undefined
    if (msg.dressings) this.dressings = msg.dressings
    else if (msg.dressingsPatch) {
      const { length, changed } = msg.dressingsPatch
      // a patch only follows a full send in the same world (the encoder guarantees it), so `dressings` is set;
      // a new array each time, so a consumer holding last frame's never sees it change under it
      const next = (this.dressings ?? []).slice(0, length)
      for (const [i, d] of changed) next[i] = d
      this.dressings = next
    } else this.dressings = undefined
  }
}

function sameIds(a: readonly (string | null)[], b: readonly (string | null)[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
