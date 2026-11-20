import {
  Box3,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three'
import type { Intersection, Material, Raycaster } from 'three'
import type { BoxFrame } from '../../core/frame'
import { CARGO_KIND_PALLET, CARGO_KIND_PART, CARGO_KIND_TOTE } from '../../core/frame'
import type { CargoKindName, CargoShapeRef } from '../../core/frame'
import { MAX_BOXES, PALLET_SIZE } from '../../core/types'
import type { BoxPick } from '../api'
import { retireGeometry, retireInstancedMeshOnly } from '../gpuRetire'
import { bucketCapacity } from '../parts/instanceCapacity'
import { createPalletGeometry, createPalletMaterial } from '../parts/pallet'
import { createCargoBoxGeometry, createCargoBoxMaterial } from '../parts/cargoBox'
import { createToteGeometry, createToteMaterial } from '../parts/tote'
import type { PartCargoMesh } from '../parts/partCargoMesh'
import { visualStructureEpoch } from '../parts/structureRev'
import { batchHasSelection, ensureSelChannel, markBatchSelection, selChannel, writeTierSpan } from './selTierChannel'
import { CargoDressing } from './cargoDressing'

// The part-bodied cargo batch builder (parts/partCargoMesh.ts) and the geometry merge it uses load on the first body
// of a cargo part with its own shape: a scene with none, the demo's first frame included, never loads them
// (scripts/lib/eager-js.mjs). Its rows draw nothing until it arrives, then the last frame is applied again.
let partCargo: typeof import('../parts/partCargoMesh') | null = null
let partCargoLoad: Promise<typeof import('../parts/partCargoMesh')> | null = null

const tmpMat = new Matrix4()
const tmpPos = new Vector3()
const tmpQuat = new Quaternion()
const tmpScale = new Vector3()
const tmpEuler = new Euler()
// authored per-body tint (frame.colors, sRGB); white for spawner boxes leaves the textured albedo as-is
const tmpColor = new Color()

interface BoxMeta {
  id: number
  partId: string | null
  /** what the body is (frame.shapes), for the pick's product */
  key: string | null
}

/** one instance's geometry-local bounds → world AABB under `mat`; false if the geometry has none */
function instanceBox(geometry: BufferGeometry, mat: Matrix4, out: Box3): boolean {
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const bb = geometry.boundingBox
  if (!bb) return false
  out.copy(bb).applyMatrix4(mat)
  return true
}

/**
 * One instanced batch: every box, every pallet of one footprint, or every tote of one size. A pallet's geometry is
 * built at its own footprint (its blocks and boards keep their sizes, so a scaled one would not match its collider),
 * and a tote's at its own size (its walls and rim keep theirs), so each size in use is its own batch and its own draw;
 * duplicating a pallet or a tote of a size already on screen adds no draw. A cargo part with its own body draws as its
 * own visual (parts/partCargoMesh.ts): one batch per material of each shape, every row written to each of them.
 */
interface CargoBatch {
  kind: CargoKindName
  /** the body's colour tints it; false for a part material the colour does not reach, which draws in its own */
  tinted: boolean
  /** a part-bodied batch's shape: what a pick of it reports, so the editor knows the product (liveCargo.ts) */
  ref?: CargoShapeRef
  geometry: BufferGeometry
  material: Material
  /** null for the box batch (a unit cube scaled per body); a pallet or tote batch's [length, height, width] */
  size: readonly [number, number, number] | null
  mesh: InstancedMesh
  /** per-instance identity, parallel to the mesh's packed instances, for picking + highlight */
  meta: BoxMeta[]
  /** last raw tint written per slot (see SimBoxes.apply) */
  colorSrc: Float32Array
  // per-apply scratch
  count: number
  selDirty: boolean
  colorDirty: boolean
  selected: boolean
}

export class SimBoxes {
  /** the stable scene mount - capacity growth mints fresh InstancedMeshes under this group
   *  (three's WebGPU backend keys the pipeline on the mesh uuid and captures instanceMatrix
   *  by reference, so buffers can't grow in place - same coupling as instanceBank.growBank),
   *  while the view's scene.add / staged-reveal hide / owned matrix walk all hold the group. */
  readonly group = new Group()
  /** dressings on loads (film, labels, straps), placed off the same frame rows as the cargo they ride. Its group is
   *  mounted in the scene beside this one (see CargoDressing for why), so the view adds and defers `dressing.group` */
  readonly dressing = new CargoDressing()
  private readonly box: CargoBatch
  /** one batch per pallet footprint in use, in the order they first appeared (the default size first) */
  private readonly pallets: CargoBatch[] = []
  /** every pallet batch draws one wood material (one texture set at every size, palletMesh.ts) */
  private readonly palletMaterial: Material
  /** one batch per tote size in use, made on first sight: a scene without totes has no tote batch and no tote draw */
  private readonly totes: CargoBatch[] = []
  /** every tote batch draws one plastic material, made with the first tote batch */
  private toteMaterial: Material | null = null
  /** each cargo shape a part with its own body uses: its built visual and one batch per material, made on first sight.
   *  `stalePackage`: its package changed since the visual was applied (refreshPackage), so the next row that draws it
   *  applies the visual again */
  private readonly partShapes = new Map<string, { built: PartCargoMesh; batches: CargoBatch[]; packageId: string; stalePackage: boolean }>()
  /** the batch builder is loading and this instance will apply its last frame again when it arrives (once) */
  private awaitingPartCargo = false
  /** the visual structure epoch at the last check for a model landed in a kept shape (refreshLoadedShapes) */
  private shapesEpoch = -1
  // shared instance capacity of every batch; grows in power-of-two buckets past MAX_BOXES the
  // first time a frame carries more cargo, so there is no render cap. The sim does not cap cargo
  // either, so any count simulates and renders.
  // Bucketed, so the batch declares the same WGSL instance-array size as every other bank: a raw
  // MAX_BOXES floor would be the scene's lone `array<mat4x4<f32>, 200>` and need its own shader pair
  // (instanceCapacity.ts).
  private capacity = bucketCapacity(MAX_BOXES)
  // Selection tiers for the outline's aSel channel (partId → 1 regular / 2 active), mirroring
  // instancePool.setSelectionTiers: selected cargo stays in the instanced batch and the outline
  // mask renders the batch once, discarding aSel==0 instances. apply() packs aSel from this map
  // as rows stream; setSelectionTiers rewrites the live rows in place for idle scenes.
  private tiers: ReadonlyMap<string, number> = new Map()
  // the frame whose rows the batches hold (see apply)
  private appliedFrame: BoxFrame | null = null

  constructor() {
    // tags the group for the consolidated outline's pool-tier mask render: its InstancedMesh
    // children carry the pool-style aSel selection channel (see tiers above), so the mask
    // renders them alongside the instance-pool output group with the same discard material
    this.group.userData.selChannelGroup = true
    // built in code, so they are final from the first frame (cargoBox.ts, pallet.ts): nothing swaps
    // geometry under a live render bundle, or wipes the selection channel, once the batch is drawing
    this.box = this.newBatch('box', createCargoBoxGeometry(), createCargoBoxMaterial(), null)
    this.palletMaterial = createPalletMaterial()
    this.palletBatch(PALLET_SIZE[0] / 2, PALLET_SIZE[2] / 2)
  }

  /** @internal test hook: the box batch's mesh */
  get mesh(): InstancedMesh {
    return this.box.mesh
  }
  /** @internal test hook: the box batch's rows */
  get boxMeta(): readonly BoxMeta[] {
    return this.box.meta
  }
  /** @internal test hook: the default-size pallet batch's mesh */
  get palletMesh(): InstancedMesh {
    return this.pallets[0]!.mesh
  }
  /** @internal test hook: the default-size pallet batch's rows */
  get palletMeta(): readonly BoxMeta[] {
    return this.pallets[0]!.meta
  }

  private newBatch(kind: CargoKindName, geometry: BufferGeometry, material: Material, size: readonly [number, number, number] | null, tinted = true, ref?: CargoShapeRef): CargoBatch {
    return {
      kind,
      tinted,
      ...(ref ? { ref } : {}),
      geometry,
      material,
      size,
      mesh: this.mintMesh(geometry, material),
      meta: [],
      colorSrc: new Float32Array(this.capacity * 3).fill(NaN),
      count: 0,
      selDirty: false,
      colorDirty: false,
      selected: false,
    }
  }

  /** the batch for pallets of footprint 2hx x 2hz, made on first sight. Compared as numbers, within half a
   *  millimetre: this runs per pallet per frame, and a string key per row would be garbage at 60 Hz. */
  private palletBatch(hx: number, hz: number): CargoBatch {
    for (const b of this.pallets) {
      if (Math.abs(b.size![0] / 2 - hx) < 0.0005 && Math.abs(b.size![2] / 2 - hz) < 0.0005) return b
    }
    const size = [hx * 2, PALLET_SIZE[1], hz * 2] as const
    const b = this.newBatch('pallet', createPalletGeometry(size[0], size[2]), this.palletMaterial, size)
    this.pallets.push(b)
    return b
  }

  /** the batch for totes of size 2hx x 2hy x 2hz, made on first sight; compared as numbers, as palletBatch does */
  private toteBatch(hx: number, hy: number, hz: number): CargoBatch {
    for (const b of this.totes) {
      if (Math.abs(b.size![0] / 2 - hx) < 0.0005 && Math.abs(b.size![1] / 2 - hy) < 0.0005 && Math.abs(b.size![2] / 2 - hz) < 0.0005) return b
    }
    const size = [hx * 2, hy * 2, hz * 2] as const
    const b = this.newBatch('tote', createToteGeometry(size[0], size[1], size[2]), (this.toteMaterial ??= createToteMaterial()), size)
    this.totes.push(b)
    return b
  }

  /**
   * The batches of row `i`'s own shape (frame.shapes, core/cargoBody.ts), built on first sight at the body's size, and
   * rebuilt when a model it draws has loaded since or its package has changed. Null when the frame names no shape for
   * the row, its part is not registered, or its visual draws nothing yet: the row then draws as a box of its size.
   */
  private partBatches(frame: BoxFrame, i: number, hx: number, hy: number, hz: number): CargoBatch[] | null {
    const key = frame.shapes?.[i]
    const ref = key ? frame.shapeRefs?.[key] : undefined
    if (!key || !ref) return null
    if (!partCargo) {
      // the builder is on its way: draw nothing for the row now, and this frame again once it is here
      partCargoLoad ??= import('../parts/partCargoMesh')
      if (this.awaitingPartCargo) return []
      this.awaitingPartCargo = true
      void partCargoLoad.then((m) => {
        partCargo = m
        this.awaitingPartCargo = false
        const last = this.appliedFrame
        if (last === null) return
        this.appliedFrame = null
        this.apply(last)
      }).catch((e: unknown) => console.warn('[oip] the cargo part mesh builder failed to load', e))
      return []
    }
    const size = [hx * 2, hy * 2, hz * 2] as const
    let shape = this.partShapes.get(key)
    if (shape?.stalePackage) {
      // its package changed: the kept visuals take it, and the pieces are rebuilt from them below
      partCargo.refreshPartCargoVisuals(shape.built, ref)
      shape.stalePackage = false
    }
    if (shape && partCargo.partCargoMeshStale(shape.built)) {
      // a model has landed in the kept visuals, or they were applied again: the pieces are rebuilt, the visuals stay
      this.retirePartBatches(shape)
      const built = partCargo.rebuildPartCargoMesh(shape.built)
      shape = { built, batches: built.pieces.map((p) => this.newBatch('part', p.geometry, p.material, size, p.tinted, ref)), packageId: ref.packageId, stalePackage: false }
      this.partShapes.set(key, shape)
    }
    if (!shape) {
      const built = partCargo.buildPartCargoMesh(ref)
      if (!built) return null
      // Kept even with no pieces: a part drawn only by a GLB has none until the model lands in these visuals.
      shape = { built, batches: built.pieces.map((p) => this.newBatch('part', p.geometry, p.material, size, p.tinted, ref)), packageId: ref.packageId, stalePackage: false }
      this.partShapes.set(key, shape)
    }
    // nothing drawn yet: a box of its size until the model lands and the shape rebuilds
    return shape.batches.length > 0 ? shape.batches : null
  }

  /**
   * Apply the last frame again when a model has loaded into a kept shape's visuals since it was applied, so the shape
   * rebuilds and draws the model. A running sim applies a new frame every tick and needs none of this, but a stopped
   * scene keeps applying the same frame (apply returns early on it) and a paused run sends none. The frame loop calls
   * this: one compare until some visual's structure moves.
   */
  refreshLoadedShapes(): void {
    const epoch = visualStructureEpoch()
    if (epoch === this.shapesEpoch) return
    this.shapesEpoch = epoch
    const last = this.appliedFrame
    if (!last || !partCargo) return
    // only a shape a row of this frame draws: no row rebuilds any other, so it would stay stale and re-apply the
    // whole frame on every later epoch bump (each rebuild of a drag)
    let drawn: Set<string | null> | null = null
    for (const [key, shape] of this.partShapes) {
      if (!shape.stalePackage && !partCargo.partCargoMeshStale(shape.built)) continue
      drawn ??= new Set(last.shapes)
      if (!drawn.has(key)) continue
      this.appliedFrame = null
      this.apply(last)
      return
    }
  }

  /**
   * A package changed in the registry (a Part Editor edit, a hot reload). Its cargo shapes draw from visuals kept
   * here, which no scene sync reaches, and an edit that keeps the colliders keeps each shape's key: without this the
   * bodies went on drawing the part as it was. Each shape is applied again by the next frame that draws it, with the
   * params that frame names. The frame loop's check (refreshLoadedShapes) covers a scene that sends no new frame.
   * True when a kept shape is of that package.
   */
  refreshPackage(packageId: string): boolean {
    let any = false
    for (const shape of this.partShapes.values()) {
      if (shape.packageId !== packageId) continue
      shape.stalePackage = true
      any = true
    }
    if (any) this.shapesEpoch = -1
    return any
  }

  /** retire a shape's batches (they have been drawing), keeping its visuals */
  private retirePartBatches(shape: { batches: CargoBatch[] }): void {
    for (const b of shape.batches) {
      this.group.remove(b.mesh)
      retireInstancedMeshOnly(b.mesh)
      retireGeometry(b.geometry)
      b.material.dispose()
    }
  }

  /** the tinted batch of the shape `b` draws a material of, if it has one */
  private tintedSibling(b: CargoBatch): CargoBatch | undefined {
    for (const s of this.partShapes.values()) if (s.batches.includes(b)) return s.batches.find((x) => x.tinted)
    return undefined
  }

  private batches(): CargoBatch[] {
    const out = [this.box, ...this.pallets, ...this.totes]
    for (const s of this.partShapes.values()) out.push(...s.batches)
    return out
  }

  /** the batch a raycast hit landed on, or undefined when the hit is not on one */
  private batchOf(object: unknown): CargoBatch | undefined {
    if (object === this.box.mesh) return this.box
    return this.batches().find((b) => b.mesh === object)
  }

  /** (re)allocate the shared selection-tier channel on a batch geometry at the current capacity
   *  (selTierChannel.ts - 0 discard / 1 regular / 2 active; the main-pass materials never reference
   *  it). Called at mint, which covers capacity growth: the geometry survives a re-mint, so the
   *  channel has to be re-asserted there. */
  private ensureSelAttr(geometry: BufferGeometry): void {
    ensureSelChannel(geometry, this.capacity)
  }

  /** build one batch mesh at the current capacity and mount it under the stable group.
   *  three 0.185.1 sizes the instance-matrix uniform to buffer capacity, so a batch first compiled while
   *  empty (a spawner-only scene) still renders later-spawned bodies, with no capacity "warm" needed.
   *  But the per-instance colour path is compiled into the node graph only if instanceColor exists
   *  at first compile (three gates the colour node on it); a batch compiled empty would otherwise bake
   *  without tint support and draw every later body untinted. Pre-allocate instanceColor at capacity (white)
   *  so the tint path is always present; apply() overwrites the live slots per frame. */
  private mintMesh(geometry: BufferGeometry, material: Material): InstancedMesh {
    this.ensureSelAttr(geometry)
    const mesh = new InstancedMesh(geometry, material, this.capacity)
    mesh.count = 0
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3)
    mesh.instanceColor.setUsage(DynamicDrawUsage)
    this.group.add(mesh)
    return mesh
  }

  /** grow every batch mesh to hold `n` bodies - a re-mint (same policy as instanceBank.growBank:
   *  never shrink, power-of-two buckets at ≥2× headroom, so growth is O(log N) mints over a scene's
   *  life). Called at the top of apply(), which rewrites every slot right after, so the fresh empty
   *  buffers never reach the screen. The one-time WebGPU pipeline compile on a mint happens at the
   *  scene edit that crossed the bucket, not per frame. */
  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return
    this.capacity = Math.max(bucketCapacity(n), this.capacity * 2)
    for (const b of this.batches()) {
      this.group.remove(b.mesh)
      // instance buffers only - geometry/materials are shared and live on. Retired rather than
      // disposed: the per-instance matrix/colour buffers are baked into a recording exactly like
      // vertex data, and a capacity grow happens with the batch on screen.
      retireInstancedMeshOnly(b.mesh)
      b.mesh = this.mintMesh(b.geometry, b.material)
      // fresh instanceColor buffers are all-white; the old cache would vouch for them
      b.colorSrc = new Float32Array(this.capacity * 3).fill(NaN)
    }
  }

  /** write one body into the next slot of batch `b`: its matrix (tmpPos / tmpQuat, set by the caller), tint, row and
   *  selection tier */
  private writeRow(b: CargoBatch, frame: BoxFrame, pi: number, id: number, partId: string | null, hx: number, hy: number, hz: number, anyTiers: boolean): void {
    // a pallet or tote batch's geometry is built at its size, so its scale is ~1; a box is the unit cube scaled
    if (b.size) tmpScale.set(hx / (b.size[0] / 2), hy / (b.size[1] / 2), hz / (b.size[2] / 2))
    else tmpScale.set(hx * 2, hy * 2, hz * 2)
    tmpMat.compose(tmpPos, tmpQuat, tmpScale)
    const slot = b.count++
    b.mesh.setMatrixAt(slot, tmpMat)
    // Last raw (pre-transform) rgb written into each batch slot, so a body whose tint did not change
    // skips setColorAt and its sRGB→linear transform. That transform is 3 Math.pow per body and
    // measured 64% of the whole per-body loop (e2e/probes/cargo-apply-breakdown.mjs: 0.0179 of
    // 0.028 ms/call at 84 bodies), while the tint is static for almost every body every
    // frame. Compared per slot, not per body id: the converted value already sitting in instanceColor
    // is correct exactly when the slot's source rgb is unchanged, however the rows repacked.
    // a part material the colour does not reach keeps its own (white leaves it as authored)
    const cr = b.tinted ? frame.colors[pi]! : 1
    const cg = b.tinted ? frame.colors[pi + 1]! : 1
    const cb = b.tinted ? frame.colors[pi + 2]! : 1
    const co = slot * 3
    const src = b.colorSrc
    if (src[co] !== cr || src[co + 1] !== cg || src[co + 2] !== cb) {
      src[co] = cr; src[co + 1] = cg; src[co + 2] = cb
      tmpColor.setRGB(cr, cg, cb, SRGBColorSpace)
      b.mesh.setColorAt(slot, tmpColor)
      b.colorDirty = true
    }
    // reuse the slot's record when it still describes this body - the steady state, since rows
    // keep their order frame to frame; a fresh object per body per frame costs 17% of the loop
    const key = frame.shapes?.[pi / 3] ?? null
    const m = b.meta[slot]
    if (m === undefined || m.id !== id || m.partId !== partId || m.key !== key) b.meta[slot] = { id, partId, key }
    // whether any row's tier is non-zero is the outline mask's draw gate (selTierChannel.ts),
    // so it is computed in this loop rather than in a second sweep
    const tier = anyTiers && partId !== null ? (this.tiers.get(partId) ?? 0) : 0
    if (tier > 0) b.selected = true
    const sel = selChannel(b.geometry)!.array as Float32Array
    if (sel[slot] !== tier) { sel[slot] = tier; b.selDirty = true }
  }

  apply(frame: BoxFrame): void {
    // the idle authored frame is memoized (core/frame.ts memoizeAuthoredCargoFrame), so every scene change that
    // touches no cargo hands back the same frame. Its rows are already here; repacking them would be O(cargo) per edit.
    // Selection tiers write their own rows (setSelectionTiers); clear() forgets the frame.
    if (frame === this.appliedFrame) return
    this.appliedFrame = frame
    this.ensureCapacity(frame.count)
    const n = frame.count
    for (const b of this.batches()) {
      b.count = 0
      b.selDirty = false
      b.colorDirty = false
      b.selected = false
    }
    // Tier rows are packed alongside the matrices (rows repack every apply); upload only on change.
    // Written inline below rather than through writeTierSpan: this is the 60 Hz per-body path, and
    // a call per one-row span would add back the per-body cost saved elsewhere.
    // Nothing selected is by far the common case: skip the per-body Map lookup entirely
    // (every row's tier is 0 then, which is also what the miss path would produce).
    const anyTiers = this.tiers.size > 0
    for (let i = 0; i < n; i++) {
      const pi = i * 3
      const qi = i * 4
      const id = frame.ids[i]!
      const partId = frame.partIds[i] ?? null
      const hx = frame.halfExtents[pi]!
      const hy = frame.halfExtents[pi + 1]!
      const hz = frame.halfExtents[pi + 2]!
      // a new footprint or shape mints its batch here, so it is in batches() before the upload pass below
      const kind = frame.kinds[i]
      const own = kind === CARGO_KIND_PART ? this.partBatches(frame, i, hx, hy, hz) : null
      tmpPos.set(frame.positions[pi]!, frame.positions[pi + 1]!, frame.positions[pi + 2]!)
      tmpQuat.set(frame.quats[qi]!, frame.quats[qi + 1]!, frame.quats[qi + 2]!, frame.quats[qi + 3]!)
      if (own) {
        for (const b of own) this.writeRow(b, frame, pi, id, partId, hx, hy, hz, anyTiers)
      } else {
        const b = kind === CARGO_KIND_PALLET ? this.palletBatch(hx, hz) : kind === CARGO_KIND_TOTE ? this.toteBatch(hx, hy, hz) : this.box
        this.writeRow(b, frame, pi, id, partId, hx, hy, hz, anyTiers)
      }
    }
    for (const b of this.batches()) {
      b.mesh.count = b.count
      b.meta.length = b.count
      b.mesh.instanceMatrix.needsUpdate = true
      // tints upload only when a slot's source rgb moved (static for cargo at steady state)
      if (b.colorDirty && b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true
      if (b.selDirty) selChannel(b.geometry)!.needsUpdate = true
      // rows repack every frame, so the gate is re-derived every frame with them
      markBatchSelection(b.mesh, b.selected)
      // instances moved/spawned: drop the cached batch bounding spheres so the next pick()
      // recomputes from current instances, once per applied frame, not once per pick (the
      // pilot crosshair picks every rendered frame)
      b.mesh.boundingSphere = null
    }
    this.dressing.apply(frame)
  }

  /**
   * Selection tiers for the outline's aSel channel (partId → 1 regular / 2 active;
   * absent = unselected), the SimBoxes twin of instancePool.setSelectionTiers. Non-cargo ids in
   * the map are ignored (they never match a row's partId). Rewrites the live rows in place -
   * idle scenes get no apply() on a selection change - and is what apply() packs from while
   * frames stream. A float write per body, uploaded only when a row actually changed.
   */
  setSelectionTiers(tiers: ReadonlyMap<string, number>): void {
    this.tiers = tiers
    for (const b of this.batches()) this.applyTierRows(b.mesh, b.meta)
  }

  /**
   * Dev/E2E merge-coherence invariant (view.auditMergeCoherence). Every live row's aSel value must
   * equal the tier its owning part currently holds. A mismatch means the outline would draw the
   * wrong cargo - a selected box with no silhouette, or a deselected one still outlined - because
   * a row repack (apply) or a tier write (setSelectionTiers) did not reach the buffer. This is the
   * cargo-side twin of instancePool's coherence audit; selected cargo never leaves the batch, so
   * these rows are what the outline draws for the selection.
   */
  auditSelectionRows(): { ok: boolean; reason: string } {
    for (const { mesh, meta } of this.batches()) {
      const attr = selChannel(mesh.geometry)
      if (!attr) continue
      const arr = attr.array as Float32Array
      let selected = false
      for (let i = 0; i < meta.length; i++) {
        const partId = meta[i]!.partId
        const want = partId !== null ? (this.tiers.get(partId) ?? 0) : 0
        if (want > 0) selected = true
        if (arr[i] !== want) {
          return { ok: false, reason: `cargo aSel row ${i} (part ${partId ?? 'none'}) is ${arr[i]}, expected tier ${want}` }
        }
      }
      // ...and the mask's draw gate, which decides whether these rows are rendered at all
      // (selTierChannel.markBatchSelection): correct rows behind a false gate outline nothing.
      if (batchHasSelection(mesh) !== selected) {
        return { ok: false, reason: `cargo mask gate says ${batchHasSelection(mesh)} but its rows say ${selected}` }
      }
    }
    return { ok: true, reason: '' }
  }

  /** write one batch's tier rows from the current tiers (row i belongs to meta[i]'s part).
   *  One-row spans: unlike the pool's contiguous member ranges, a cargo batch's rows are packed
   *  per body, so each row is its own span. */
  private applyTierRows(mesh: InstancedMesh, meta: readonly BoxMeta[]): void {
    const attr = selChannel(mesh.geometry)
    if (!attr) {
      markBatchSelection(mesh, false)
      return
    }
    const arr = attr.array as Float32Array
    let dirty = false
    let selected = false
    for (let i = 0; i < meta.length; i++) {
      const partId = meta[i]!.partId
      const v = partId !== null ? (this.tiers.get(partId) ?? 0) : 0
      if (v > 0) selected = true
      if (writeTierSpan(arr, i, 1, v)) dirty = true
    }
    if (dirty) attr.needsUpdate = true
    // idle scenes get no apply(), so this is the other place the mask's draw gate is set
    markBatchSelection(mesh, selected)
  }

  /** nearest sim box/pallet under the ray, with its body id, owning part, and live pose/size */
  pick(raycaster: Raycaster): BoxPick | null {
    // InstancedMesh.raycast early-outs on a cached bounding sphere; apply()/clear() null it
    // whenever instances move/spawn, so three recomputes from current instances here at most
    // once per applied frame (nulling it per pick would make every pilot-crosshair pick recompute).
    // The group recurse covers every instanced mesh; InstancedMesh tests only live instances.
    // Selected cargo stays in the batch (aSel outline channel), so this one sweep sees everything.
    const hits = raycaster.intersectObjects([this.group], true)
    for (const hit of hits) {
      const inst = hit.instanceId
      if (inst === undefined) continue
      const b = this.batchOf(hit.object)
      const meta = b?.meta[inst]
      if (!b || !meta) continue
      return this.batchPick(b, meta, inst)
    }
    return null
  }

  /**
   * The part a hit from raycasting {@link group} belongs to: a row's owning part (a self-stacked unit load's pieces
   * carry the load's id), null for a transient spawner box, undefined when the hit is not on a batch row. Checks the
   * mesh, not just `instanceId`: the instance pool's merged meshes are instanced too, and their row numbers would
   * index these tables as some unrelated box.
   */
  partIdOfHit(hit: Intersection): string | null | undefined {
    const inst = hit.instanceId
    if (inst === undefined) return undefined
    return this.batchOf(hit.object)?.meta[inst]?.partId
  }

  /**
   * Every live box/pallet whose world centre satisfies `inRect` - the rubber-band twin of pick().
   * Band selection has to come through here while the sim runs: a cargo part's own transform is
   * its authored spawn pose (its visual is a stub), so projecting the scene parts would band the
   * boxes where they started, and spawner-born bodies own no part to project at all.
   */
  picksInRect(inRect: (x: number, y: number, z: number) => boolean): BoxPick[] {
    const out: BoxPick[] = []
    // a part-bodied body is a row in each of its shape's batches: list it once
    const seen = new Set<number>()
    for (const b of this.batches()) {
      for (let i = 0; i < b.meta.length; i++) {
        b.mesh.getMatrixAt(i, tmpMat)
        if (!inRect(tmpMat.elements[12]!, tmpMat.elements[13]!, tmpMat.elements[14]!)) continue
        if (b.ref) {
          if (seen.has(b.meta[i]!.id)) continue
          seen.add(b.meta[i]!.id)
        }
        out.push(this.batchPick(b, b.meta[i]!, i))
      }
    }
    return out
  }

  /** BoxPick for instance `inst` of a batch - pose from its matrix, tint from instanceColor */
  private batchPick(b: CargoBatch, meta: BoxMeta, inst: number): BoxPick {
    b.mesh.getMatrixAt(inst, tmpMat)
    tmpMat.decompose(tmpPos, tmpQuat, tmpScale)
    const rotationY = tmpEuler.setFromQuaternion(tmpQuat, 'YXZ').y
    const size: [number, number, number] = b.size
      ? [tmpScale.x * b.size[0], tmpScale.y * b.size[1], tmpScale.z * b.size[2]]
      : [tmpScale.x, tmpScale.y, tmpScale.z]
    // read the per-body tint back from the batch's instanceColor (stored sRGB-via-linear by setColorAt)
    // a part material the colour does not reach holds white; its shape's tinted batch has the body's colour in the same
    // slot (every row goes to each of a shape's batches in the same order)
    const tint = b.tinted ? b : (this.tintedSibling(b) ?? b)
    const color = `#${tint.mesh.getColorAt(inst, tmpColor).getHexString(SRGBColorSpace)}`
    const product = meta.key !== null ? this.appliedFrame?.shapeRefs?.[meta.key] : undefined
    return { frameId: meta.id, partId: meta.partId, position: [tmpPos.x, tmpPos.y, tmpPos.z], rotationY, size, color, kind: b.kind, ...(product ? { product } : {}) }
  }

  /** the batch holding the cargo body owned by `partId`, with that row's matrix loaded into tmpMat */
  private rowOf(partId: string): CargoBatch | null {
    for (const b of this.batches()) {
      for (let i = 0; i < b.meta.length; i++) {
        if (b.meta[i]!.partId === partId) {
          b.mesh.getMatrixAt(i, tmpMat)
          return b
        }
      }
    }
    return null
  }

  /**
   * Live world position of the cargo body owned by `partId`, written into `out`; false if no
   * such body is currently in the batch. Used by the camera's follow mode (double-F) to track a
   * box as it rides the line - a cargo part's own visual is a static stub, so its real pose only
   * exists here.
   */
  livePartPosition(partId: string, out: Vector3): boolean {
    if (!this.rowOf(partId)) return false
    out.setFromMatrixPosition(tmpMat)
    return true
  }

  /**
   * Live world AABB of the cargo body owned by `partId`, written into `out`; false if no such body
   * is currently in the batch. The camera's focus framing (F / double-F) reads it so a running box
   * is framed at its live pose, not at the authored spawn pose its (stub) visual still sits on - the
   * same batch-is-the-truth reason as livePartPosition above.
   */
  livePartBox(partId: string, out: Box3): boolean {
    const b = this.rowOf(partId)
    return b ? instanceBox(b.geometry, tmpMat, out) : false
  }

  clear(): void {
    this.appliedFrame = null
    for (const b of this.batches()) {
      b.mesh.count = 0
      b.meta.length = 0
      b.mesh.boundingSphere = null
      // no live rows left to outline (the tiers map is untouched - the next apply repacks from it)
      markBatchSelection(b.mesh, false)
    }
    this.dressing.clear()
  }

  dispose(): void {
    // retired, not disposed: the batches have been drawing in the bundled main pass (gpuRetire.ts)
    for (const b of this.batches()) {
      retireInstancedMeshOnly(b.mesh)
      retireGeometry(b.geometry)
    }
    this.box.material.dispose()
    this.palletMaterial.dispose()
    this.toteMaterial?.dispose()
    for (const shape of this.partShapes.values()) {
      for (const b of shape.batches) b.material.dispose()
      partCargo?.disposePartCargoVisuals(shape.built)
    }
    this.partShapes.clear()
    this.dressing.dispose()
  }
}
