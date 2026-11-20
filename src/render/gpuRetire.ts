import type { BufferGeometry } from 'three'
import { bundleGroupsRegistered, bundleRecordSerial, notifyBundleStructureChanged } from './bundleGroups'

/**
 * Deferred GPU resource release: nothing frees a buffer a recorded render bundle might still draw.
 *
 * A WebGPU render bundle bakes resource handles (bundleGroups.ts / bundleReplayRefresh.ts), so
 * `geometry.dispose()` can destroy buffers an earlier recording still references. Replaying it submits
 * a destroyed buffer, Dawn rejects the command buffer and the bundled main pass goes black. It does not
 * throw. Frees can outrun invalidation, e.g. a resize drag re-emits geometry on every pointer-move
 * (sdk/rigProcedural.ts realizeProceduralGeometry) while the re-record poll skips a drag-ejected part
 * (view.syncBundleInvalidation's `bundleDragEjected` branch). The stale-recording guard
 * (bundleReplayRefresh.ts) doesn't cover this: it watches `bindings.deleteForRender`, and a geometry
 * dispose kills attribute buffers while the bindings live.
 *
 * So a retired resource is held until a re-record has completed (bundleRecordSerial moved past the
 * retirement), plus a settle margin. Two rules:
 * - Wait on the record, not the request: a dirty frame renders unbundled and records nothing
 *   (bundleGroups.ts, the live-edit hold in liveHoldFrames), so during structural churn (the tail of a scene load) the
 *   epoch advances while no re-record completes, and arming on the epoch frees under the old recording.
 * - Re-record after the free: three re-records each (bundleGroup, camera, renderContext) lazily, so
 *   the armed record may still encode the resource. The drain notifies after any release (reasoning in
 *   drainRetiredGeometry; e2e/verify-webgpu-spur-slide-no-gpu-errors.mjs).
 *
 * Textures too ({@link retireTexture}): `texture.dispose()` destroys a GPUTexture a recorded bind group
 * still views, and a rejected submit drops the whole command buffer, so every pass goes dark. The guard
 * misses it too (`_bindings.has(ro)` still answers true).
 *
 * Materials need no retire path: `material.dispose()` reaches `bindings.deleteForRender(ro)` via
 * RenderObject.onMaterialDispose, the call bundleReplayRefresh.ts counts, so the guard re-records on
 * that same frame, before replay (pinned in docs/three-coupling.md).
 *
 * Costs a few frames of retained data and never frees early. If retirements outrun completed records, the
 * pressure valve forces a re-record rather than freeing under a live one.
 */

interface Retired {
  /** the real free, run once no recording can reach the resources it releases */
  release: () => void
  /** completed-record count at retirement; the re-record we are waiting on must come after this */
  serial: number
  /** drain tick at which the record was first seen to have completed; -1 until then */
  armedAt: number
  bytes: number
  /** retiring call site, captured only under `globalThis.__oipRetireTrace` (see retire()) */
  from?: string
}

/** Drains to wait after the re-record completes. The arm already means the stale encode is gone, so
 *  this is margin, not correctness: the GPU may still be executing the submit that used the old
 *  buffers, and two frames of retention are cheap. */
const SETTLE_TICKS = 2
/** retained-bytes ceiling before we force the invalidation that lets the queue drain */
const PRESSURE_BYTES = 8 * 1024 * 1024
/** queue-length ceiling, for many small geometries that never reach the byte ceiling */
const PRESSURE_COUNT = 512

const queue: Retired[] = []
let retainedBytes = 0
let tick = 0
// record serial at which we last forced a notify. Keyed on the completed-record count, not the
// structural epoch: the valve's own notify advances the epoch, so an epoch key would re-fire on every
// drain. A dirty frame renders unbundled and records nothing, so that would hold the live-edit
// state on forever and the queue would never drain.
let pressureSerial = -1

/** rough GPU footprint of a geometry: its attribute + index arrays */
function byteSize(geo: BufferGeometry): number {
  let n = 0
  for (const attr of Object.values(geo.attributes)) {
    const arr = (attr as { array?: ArrayLike<number> & { BYTES_PER_ELEMENT?: number } }).array
    if (arr) n += arr.length * (arr.BYTES_PER_ELEMENT ?? 4)
  }
  const idx = geo.index
  if (idx) n += idx.array.length * ((idx.array as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 4)
  return n
}

/**
 * Release `geo` once no recorded bundle can still reference it - the replacement for
 * `geometry.dispose()` anywhere the geometry was (or might have been) drawn.
 *
 * Disposes immediately when there are no bundle groups (the WebGL path, `?nobundle`): with no
 * recordings there is nothing to poison, and deferring there would only retain memory.
 */
export function retireGeometry(geo: BufferGeometry | null | undefined): void {
  if (!geo) return
  retire(() => geo.dispose(), byteSize(geo))
}

/**
 * A `Texture` or a `RenderTarget` - anything whose `dispose()` destroys a GPUTexture. Structural
 * rather than three's nominal types, so this seam survives a three bump that reshapes either
 * (docs/three-coupling.md) and so a caller never has to widen an import to free something.
 */
interface RetirableTexture {
  dispose: () => void
  /** `unknown` because three types the base Texture's image so; narrowed in {@link textureBytes} */
  image?: unknown
  width?: number
  height?: number
  generateMipmaps?: boolean
}

/** rough GPU footprint of a texture. A pressure-valve heuristic, never accounting: RGBA8 is
 *  assumed for image-backed textures because the source pixel format is not knowable here. */
function textureBytes(tex: RetirableTexture): number {
  const img = tex.image as
    | { width?: number; height?: number; data?: { length?: number; BYTES_PER_ELEMENT?: number } | null }
    | null
    | undefined
  const data = img?.data
  if (data?.length) return data.length * (data.BYTES_PER_ELEMENT ?? 1)
  const w = img?.width ?? tex.width ?? 0
  const h = img?.height ?? tex.height ?? 0
  if (!w || !h) return 0
  // the mip chain adds ~1/3 on top of level 0, wherever three builds one
  return Math.round(w * h * 4 * (tex.generateMipmaps === false ? 1 : 4 / 3))
}

/**
 * Release `tex` once no recorded bundle can still sample it - the replacement for
 * `texture.dispose()` anywhere the texture was, or might have been, bound (module doc).
 *
 * Retire after the rebind, exactly as with a geometry swap: hand the consumers the replacement
 * first, then retire the old one. The queue guarantees nothing frees under a live recording; it
 * cannot guarantee something still points at what you freed.
 */
export function retireTexture(tex: RetirableTexture | null | undefined): void {
  if (!tex) return
  retire(() => tex.dispose(), textureBytes(tex))
}

/**
 * {@link retireGeometry} for an InstancedMesh, whose own `dispose()` frees the per-instance
 * matrix/colour buffers - as baked into a recording as its vertex data, so it defers on the same
 * schedule rather than being freed alongside a retired geometry.
 */
export function retireInstancedMesh(mesh: { geometry: BufferGeometry; dispose: () => void } | null | undefined): void {
  if (!mesh) return
  const geo = mesh.geometry
  retire(() => {
    mesh.dispose()
    geo.dispose()
  }, byteSize(geo))
}

/**
 * {@link retireInstancedMesh} for a mesh whose geometry must be left alone. The instance pool's
 * meshes draw either a shared template geometry (owned by the source part, never the pool's to
 * free) or a wrapper retired separately. Defers only `mesh.dispose()`, which frees the
 * per-instance buffers.
 */
export function retireInstancedMeshOnly(mesh: { dispose: () => void } | null | undefined): void {
  if (!mesh) return
  retire(() => mesh.dispose(), 0)
}

/** queue a release, or run it now when there are no recordings that could be holding it */
function retire(release: () => void, bytes: number): void {
  if (!bundleGroupsRegistered()) {
    release()
    return
  }
  retainedBytes += bytes
  const e: Retired = { release, serial: bundleRecordSerial(), armedAt: -1, bytes }
  // Opt-in diagnostic (set globalThis.__oipRetireTrace): remember who retired. The
  // release stack always reads "drainRetiredGeometry", which doesn't say which call site owned the
  // lifetime of a freed buffer that poisons a frame.
  if ((globalThis as { __oipRetireTrace?: boolean }).__oipRetireTrace) e.from = new Error().stack
  queue.push(e)
}

/**
 * Drain whatever is now safe to free. Call once per frame, from the same per-frame seam that polls
 * the bundle invalidation (view.syncBundleInvalidation), so a geometry retired this frame is
 * measured against the epoch the poll has just published.
 */
export function drainRetiredGeometry(): void {
  if (queue.length === 0) return
  tick++
  const serial = bundleRecordSerial()
  let write = 0
  let armedAny = false // is anything already on its way out? then the queue is draining, not stuck
  let releasedAny = false // did this drain actually free something? then re-record (see below)
  for (let i = 0; i < queue.length; i++) {
    const e = queue[i]!
    // a re-record has completed since this was retired, so the encode holding the old handles is gone
    if (e.armedAt < 0 && serial > e.serial) e.armedAt = tick
    // ...and the submit that used them has had frames to retire
    if (e.armedAt >= 0 && tick - e.armedAt >= SETTLE_TICKS) {
      if (e.from) {
        const g = globalThis as { __oipRetireReleased?: { t: number; from: string }[] }
        ;(g.__oipRetireReleased ??= []).push({ t: performance.now(), from: e.from })
      }
      e.release()
      releasedAny = true
      retainedBytes -= e.bytes
      continue
    }
    if (e.armedAt >= 0) armedAny = true
    queue[write++] = e
  }
  queue.length = write
  // Invalidate after the free, not only before it. Arming proves a re-record completed, not that the
  // resource left the live encode: three re-records each (bundleGroup, camera, renderContext) lazily,
  // so the armed record may still hold it. Freed under that, the poisoned encode replays forever once
  // the gesture ends and notifies stop, leaving a permanently black viewport (dragging a snapped spur
  // along its host). Re-recording after the release is always safe:
  // the resource is off the scene, so the forced encode can't contain it. It fires only on drains
  // that freed something (3 over a 24-step drag, vs ~1 per pointer-move for a drag ejection).
  if (releasedAny) notifyBundleStructureChanged()
  // Pressure valve. Retiring faster than records complete means nothing is invalidating (the drag
  // case). Force the re-record instead of freeing under a live recording: the queue arms once that
  // record completes and drains a couple of frames later. Fires only while the queue is stuck
  // (nothing armed) and at most once per completed record, so a long drag doesn't re-record
  // every frame, which is what the drag ejection exists to avoid.
  if ((retainedBytes > PRESSURE_BYTES || queue.length > PRESSURE_COUNT) && !armedAny && pressureSerial !== serial) {
    pressureSerial = serial
    notifyBundleStructureChanged()
  }
}

/** retained-queue stats, for the e2e/dev probes (never a correctness signal - see the gate) */
export function retiredGeometryStats(): { pending: number; bytes: number } {
  return { pending: queue.length, bytes: retainedBytes }
}

/** test seam: drop the queue (disposing everything) so specs don't leak state between cases */
export function flushRetiredGeometryForTest(): void {
  for (const e of queue) e.release()
  queue.length = 0
  retainedBytes = 0
  tick = 0
  pressureSerial = -1
}
