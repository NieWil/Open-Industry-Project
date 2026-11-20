import { BufferGeometry, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, type Material, type Mesh, type Object3D, type Scene } from 'three'
import { bucketCapacity } from '../parts/instanceCapacity'
import { geometryContentKey, geometryVersion } from '../parts/geometryKey'
import { isWebGPURenderMode } from '../renderMode'
import { createBundleCapableGroup, markBundleDirtyPart, mountOpaqueBundleGroupBefore, notifyBundleStructureChanged, releaseBundleGroup } from '../bundleGroups'
import { retireGeometry, retireInstancedMeshOnly } from '../gpuRetire'
import { SEL_ATTR, batchHasSelection, markBatchSelection, writeTierSpan } from './selTierChannel'

/** builtSig sentinel set by writeThrough: never matches a real signature, so the next full rebuild
 *  re-bakes unconditionally. auditCoherence treats it at idle as a failed invariant (a drag ended
 *  without its guaranteed re-bake). */
const WRITE_THROUGH_POISON = '\0write-through'
// the same poison, left by a dirty-scoped edit (tryUpdateParts) rather than a drag: nothing is guaranteed to re-bake
// after it, so at idle the audit checks its rows against their sources instead of failing on the sentinel
const SCOPED_WRITE_POISON = '\0scoped-write'

/**
 * Scene-global InstancedMesh pooling (default-on; ?noinstancepool kills it).
 *
 * Every part builds its static hardware (legs, bolts, axle stubs, structural boxes) as per-part
 * InstancedMeshes, and three (WebGPU) keys a pipeline on the mesh uuid, so N identical banks cost N
 * pipelines and N draws. This manager merges identical hardware into one world-space pool per
 * (geometry-content, material, shadow) signature and hides the originals (tagged `userData.poolHidden`,
 * so the outline mask can tell them from author-hidden meshes). Only parts under a live drag are
 * excluded (see view.poolExempt):
 *   - Selection: a selected part stays pooled and outlines from inside the pool via the per-instance
 *     `aSel` channel.
 *   - A pure-move drag streams poses through writeThrough() (in-place row rewrites). Only structural
 *     drags (resize/scale/guard-opening, a mid-drag param change) eject at pointer-down.
 *   - Picking: Raycaster ignores `visible`, so hidden sources still hit; merged copies are noRaycast.
 *
 * Pool objects are persistent: a fresh `new InstancedMesh` is a cold pipeline (keyed on the uuid)
 * compiled on the draw path the frame after the click, throwing load-time pre-warming away. So each
 * signature keeps one long-lived mesh whose instance buffer + count are rewritten in place. An emptied
 * pool is parked (detached but kept, so drag end reuses it); pools are disposed only when their
 * geometry source leaves the scene or on dispose().
 *
 * The pool also ingests plain meshes tagged `userData.poolUnit` (rig.ts), one instance each, from
 * static rigs: unit-primitive link meshes (size in mesh.scale) and the leaves of GLB mesh links
 * (tagPoolLeaves). "Static" means nothing moves the link at runtime (no joint, aim, or `setSubPose`
 * name, core subPosedLinkNames): the merge bakes world matrices, so a pooled moving link would sit at
 * rest. rig.ts stamps `poolMobile` on every FK-moved link group and collectEligible prunes the subtree,
 * which covers a rig's instanced banks too. Late-arriving children re-pool once their attach burst
 * settles (viewPool.ts poolRebuildOnStructureSettled).
 *
 * Excluded (kept per-part): `userData.dynamicInstances` banks (per-frame instanceMatrix; unit-tested,
 * unused in production), `spinUniform` materials (rollers), transparent or transmissive materials
 * (three sorts those per object, so a merged copy would draw out of order; sortedBlend), meshes with `instanceColor`, anything
 * off the default layer (ghosts on OVERLAY_LAYER), and the subtree of a static-fold root
 * (`userData.staticFoldRoot`, staticFold.ts), which does its own batching. User-hidden parts and the exempt set
 * (view.poolExempt) are skipped wholesale.
 */

/**
 * Whether scene-global static-hardware pooling is active. On by default; `?noinstancepool` is the
 * kill-switch (mirrors `?nowebgpu` in createRenderer.ts) so a suspected pooling artifact can be
 * isolated on any surface without a rebuild. Node/headless (no `location`) ⇒ default-on.
 */
export function wantsInstancePool(): boolean {
  return typeof location === 'undefined' || !new URLSearchParams(location.search).has('noinstancepool')
}

/** one persistent pool: its InstancedMesh (stable uuid → warm pipeline), the instanceMatrix
 *  capacity currently allocated, and the source mesh we pinned geometry+material from. */
interface PoolEntry {
  mesh: InstancedMesh
  capacity: number
  head: Mesh
  attrs?: PoolAttrs
}

/**
 * Merged per-instance attributes, present only when the bank's template geometry carries
 * InstancedBufferAttributes (today: the belt fabric's `fabricUv`/`fabricScroll`, beltFabricBank.ts).
 * The pool mesh then draws a persistent wrapper geometry - cloned vertex data + index (dispose-safe
 * against a source part's removal) plus its own instanced buffers sized to the pool capacity - because
 * the head's geometry belongs to one part and holds only that part's instances. The wrapper is as
 * long-lived as the pool mesh, so the WebGPU pipeline keyed on it stays warm across selection
 * rebuilds. `members` records each source's slot range from the last bake so a per-frame attribute
 * change (the belt scroll) re-copies through syncInstancedAttrs without any rebuild.
 */
interface PoolAttrs {
  geometry: BufferGeometry
  names: readonly string[]
  // one record per source baked into the pool: its slot range (offset/count), the geometry,
  // material, and shadow flags pinned at bake time (tryUpdateParts compares live objects against
  // these to detect an in-place swap/flip), and the attr versions syncInstancedAttrs gates on
  members: { src: BufferGeometry; mesh: Mesh; mat: Material | undefined; identity: string; cast: boolean; receive: boolean; count: number; offset: number; versions: number[]; geoVersion: number; partId: string }[]
}

// Material userData keys that are engine bookkeeping, not render state. Empty in practice today -
// a census of the demo (e2e/probes/material-userdata-census.mjs) found only deckRepeat,
// deckMaps, spinUniform and ringFull on 478 materials, and the pool's own tags live on the mesh.
// Kept as insurance so copy-pasting one onto a material cannot poison a merge key.
const IDENTITY_BOOKKEEPING = new Set(['poolHidden', 'poolUnit', 'instancePool', 'dynamicInstances'])

/**
 * Hash one value for render identity. Scalars by value, three's small value types by their
 * canonical content, Textures by uuid. A plain object is treated as a bag of resources: only the
 * three value types inside it contribute (deckMaps' shared map/normalMap pair), never its raw
 * numbers. `spinUniform` is a per-frame animated `{ value }` bag, and hashing nested scalars would
 * re-sign every pool every frame. Anything else contributes its constructor name only, which is
 * stable across instances, so a value this cannot read never over-splits a pool.
 */
function identityValue(v: unknown, nested = false): string {
  if (v === null || v === undefined) return String(v)
  const t = typeof v
  if (t === 'number' || t === 'boolean' || t === 'string') return nested ? '' : String(v)
  if (t !== 'object') return t
  const o = v as Record<string, unknown> & { isTexture?: boolean; isColor?: boolean; uuid?: string; getHex?: () => number; x?: number; y?: number; z?: number; w?: number }
  if (o.isTexture) return `t${o.uuid ?? '-'}`
  if (o.isColor) return `c${o.getHex?.() ?? -1}`
  if (typeof o.x === 'number' && typeof o.y === 'number') return `v${o.x},${o.y},${o.z ?? ''},${o.w ?? ''}`
  if (Array.isArray(v)) return `[${v.map((e) => identityValue(e, true)).join(',')}]`
  if (nested) return (v as object).constructor?.name ?? 'object'
  const parts: string[] = []
  for (const k of Object.keys(o).sort()) {
    const inner = identityValue(o[k], true)
    if (inner) parts.push(`${k}=${inner}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * A material's per-part render state: everything a pooled source may mutate in place that material
 * identity cannot see. Merged instances all draw with grp[0].material, so any of this that differs
 * across a bank makes a member silently render as its head.
 *
 * A material's `userData` is its per-instance render identity and is hashed generically, so new state
 * needs no bespoke key. A missing bespoke key once drew 26 decks at one repeat with every gate green.
 * auditGrouping() backs this up by re-deriving identity without this key.
 *
 * Effectively O(1): userData carries 0-4 keys in practice (see the census above), and this runs per
 * eligible source on every sign. A value that mutates per frame must not live here, because it would
 * re-sign every pool every frame. Put it behind a poolable() opt-out instead, as the rollers do.
 */
function renderIdentityKey(mat: Material | undefined): string {
  if (!mat) return '-'
  const m = mat as Material & { color?: { getHex?: () => number }; emissive?: { getHex?: () => number }; emissiveIntensity?: number }
  let key = `${m.color?.getHex?.() ?? -1}/${m.emissive?.getHex?.() ?? -1}/${m.emissiveIntensity ?? -1}`
  const ud = mat.userData as Record<string, unknown> | undefined
  if (ud) {
    for (const k of Object.keys(ud).sort()) {
      if (IDENTITY_BOOKKEEPING.has(k)) continue
      key += `|${k}=${identityValue(ud[k])}`
    }
  }
  return key
}
/** pool copies never raycast: picking hits the hidden exact-geometry sources (Raycaster ignores
 *  `visible`), and a merged mesh's hit couldn't map back to a part anyway - same rule as staticFold */
const noRaycast = (): void => {}

/**
 * Render bundles: each pool mesh carries its own activity-mark id (`userData.poolMarkId`), the key
 * bundleReplayRefresh's dirty-list files the pool's recorded draws under, exactly like a part's id.
 * A pool is static hardware, so on a replay frame its draws need a refresh only when this class wrote
 * to it. Every write path below marks the pool it touched (`markPool`), and the view marks every
 * pool on an edit frame (markAllForBundleRefresh: a repaint mutates a pooled material in place,
 * which no buffer version shows). The ids are only ever compared, never parsed; the `#` keeps them
 * out of the part-id space.
 */
let poolMarkSeq = 0
function markPool(entry: PoolEntry): void {
  markBundleDirtyPart(entry.mesh.userData.poolMarkId as string)
}

/** names of the geometry's per-instance attributes (sorted for a stable order), if any. Groups are
 *  homogeneous by construction: geometryContentKey includes attribute names+itemSize, so every member
 *  of a merge group carries the same set. */
function instancedAttrNames(geo: BufferGeometry): string[] {
  const out: string[] = []
  for (const name of Object.keys(geo.attributes)) {
    if ((geo.attributes[name] as InstancedBufferAttribute).isInstancedBufferAttribute) out.push(name)
  }
  return out.sort()
}

/** build a pool wrapper geometry from a template: cloned vertex attributes + index, fresh per-instance
 *  buffers at `capacity` (contents are filled by the bake that follows every (re)allocation). */
function buildPoolWrapper(template: BufferGeometry, names: readonly string[], capacity: number): BufferGeometry {
  const geo = new BufferGeometry()
  for (const name of Object.keys(template.attributes)) {
    const attr = template.attributes[name]!
    if ((attr as InstancedBufferAttribute).isInstancedBufferAttribute) continue
    geo.setAttribute(name, attr.clone())
  }
  const idx = template.getIndex()
  if (idx) geo.setIndex(idx.clone())
  for (const name of names) {
    const itemSize = (template.attributes[name] as InstancedBufferAttribute | undefined)?.itemSize ?? 1
    geo.setAttribute(name, new InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize))
  }
  geo.computeBoundingSphere()
  return geo
}

/** copy one source bank's per-instance attribute rows into the wrapper at `offset`, returning the
 *  member record (with the source versions syncInstancedAttrs gates on). The pool-owned SEL_ATTR
 *  has no source counterpart and is filled by applyTiersToPool instead. */
function copyMemberAttrs(attrs: PoolAttrs, mesh: Mesh, count: number, offset: number, partId: string): PoolAttrs['members'][number] {
  const src = mesh.geometry
  const versions: number[] = []
  for (const name of attrs.names) {
    const dst = attrs.geometry.getAttribute(name) as InstancedBufferAttribute
    const s = src.getAttribute(name) as InstancedBufferAttribute | undefined
    if (s) (dst.array as Float32Array).set((s.array as Float32Array).subarray(0, count * dst.itemSize), offset * dst.itemSize)
    versions.push(s ? s.version : -1)
  }
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  return { src, mesh, mat, identity: renderIdentityKey(mat), cast: mesh.castShadow, receive: mesh.receiveShadow, count, offset, versions, geoVersion: geometryVersion(src), partId }
}

/** a source's contribution to a pool: an InstancedMesh brings `count` matrices, a plain
 *  tagged unit-primitive mesh (rig.ts `poolUnit`) brings one - its world matrix. */
function srcCount(m: Mesh): number {
  return (m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).count : 1
}

export class InstancePoolManager {
  // bundle-capable (bundleGroups.ts): the pool output is part of the main-pass
  // render bundle; rebuild()/dispose() notify so membership/count changes re-record it
  private readonly poolGroup = createBundleCapableGroup()
  private readonly pools = new Map<string, PoolEntry>()
  private readonly hiddenSources: Mesh[] = []
  private builtSig = ''

  constructor(
    private readonly scene: Scene,
    // the part containers to scan: view.partsGroup + view.livePartsGroup (a live part's never-
    // moving hardware - a sensor's poolUnit bracket, a device's bolt banks - still merges fine)
    private readonly partsGroups: readonly Group[],
  ) {
    this.poolGroup.matrixAutoUpdate = false
    this.poolGroup.userData.instancePoolGroup = true
    // ahead of the parts group, not appended after it: bundles execute in scene-child order at the
    // end of the pass, so merged hardware mounted after view.partsGroup paints over that group's
    // depthWrite-off translucent cues (see mountOpaqueBundleGroupBefore).
    mountOpaqueBundleGroupBefore(scene, this.poolGroup, partsGroups[0] ?? this.poolGroup)
  }

  /**
   * Steps 1+2 of {@link rebuild}, shared with {@link auditCoherence}: gather the eligible source
   * meshes (world matrices refreshed) and compute the bake signature over them. Sharing means the
   * auditor asserts exactly the invariant the rebuild's early-out relies on - a hand-copied
   * signature would drift and assert something else.
   */
  private gatherAndSign(exempt: ReadonlySet<string>): { eligible: Mesh[]; owners: Map<Mesh, string>; sig: string } {
    // 1. gather eligible source meshes (world matrices refreshed so the bake reads current poses).
    //    Walk each part's subtree with collectEligible rather than Object3D.traverse: traverse ignores
    //    visibility, but an author-`hidden` rig link (a collision-only wall, e.g. the platform railing's
    //    barrier) lives in a `visible = false` Group while its InstancedMesh is itself visible = true. The
    //    renderer skips the hidden Group, so pooling must too - otherwise the pool copy draws it (a grey
    //    fallback box where the slim railing should be). collectEligible prunes any hidden subtree.
    const eligible: Mesh[] = []
    const owners = new Map<Mesh, string>() // mesh → owning partId, for the aSel member ranges
    for (const group of this.partsGroups) {
      for (const root of group.children) {
        const id = root.userData.partId
        if (typeof id !== 'string' || !root.visible || exempt.has(id)) continue
        root.updateWorldMatrix(true, true)
        const start = eligible.length
        collectEligible(root, eligible)
        for (let i = start; i < eligible.length; i++) owners.set(eligible[i]!, id)
      }
    }

    // 2. signature: object id + instance count + instance-buffer version + material identity + a
    //    world-transform hash of each eligible source. Unchanged signature ⇒ identical pooled set, poses
    //    and buffers ⇒ skip the rebuild. The material id catches a source material swapped to another
    //    shared instance (a belt bed re-keyed to another fabric). An id cannot see in-place mutations,
    //    so the tint (colour/emissive, the `colorParam` repaint in rig.ts) is in the signature too.
    //    Any other in-place mutation (map swap, roughness) would draw stale, so swap or re-mint instead.
    //    The buffer version catches an in-place bank rewrite at constant count (writeInstanceMatrices;
    //    drag paths never rewrite source banks). The transform hash avalanche-mixes every matrix element
    //    into an FNV-1a chain. A weighted sum cancels across combined edits (yaw +θ/−θ aliased), and a
    //    plain XOR-multiply chain aliases a ±v two-slot swap ~1-in-3 (the yaw regression spec checks this).
    let sig = ''
    for (const m of eligible) {
      const e = m.matrixWorld.elements
      const mat = Array.isArray(m.material) ? m.material[0] : m.material
      const ver = (m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).instanceMatrix.version : 0
      let t = 2166136261 // scrambled FNV-1a, elements quantized to 1e-4 (0.1 mm / ~0.006°)
      for (let i = 0; i < 16; i++) {
        let v = Math.round(e[i]! * 1e4)
        v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d) // avalanche: decorrelates ±v before the chain
        t ^= v ^ (v >>> 13)
        t = Math.imul(t, 16777619)
      }
      // shadow flags are in the signature because they're part of the merge key (step 4): a flip at
      // constant pose/count/material must change the signature, or this early-out would skip the
      // rebuild that re-groups the mesh (tryUpdateParts refuses the flip for the same reason).
      const sh = (m.castShadow ? 'S' : 'n') + (m.receiveShadow ? 'R' : 'n')
      // ...and the geometry version: a function part rewrites its submesh buffers in place at constant
      // topology (rewriteMeshDescription), same object and same pose, and the merged copy cloned the old
      // vertices at bake time - only the version sees that the shape moved (geometryKey.geometryVersion)
      sig += `${m.id}:${srcCount(m)}:v${ver}:g${geometryVersion(m.geometry)}:${mat ? mat.uuid : '-'}:${renderIdentityKey(mat)}:${sh}:${t >>> 0};`
    }
    return { eligible, owners, sig }
  }

  /**
   * Dev/E2E merge-coherence invariant (the pool sibling of view.auditGpuTextures): recompute the
   * bake signature over the current eligible sources and compare against the one the last bake
   * recorded. At an idle point they must match. A mismatch means pooled source geometry changed
   * (a bank re-counted/rewritten, a material swapped, a pose moved) with no path scheduling a
   * re-bake, so the merged copies on screen are stale (e.g. a railing opening that shows only on
   * commit). The write-through poison sentinel also fails: at idle it means a drag ended without its
   * guaranteed rebuild. Don't call mid-drag, because write-through poisons the signature until the
   * release re-bakes. Pass the current exempt set (view.poolExempt()) so eligibility matches what the
   * last rebuild saw.
   */
  auditCoherence(exempt: ReadonlySet<string>): { ok: boolean; reason: string } {
    if (this.builtSig === WRITE_THROUGH_POISON) {
      return { ok: false, reason: 'signature still write-through-poisoned at idle - a drag ended without its re-bake' }
    }
    const gate = this.auditMaskGate()
    if (!gate.ok) return gate
    const grouping = this.auditGrouping()
    if (!grouping.ok) return grouping
    // a dirty-scoped edit rewrote rows in place, so there is no bake signature to compare: compare the rows themselves
    if (this.builtSig === SCOPED_WRITE_POISON) return this.auditRows()
    const { sig } = this.gatherAndSign(exempt)
    if (sig === this.builtSig) return { ok: true, reason: '' }
    return { ok: false, reason: 'stale merged copies: pooled sources changed since the last bake with no re-bake scheduled' }
  }

  /**
   * After a dirty-scoped edit: does every merged row still equal its source's world transform, with the geometry
   * version, material and count it was baked with? What tryUpdateParts validated before writing, re-checked against
   * the scene as it stands now.
   */
  private auditRows(): { ok: boolean; reason: string } {
    const im = new Matrix4()
    const world = new Matrix4()
    const row = new Matrix4()
    for (const entry of this.pools.values()) {
      if (entry.mesh.parent !== this.poolGroup || !entry.attrs) continue
      for (const mem of entry.attrs.members) {
        const src = mem.mesh
        const mat = Array.isArray(src.material) ? src.material[0] : src.material
        if (srcCount(src) !== mem.count || src.geometry !== mem.src || geometryVersion(src.geometry) !== mem.geoVersion || mat !== mem.mat) {
          return { ok: false, reason: `stale merged copies: part ${mem.partId}'s pooled source changed after a scoped row rewrite` }
        }
        src.updateWorldMatrix(true, false)
        const inst = (src as InstancedMesh).isInstancedMesh ? (src as InstancedMesh) : null
        for (let i = 0; i < mem.count; i++) {
          if (inst) {
            inst.getMatrixAt(i, im)
            world.multiplyMatrices(inst.matrixWorld, im)
          } else {
            world.copy(src.matrixWorld)
          }
          entry.mesh.getMatrixAt(mem.offset + i, row)
          for (let k = 0; k < 16; k++) {
            if (Math.abs(row.elements[k]! - world.elements[k]!) > 1e-5) {
              return { ok: false, reason: `stale merged copies: part ${mem.partId}'s pooled row differs from its source` }
            }
          }
        }
      }
    }
    return { ok: true, reason: '' }
  }

  /**
   * Do the members of each bank actually render identically to the head they draw as?
   *
   * The signature cannot check this: auditCoherence recomputes the same key the rebuild grouped by,
   * so an incomplete key agrees with itself (one bank once drew 26 decks at one repeat with every check
   * green). So this re-derives render identity by a route that shares nothing with the merge key:
   * materialDeepKey walks the material objects themselves.
   *
   * It has two callers with different contracts. Read this before touching MATERIAL_DEEP_SKIP.
   *
   * From the gates (auditCoherence, at idle) it is a diagnostic: a false positive fails loudly.
   *
   * From resignAfterRepaint it runs on the frame path and decides correctness: `ok` means "skip the
   * re-bake", so a false negative silently leaves a bank drawing as a head it no longer matches.
   *
   * So widening MATERIAL_DEEP_SKIP narrows what resignAfterRepaint can see. Before skipping a
   * property, establish it cannot carry render identity; prefer making it stable.
   */
  auditGrouping(): { ok: boolean; reason: string } {
    const deep = new Map<Material | undefined, string>()
    const keyOf = (mat: Material | undefined): string => {
      let k = deep.get(mat)
      if (k === undefined) {
        k = materialDeepKey(mat)
        deep.set(mat, k)
      }
      return k
    }
    for (const entry of this.pools.values()) {
      if (entry.mesh.parent !== this.poolGroup || entry.mesh.count === 0) continue // parked: draws nothing
      const headMat = Array.isArray(entry.head.material) ? entry.head.material[0] : entry.head.material
      const headKey = keyOf(headMat)
      for (const mem of entry.attrs?.members ?? []) {
        const memKey = keyOf(mem.mat)
        if (memKey === headKey) continue
        return { ok: false, reason: `merged sources that do not render identically: part ${mem.partId} draws as its pool head (${firstDifference(headKey, memKey)})` }
      }
    }
    return { ok: true, reason: '' }
  }

  /**
   * The outline mask's draw gate vs the rows it stands for (see selTierChannel.markBatchSelection).
   * The mask renders only pools the gate says hold a selected row, so a gate that says no over rows
   * that say yes leaves a selected part with no silhouette. That is how this optimization can go wrong,
   * and the pixels don't show it in any scene where something else is also selected.
   */
  private auditMaskGate(): { ok: boolean; reason: string } {
    for (const entry of this.pools.values()) {
      if (entry.mesh.parent !== this.poolGroup) continue // parked: never reaches the mask
      const attr = entry.attrs?.geometry.getAttribute(SEL_ATTR) as InstancedBufferAttribute | undefined
      const arr = attr?.array as Float32Array | undefined
      let rows = false
      if (arr) for (let i = 0; i < entry.mesh.count; i++) if (arr[i]! > 0) { rows = true; break }
      if (rows !== batchHasSelection(entry.mesh)) {
        return { ok: false, reason: `pool mask gate says ${batchHasSelection(entry.mesh)} but its aSel rows say ${rows}` }
      }
    }
    return { ok: true, reason: '' }
  }

  /**
   * An in-place repaint moved render identity; re-sign instead of re-baking, when that is valid.
   *
   * A colorParam re-tint mutates `material.color` on the object each bank draws with, so pixels are
   * right and only the recorded signature is stale. A re-bake mints banks and compiles pipelines after
   * the scene settles, the phone hitch `verify-webgpu-mobile-singlepass` forbids (it fails with a
   * re-bake here).
   *
   * So if `auditGrouping` still passes, re-signing is the whole fix; otherwise return false and let the
   * caller rebuild. A conservative miss loses a merge (extra draws), never draws a wrong pixel.
   */
  resignAfterRepaint(exempt: ReadonlySet<string>): boolean {
    if (this.builtSig === '' || this.builtSig === WRITE_THROUGH_POISON || this.builtSig === SCOPED_WRITE_POISON) return false
    if (!this.auditGrouping().ok) return false
    this.builtSig = this.gatherAndSign(exempt).sig
    // the repaint changed a pooled material's colour in place: no buffer moved, but every draw
    // using it must re-ship its material uniforms
    this.markAllForBundleRefresh()
    return true
  }

  /**
   * Mark every attached pool for the next bundle replay's refresh (see `markPool`). The view calls
   * this on each edit frame: an edit can mutate a pooled material in place (a `colorParam` repaint,
   * a deck's live repeat), which is baked into no buffer version the replay could notice.
   */
  markAllForBundleRefresh(): void {
    for (const entry of this.pools.values()) if (entry.mesh.parent === this.poolGroup) markPool(entry)
  }

  /**
   * Re-derive the pools for the current scene and exempt set (view.poolExempt). Cheap to call on every
   * syncScene: it first computes a light signature over the eligible (non-exempt, non-hidden) sources
   * and returns early when nothing that would be pooled has changed. When it does run, it mutates the
   * existing pool objects in place (see the class doc) rather than recreating them, so their pipelines
   * stay warm.
   */
  rebuild(exempt: ReadonlySet<string>): void {
    const { eligible, owners, sig } = this.gatherAndSign(exempt)
    if (sig === this.builtSig) return
    this.builtSig = sig

    // 3. restore visibility of every source the previous generation hid. This is a cheap boolean
    //    toggle; the pool objects are not torn down here. Any still-pooled source is hidden again
    //    in step 5. A source that is no longer pooled (its part became exempt, hidden,
    //    or removed) is left visible, so it renders live.
    for (const s of this.hiddenSources) {
      s.visible = true
      delete s.userData.poolHidden
    }
    this.hiddenSources.length = 0

    // 4. group eligible sources by structural signature. materialKey can walk a node material's
    //    graph (getCacheKey) - memoized per material object for this pass, since hundreds of
    //    meshes share a few dozen materials. Identity is a safe memo key here because pooled
    //    materials are swap-only (see the step-2 convention note); the memo dies with the pass,
    //    so even a mutated material can't serve a stale key beyond one rebuild.
    const groups = new Map<string, Mesh[]>()
    const matKeys = new Map<Material | undefined, string>()
    const mergeKey = (m: Mesh): string => {
      const mat = Array.isArray(m.material) ? m.material[0] : m.material
      let mk = matKeys.get(mat)
      if (mk === undefined) {
        mk = materialKey(mat)
        matKeys.set(mat, mk)
      }
      return `${geometryContentKey(m.geometry)}||${mk}||${m.castShadow ? 'S' : 'n'}${m.receiveShadow ? 'R' : 'n'}||L${m.layers.mask}`
    }
    for (const m of eligible) {
      const key = mergeKey(m)
      const arr = groups.get(key)
      if (arr) arr.push(m)
      else groups.set(key, [m])
    }

    // 5. for each ≥2-member group, get-or-create its persistent pool and re-bake it in place
    const im = new Matrix4()
    const world = new Matrix4()
    const wanted = new Set<string>()
    for (const [key, grp] of groups) {
      const head = grp[0]
      if (grp.length < 2 || !head) continue // a lone mesh has nothing to merge with - leave it live
      wanted.add(key)
      let total = 0
      for (const m of grp) total += srcCount(m)

      let entry = this.pools.get(key)
      if (!entry) {
        const cap = bucketCapacity(total) // headroom so a later conveyor-extend stays under capacity (no mint/recompile)
        // every pool draws a wrapper geometry: the source's instanced attributes (belt fabric)
        // plus the pool-owned SEL_ATTR selection channel the outline mask reads, so every pool
        // has a wrapper, not just attr-carrying banks
        const attrNames = [...instancedAttrNames(head.geometry), SEL_ATTR]
        const wrapper = buildPoolWrapper(head.geometry, attrNames, cap)
        const mesh = new InstancedMesh(wrapper, head.material, cap)
        mesh.castShadow = head.castShadow
        mesh.receiveShadow = head.receiveShadow
        mesh.frustumCulled = false
        mesh.matrixAutoUpdate = false
        mesh.raycast = noRaycast
        mesh.userData.instancePool = true
        mesh.userData.poolMarkId = `#pool:${++poolMarkSeq}`
        entry = { mesh, capacity: cap, head, attrs: { geometry: wrapper, names: attrNames, members: [] } }
        this.pools.set(key, entry)
      } else {
        // A structural edit can retire the source we pinned (its part removed/rebuilt) while the pool
        // is still wanted by surviving twins. Re-point to a current member: a structurally-identical
        // geometry/material swap keeps the same pipeline (three keys it on the mesh uuid + structural
        // geo/material cache keys, all unchanged), so the pool stays warm. An attr-carrying pool keeps
        // its own wrapper geometry - content-identical to any member by key, and dispose-safe.
        //
        // The head can also leave this group while staying in the scene: repaint one of three
        // identical racks and it moves to the new colour's key, but the pool it headed survives on
        // the other two, still drawing with the recoloured material, which would recolour the
        // twins too. So re-point on non-membership, not only on detachment.
        // Any member is safe to pin: sharing the key means identical geometry content, material
        // look, and shadow flags by construction.
        if (!this.attached(entry.head) || !grp.includes(entry.head)) {
          entry.head = head
          if (!entry.attrs) entry.mesh.geometry = head.geometry
          entry.mesh.material = head.material
          entry.mesh.castShadow = head.castShadow
          entry.mesh.receiveShadow = head.receiveShadow
        }
        this.ensureCapacity(entry, total)
      }

      const pool = entry.mesh
      const attrs = entry.attrs
      if (attrs) attrs.members.length = 0
      let k = 0
      for (const m of grp) {
        const start = k
        const inst = (m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh) : null
        if (inst) {
          for (let i = 0; i < inst.count; i++) {
            inst.getMatrixAt(i, im)
            world.multiplyMatrices(inst.matrixWorld, im) // local instance → world (part transform baked in)
            pool.setMatrixAt(k++, world)
          }
        } else {
          pool.setMatrixAt(k++, m.matrixWorld) // plain unit link: size (mesh.scale) rides in the world matrix
        }
        if (attrs) attrs.members.push(copyMemberAttrs(attrs, m, k - start, start, owners.get(m) ?? ''))
        m.visible = false
        // marks the mesh as hidden by the pool (vs. author-hidden): the consolidated outline's
        // mask pass un-hides exactly these for its own render, so a selected-but-still-pooled
        // part outlines without leaving the pool (deferred ejection - see view.poolExempt)
        m.userData.poolHidden = true
        this.hiddenSources.push(m)
      }
      pool.count = k
      pool.instanceMatrix.needsUpdate = true
      if (attrs) for (const name of attrs.names) (attrs.geometry.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
      this.applyTiersToPool(entry) // the bake rewrote/moved member rows; restore their selection tiers
      markPool(entry)
      pool.computeBoundingSphere()
      pool.visible = true
      if (pool.parent !== this.poolGroup) {
        this.poolGroup.add(pool)
        pool.updateWorldMatrix(true, false) // poolGroup is identity; bake the pool's (identity) world once
      }
    }

    // 6. park or drop pools not wanted this rebuild. Parking = detach from the render group (draws
    //    nothing) but keep the warm object in the map, so returning to the group (e.g. deselect) reuses
    //    it without a fresh compile. Only dispose a pool whose pinned geometry source has left the
    //    scene (structural removal / scene switch); otherwise it leaks and holds a dead geometry ref.
    //    A pool whose head is still in the scene but no longer keys to it is dropped as well. That
    //    is the repaint case (the head never wants its old colour's pool again), and parking those
    //    would grow the map by one dead pool + wrapper per colour a user scrubs through. If a
    //    different mesh keys to it later it re-mints: a cold compile on a deliberate edit, never on
    //    the frame path.
    for (const [key, entry] of this.pools) {
      if (wanted.has(key)) continue
      if (entry.mesh.parent === this.poolGroup) this.poolGroup.remove(entry.mesh)
      entry.mesh.count = 0
      markPool(entry) // a parked pool draws nothing and the notify below re-records without it; marked so every pool write marks
      if (!this.attached(entry.head) || mergeKey(entry.head) !== key) {
        // Retire, never dispose: this runs on a live rebuild, and the recorded bundle that drew
        // this pool last frame still holds its instance + vertex buffers by handle (gpuRetire.ts).
        // Mesh-only + the wrapper: the mesh's own geometry may be the shared source template, which
        // this pool doesn't own.
        retireInstancedMeshOnly(entry.mesh)
        retireGeometry(entry.attrs?.geometry)
        this.pools.delete(key)
      }
    }
    // render bundles: a real rebuild (the builtSig early-out is above) changed pool membership,
    // counts, and/or source visibility - all baked into a recorded bundle
    notifyBundleStructureChanged()
  }

  /**
   * Per-frame follower for dynamic per-instance attributes (today: the belt fabric scroll). Sources
   * stay authoritative - each part's tick writes its own bank's attribute - and this re-copies any
   * member whose attribute version moved since the last bake/sync into the pooled wrapper's buffer.
   * Version-gated per member, so an idle scene (nothing scrolling) does no copies and no uploads; a
   * running scene copies a few floats per belt. Call once per rendered frame, after part ticks.
   */
  syncInstancedAttrs(): void {
    for (const entry of this.pools.values()) {
      const attrs = entry.attrs
      if (!attrs || entry.mesh.parent !== this.poolGroup) continue
      for (let ni = 0; ni < attrs.names.length; ni++) {
        const name = attrs.names[ni]!
        const dst = attrs.geometry.getAttribute(name) as InstancedBufferAttribute
        let dirty = false
        for (const mem of attrs.members) {
          const src = mem.src.getAttribute(name) as InstancedBufferAttribute | undefined
          if (!src || src.version === mem.versions[ni]) continue
          ;(dst.array as Float32Array).set((src.array as Float32Array).subarray(0, mem.count * dst.itemSize), mem.offset * dst.itemSize)
          mem.versions[ni] = src.version
          dirty = true
        }
        if (dirty) {
          dst.needsUpdate = true
          markPool(entry)
        }
      }
    }
  }

  /**
   * Selection tiers for the outline mask: partId → 1 (regular) / 2 (active); absent = unselected.
   * The consolidated outline renders the pool meshes into its mask with a material that discards
   * aSel==0 instances - a selected part's pooled hardware outlines without leaving the pool, and
   * mask draw calls scale with #pools instead of #selected parts (the select-100 sustained cost).
   * Cheap: a float write per instance, uploaded only when a row actually changed.
   */
  setSelectionTiers(tiers: ReadonlyMap<string, number>): void {
    this.tiers = tiers
    for (const entry of this.pools.values()) {
      if (entry.mesh.parent === this.poolGroup) this.applyTiersToPool(entry)
    }
  }

  private tiers: ReadonlyMap<string, number> = new Map()

  /**
   * Write-through drag: re-bake only the given parts' instance rows from their sources' current
   * world matrices, in place: no membership change, no signature walk, no aSel loss. A pure-move
   * drag (gizmo/rotate/vertex-snap/reposition) streams pose transients through here every sync,
   * so the dragged parts stay pooled. The scene keeps its merged draws and the outline mask keeps
   * its aSel pool path for the whole drag. Ejecting the dragged set instead un-batches it, measured
   * at +16.8ms/frame for a 100-part group drag.
   *
   * The stored rebuild signature still hashes the poses of the last full bake, so it's poisoned
   * here. Otherwise a drag that ends where it started (right-click abort) would match the stale
   * signature and early-out with mid-drag rows still in the buffers. The re-bake this forces runs
   * in the release's syncScene, the same cost as ejecting.
   */
  writeThrough(ids: ReadonlySet<string>, poison: string = WRITE_THROUGH_POISON): void {
    const im = new Matrix4()
    const world = new Matrix4()
    let wrote = false
    for (const entry of this.pools.values()) {
      if (entry.mesh.parent !== this.poolGroup) continue
      const attrs = entry.attrs
      if (!attrs) continue
      let dirty = false
      for (const mem of attrs.members) {
        if (!ids.has(mem.partId)) continue
        const src = mem.mesh
        // stale member (a structural swap the caller's fallback should have ejected): skip; the
        // poisoned signature re-bakes everything at the next rebuild anyway
        if (srcCount(src) !== mem.count) continue
        src.updateWorldMatrix(true, false) // the drag just moved the root; pull ancestors current
        const inst = (src as InstancedMesh).isInstancedMesh ? (src as InstancedMesh) : null
        if (inst) {
          for (let i = 0; i < mem.count; i++) {
            inst.getMatrixAt(i, im)
            world.multiplyMatrices(inst.matrixWorld, im)
            entry.mesh.setMatrixAt(mem.offset + i, world)
          }
        } else {
          entry.mesh.setMatrixAt(mem.offset, src.matrixWorld)
        }
        dirty = true
      }
      if (dirty) {
        entry.mesh.instanceMatrix.needsUpdate = true
        markPool(entry)
        wrote = true
      }
    }
    // never matches a real signature → next rebuild re-bakes; a drag's poison is never downgraded to the scoped one
    if (wrote) this.builtSig = this.builtSig === WRITE_THROUGH_POISON ? WRITE_THROUGH_POISON : poison
  }

  /**
   * Scoped mid-drag ejection, for a write-through drag that promotes parts to the structural set (a
   * cut transition): a full rebuild measured 23 ms at 120 conveyors (e2e/probes/promotion-rebuild-cost.mjs),
   * a hitch right at snap engage. Instead, zero-scale the parts' rows in place (degenerate, so nothing
   * rasterizes in any pass; no compaction, so no offset or aSel range shifts), drop their member
   * records, and restore their sources to live rendering. The signature is poisoned, so the release's
   * syncScene re-bakes fully to the same end state; the holes stay allocated until then.
   *
   * Render bundles are not notified, yet the source visibility flips are baked into recorded bundles.
   * This is only bundle-safe because the promotion site re-homed the ejected parts to the live
   * (unbundled) group first (pool.bundleDragEjected + syncPartContainer). A new caller must keep that.
   */
  ejectParts(ids: ReadonlySet<string>): void {
    const zero = new Matrix4().makeScale(0, 0, 0)
    let any = false
    for (const entry of this.pools.values()) {
      if (entry.mesh.parent !== this.poolGroup) continue
      const attrs = entry.attrs
      if (!attrs) continue
      let dirty = false
      for (let i = attrs.members.length - 1; i >= 0; i--) {
        const mem = attrs.members[i]!
        if (!ids.has(mem.partId)) continue
        for (let r = 0; r < mem.count; r++) entry.mesh.setMatrixAt(mem.offset + r, zero)
        // restore the member's source to live rendering. The member list is the authority for
        // which sources the pool hides: rebuild hides and records them together, so every
        // poolHidden source is exactly one attached pool's member. So there is no hiddenSources
        // re-scan, and no re-deriving the owner from a userData.partId ancestor walk (that finds
        // the nearest tagged ancestor, which would diverge from the bake's root-level owners map
        // if parts nest). hiddenSources keeps its visible entries: the next full rebuild's restore
        // pass is idempotent and rebuilds the list from scratch, and the only other consumer
        // (compileStaged's warm) filters on visible === false.
        mem.mesh.visible = true
        delete mem.mesh.userData.poolHidden
        attrs.members.splice(i, 1)
        dirty = true
      }
      if (dirty) {
        entry.mesh.instanceMatrix.needsUpdate = true
        markPool(entry)
        any = true
      }
    }
    if (any) this.builtSig = WRITE_THROUGH_POISON // merged copies no longer match any real bake
  }

  /**
   * Dirty-scoped alternative to a full rebuild, when a sync knows which parts changed and nothing
   * membership-shaped happened (view.syncScene's per-entry diff): validate each dirty part's recorded
   * membership is still row-rewritable (same meshes, counts, geometry and material objects) and stream
   * its rows via writeThrough. Returns false (caller rebuilds) the moment anything structural moved. A
   * constant-structure edit then costs O(edited part) instead of a full walk + re-bake (~12 ms at 100
   * conveyors).
   *
   * One-directional: every recorded member must still be present and identical, but a mesh
   * the part gained may stay live (correct pixels, one extra draw) until the next rebuild, which
   * writeThrough's signature poison forces to re-bake. A part with no recorded members needs no work.
   */
  tryUpdateParts(ids: ReadonlySet<string>): boolean {
    if (this.builtSig === '') return false // never baked - nothing recorded to validate against
    // recorded membership per dirty part, from the attached pools' last bake
    const recorded = new Map<string, PoolAttrs['members']>()
    for (const entry of this.pools.values()) {
      if (entry.mesh.parent !== this.poolGroup || !entry.attrs) continue
      for (const mem of entry.attrs.members) {
        if (!ids.has(mem.partId)) continue
        const arr = recorded.get(mem.partId)
        if (arr) arr.push(mem)
        else recorded.set(mem.partId, [mem])
      }
    }
    const eligible: Mesh[] = []
    const present = new Set<Mesh>()
    const visited = new Set<string>()
    for (const group of this.partsGroups) {
      for (const root of group.children) {
        const id = root.userData.partId
        if (typeof id !== 'string' || !ids.has(id)) continue
        visited.add(id)
        const mems = recorded.get(id)
        if (!root.visible) {
          if (mems) return false // hidden with pooled rows - the rows must leave the pool
          continue
        }
        if (!mems) continue // un-pooled dirty part - renders live; nothing to rewrite
        root.updateWorldMatrix(true, true)
        eligible.length = 0
        collectEligible(root, eligible)
        present.clear()
        for (const m of eligible) present.add(m)
        for (const mem of mems) {
          const m = mem.mesh
          if (!present.has(m)) return false // member gone / ineligible → its rows are stale
          if (srcCount(m) !== mem.count) return false // re-counted bank → slot ranges shift
          if (m.geometry !== mem.src) return false // geometry swapped → content key may differ
          if (geometryVersion(m.geometry) !== mem.geoVersion) return false // rewritten in place → the copy's vertices are stale
          const mat = Array.isArray(m.material) ? m.material[0] : m.material
          if (mat !== mem.mat) return false // material swapped → render identity may differ
          // ...and repainted in place (a colorParam link's `mat.color.set`): identity is unchanged
          // but colour is part of the merge key, so these rows belong in a different pool - same
          // reason as the shadow flags below. Only a rebuild can move them.
          // ...or mutated in place at constant identity: a `colorParam` repaint (`mat.color.set`),
          // a deck resize (setExtent writes the live repeat Vector2). Both are part of the merge
          // key, so those rows belong in a different pool - same reason as the shadow flags below.
          // Only a rebuild can move them.
          if (renderIdentityKey(mat) !== mem.identity) return false
          // shadow flags are part of the merge key - a flip means the rows belong in a different
          // pool, which only a rebuild can arrange. (A layer change needs no twin check here:
          // poolable() rejects non-default layers, so the mesh drops out of collectEligible and
          // the `present` check above already fails it.)
          if (m.castShadow !== mem.cast || m.receiveShadow !== mem.receive) return false
        }
      }
    }
    // a dirty part with recorded rows that is no longer in the tree at all: stale rows
    for (const id of recorded.keys()) if (!visited.has(id)) return false
    this.writeThrough(ids, SCOPED_WRITE_POISON) // row rewrites in place; poisons the signature when it wrote
    return true
  }

  /** write one pool's aSel rows from the current tiers (member ranges are contiguous per source) */
  private applyTiersToPool(entry: PoolEntry): void {
    const attrs = entry.attrs
    // no wrapper (a legacy attr-less entry) ⇒ no aSel channel ⇒ the mask would discard every
    // fragment of it. Mark it unselectable so the gate skips the draw entirely.
    if (!attrs) {
      markBatchSelection(entry.mesh, false)
      return
    }
    const attr = attrs.geometry.getAttribute(SEL_ATTR) as InstancedBufferAttribute | undefined
    if (!attr) {
      markBatchSelection(entry.mesh, false)
      return
    }
    const arr = attr.array as Float32Array
    let dirty = false
    let selected = false
    for (const mem of attrs.members) {
      // one span per source: a member's rows are contiguous by construction (copyMemberAttrs)
      const tier = this.tiers.get(mem.partId) ?? 0
      if (tier > 0) selected = true
      if (writeTierSpan(arr, mem.offset, mem.count, tier)) dirty = true
    }
    if (dirty) {
      attr.needsUpdate = true
      markPool(entry)
    }
    // the outline mask's draw gate, recorded where the rows are written (selTierChannel.ts)
    markBatchSelection(entry.mesh, selected)
  }

  /** The sources the pool currently keeps hidden (visible=false). compileAsync/drawingPipeline.project skips
   *  visible=false, so these never compile their pipelines at load - and a drag un-hides them
   *  (drag-eject) so they render live while moving, compiling cold on the first grab.
   *  compileStaged reveals them during its phase-2 warm so they compile with the parts. Returned live;
   *  callers must only reveal for the compile then restore visible=false (the pool's merged copy draws). */
  hiddenSourceMeshes(): readonly Mesh[] {
    return this.hiddenSources
  }

  /** Retained pool count - drawing plus parked (see step 6). Not the same as the number of pool
   *  meshes in the scene, which is why it needs its own accessor: parking is invisible from the
   *  scene graph, so only this can tell "kept warm for a drag" from "leaked one per edit". */
  debugPoolCount(): number {
    return this.pools.size
  }

  /** The pool's output group: the merged static-hardware InstancedMeshes that draw. It sits in the
   *  scene at visible=true, but it belongs to the parts, not the building, so compileStaged defers it
   *  (visible=false through phase 1, revealed with the parts in phase 2). Otherwise the pooled legs,
   *  frames and structural boxes appear a phase early, floating over the building before their part
   *  bodies. Empty (but present) until the first rebuild; deferring it then is a harmless no-op. */
  outputGroup(): Object3D {
    return this.poolGroup
  }

  /** grow a pool's instance buffer to hold `needed` matrices. Never shrinks, so after the initial full-scene
   *  rebuild sets the high-water mark, selection changes (which only remove instances) never reallocate - the
   *  regrow fires only when the pooled total genuinely climbs (a part added, or a conveyor extended so its
   *  legs/bolts grow past the load-time high-water). Grows in coarse power-of-two buckets (bucketCapacity) so
   *  a run of incremental climbs reuses one buffer instead of reallocating each step. */
  private ensureCapacity(entry: PoolEntry, needed: number): void {
    if (entry.capacity >= needed) return
    const capacity = bucketCapacity(needed)
    if (!isWebGPURenderMode()) {
      // WebGL: real instanced attributes are count-independent, so growing the buffer in place keeps the
      // same (warm) mesh - buffer size isn't part of the pipeline key, only the attribute format is.
      // The replaced attributes' GL buffers are orphaned, not deleted: three only frees buffers through
      // dispose events, and there is no public seam to raise one for a swapped-out attribute. Accepted
      // as a soft leak - the browser reclaims the GL resource when the old attribute is GC'd, and grows
      // never shrink, so a pool reallocates O(log growth) times over its whole life.
      entry.mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16)
      if (entry.attrs) {
        for (const name of entry.attrs.names) {
          const old = entry.attrs.geometry.getAttribute(name) as InstancedBufferAttribute
          entry.attrs.geometry.setAttribute(name, new InstancedBufferAttribute(new Float32Array(capacity * old.itemSize), old.itemSize))
        }
        entry.attrs.members.length = 0 // contents refilled by the bake this grow precedes
      }
      entry.capacity = capacity
      return
    }
    // WebGPU: three's node builder captured the mesh's original instanceMatrix.array and caches the node graph
    // by mesh uuid - so swapping a larger attribute onto the same mesh is ignored (the node still reads the old,
    // short buffer) and a grown count over-indexes → the merged hardware renders from a stale buffer. (three
    // 0.185.1 sizes the uniform to the buffer's capacity, which fixes count-past-capacity, but not this
    // captured-array-reference staleness on realloc.) Mint a fresh mesh (new uuid ⇒ the node rebuilds against
    // the new buffer); it compiles at the new capacity automatically. The caller re-adds it to the pool group
    // (pool.parent check below); this only fires on genuine growth (never on selection), so the persistent-mesh
    // warmth that keeps selection cheap is preserved. Carries every render-state flag the merged mesh needs.
    const old = entry.mesh
    let geometry = old.geometry
    if (entry.attrs) {
      // the node builder captured the wrapper's per-instance arrays the same way it captures
      // instanceMatrix - mint a fresh wrapper alongside the fresh mesh (its vertex data is cloned from
      // the old wrapper, which is content-identical to the template by key). Refilled by the bake below.
      const fresh = buildPoolWrapper(entry.attrs.geometry, entry.attrs.names, capacity)
      // Retire, never dispose - a capacity grow happens mid-session (a part added, a conveyor
      // extended past the high-water) with recordings live over the outgoing wrapper (gpuRetire.ts)
      retireGeometry(entry.attrs.geometry)
      entry.attrs.geometry = fresh
      entry.attrs.members.length = 0
      geometry = fresh
    }
    const next = new InstancedMesh(geometry, old.material, capacity)
    next.castShadow = old.castShadow
    next.receiveShadow = old.receiveShadow
    next.frustumCulled = false
    next.matrixAutoUpdate = false
    next.raycast = noRaycast
    next.userData.instancePool = true
    old.parent?.remove(old)
    // ...and the mesh it replaces owns the per-instance matrix buffer, equally baked into a
    // recording. Its geometry is either the shared template or the wrapper retired just above, so
    // release only the mesh here.
    retireInstancedMeshOnly(old)
    entry.mesh = next
    entry.capacity = capacity
  }

  /** whether `o` is still connected to the scene graph (vs. removed by a structural edit) */
  private attached(o: Object3D): boolean {
    let p: Object3D | null = o
    while (p) {
      if (p === this.scene) return true
      p = p.parent
    }
    return false
  }

  dispose(): void {
    for (const s of this.hiddenSources) {
      s.visible = true
      delete s.userData.poolHidden
    }
    this.hiddenSources.length = 0
    for (const entry of this.pools.values()) {
      entry.mesh.parent?.remove(entry.mesh)
      // retire, never dispose: a recording made over the pool may still hold these handles
      // (gpuRetire.ts). The mesh's geometry is a shared template or the wrapper retired beside it.
      retireInstancedMeshOnly(entry.mesh)
      retireGeometry(entry.attrs?.geometry)
    }
    this.pools.clear()
    this.scene.remove(this.poolGroup)
    releaseBundleGroup(this.poolGroup)
    notifyBundleStructureChanged() // the restored sources must re-record into the parts bundle
    this.builtSig = ''
  }
}

/** default Layers mask (only layer 0). Non-default ⇒ ghost overlay ⇒ excluded. */
const DEFAULT_LAYER_MASK = 1

/** Depth-first walk that prunes hidden subtrees, matching what the renderer draws, and pushes every
 *  poolable InstancedMesh it reaches. Pruned: a `visible = false` container (an author-hidden rig link
 *  like the platform railing's collision wall, or a param-toggled-off member) and a leaf hidden by
 *  anyone other than the pool. The manager itself sets a pooled source's `.visible` to false (tagging it
 *  `poolHidden`; restored in step 3 of the next rebuild), so a pool-hidden leaf still counts as eligible.
 *  Otherwise it would fall out of the pool on the next rebuild. A leaf hidden without the tag (an
 *  author-hidden mesh, a staticFold source) is really hidden: the renderer skips it, and pooling it
 *  would make the merged copy draw what the original never showed.
 *
 *  It also prunes a runtime-mobile subtree (`poolMobile`, stamped by rig.ts on a link a joint / aim
 *  constraint / setSubPose moves). The bake is world-space and only re-runs on structural events, never
 *  per frame, so a merged copy of moving hardware freezes at the last-baked pose. */
function collectEligible(o: Object3D, out: Mesh[]): void {
  if (o.userData.poolMobile === true) return // FK moves it every frame; a baked copy would go stale
  // a static-fold root batches its own subtree (staticFold.ts). Pooling a mesh the fold left live would
  // move its draw out of the root, whose visibility is toggled live (wall auto-hide), and hiding it
  // changes the fold's signature: the building's window glass did this, one source per wall run
  if (o.userData.staticFoldRoot === true) return
  const m = o as InstancedMesh
  if (m.isInstancedMesh) {
    if (!m.visible && m.userData.poolHidden !== true) return // hidden by someone else - stays out, subtree too
    if (poolable(m)) out.push(m)
  } else if ((o as Mesh).isMesh && o.userData.poolUnit === true) {
    if (!o.visible && o.userData.poolHidden !== true) return
    if (poolableUnit(o as Mesh)) out.push(o as Mesh)
  } else if (!o.visible) {
    return // hidden container ⇒ the renderer skips this whole subtree; so must the pool
  }
  for (const child of o.children) collectEligible(child, out)
}

function poolable(mesh: InstancedMesh): boolean {
  if (mesh.count <= 0) return false
  if (mesh.userData.dynamicInstances === true) return false // per-frame instanceMatrix (unset in production today - see header)
  if (mesh.instanceColor) return false // per-instance colour would need a colour-buffer merge too
  if (mesh.layers.mask !== DEFAULT_LAYER_MASK) return false // ghosts (overlay)
  if (Array.isArray(mesh.material)) return false // multi-material draws by geometry groups; the pool wrapper has none → the copy would draw nothing
  const mat = mesh.material
  if (sortedBlend(mat)) return false
  if (mat &&(mat as Material).userData?.spinUniform) return false // rollers (incl. turntable-deck)
  return true
}

/** A plain `poolUnit`-tagged mesh (a static rig's unit-primitive link, rig.ts): same exclusions as an
 *  instanced source where they apply, plus redundant re-checks of what the tag already implies:
 *  no children (an edges/label child would be dropped by the pool copy, which clones none) and a
 *  material. */
function poolableUnit(mesh: Mesh): boolean {
  if (mesh.children.length > 0) return false
  if (mesh.layers.mask !== DEFAULT_LAYER_MASK) return false
  if (Array.isArray(mesh.material)) return false
  const mat = mesh.material
  if (!mat || sortedBlend(mat)) return false
  if ((mat as Material).userData?.spinUniform) return false
  return true
}

/** A material three draws in a sorted per-object pass: transparent, or transmissive (its own list, also
 *  sorted back to front). Pooling one moves its draw into the pool's single object, which reorders it
 *  against its neighbours and puts it in whichever bundle group the pool sits in (the opaque one). Both
 *  eligibility paths use this, so they can't disagree. */
function sortedBlend(mat: Material | undefined): boolean {
  if (!mat) return false
  return mat.transparent === true || ((mat as Material & { transmission?: number }).transmission ?? 0) > 0
}

// Full render-identity key: two materials share it only if they'd render identically. Covers both
// backends: getCacheKey (WebGPU node graph, incl. baked colour/boost constants) and
// customProgramCacheKey (WebGL onBeforeCompile, incl. boost/triScale/beam), plus the standard
// PBR props and texture object identities. Merged instances all draw with grp[0].material.
function materialKey(mat: Material | undefined): string {
  if (!mat) return 'none'
  const m = mat as Material & Record<string, unknown>
  const graph = typeof m.getCacheKey === 'function' ? safe(() => (m.getCacheKey as () => unknown)()) : mat.type
  const prog = typeof m.customProgramCacheKey === 'function' ? safe(() => (m.customProgramCacheKey as () => unknown)()) : ''
  // lightMap: the building's four wall sides share geometry, map and every scalar, and differ only in
  // which baked lightmap they sample (wallLightmaps.ts) - leave it out and three sides draw the fourth's light
  const tex = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'lightMap']
    .map((t) => (m[t] as { uuid?: string } | undefined)?.uuid ?? '-')
    .join('/')
  return `${mat.constructor?.name}|${graph}|${prog}|tex=${tex}|id=${renderIdentityKey(mat)}|m${m.metalness ?? '-'}|r${m.roughness ?? '-'}|o${mat.opacity}|t${mat.transparent ? 1 : 0}|s${mat.side}`
}

// Fields that say nothing about how a material renders: object identity, the dirty counter, and
// the author-facing name. userData is excluded here because renderIdentityKey already covers it
// with the nesting rules that keep a per-frame uniform bag out.
const MATERIAL_DEEP_SKIP = new Set(['uuid', 'id', 'version', 'name', '_listeners', 'userData'])

/**
 * Render identity derived from the material object rather than from the merge key - the second,
 * independent opinion auditGrouping needs (see its doc for why a key cannot audit itself). Walks
 * own enumerable properties, hashing what is readable and skipping functions, so a property
 * nobody thought to enumerate still separates two materials here even though materialKey misses
 * it. Never on the frame path: this is an auditor, not a grouping key.
 */
function materialDeepKey(mat: Material | undefined): string {
  if (!mat) return '-'
  const o = mat as unknown as Record<string, unknown>
  const parts: string[] = [mat.constructor?.name ?? 'Material']
  for (const k of Object.keys(o).sort()) {
    if (MATERIAL_DEEP_SKIP.has(k)) continue
    if (typeof o[k] === 'function') continue
    parts.push(`${k}=${identityValue(o[k])}`)
  }
  parts.push(`userData=${renderIdentityKey(mat)}`)
  return parts.join('|')
}

/** the first `field=value` that differs between two deep keys, so a failure names the property
 *  rather than dumping two hundred-character hashes at whoever has to fix it */
function firstDifference(a: string, b: string): string {
  const A = a.split('|')
  const B = b.split('|')
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) return `head ${A[i] ?? "-"} vs member ${B[i] ?? "-"}`
  }
  return 'no field differs'
}

function safe(fn: () => unknown): string {
  try {
    return String(fn())
  } catch {
    return '?'
  }
}
