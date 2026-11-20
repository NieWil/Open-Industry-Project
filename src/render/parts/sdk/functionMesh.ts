import { DoubleSide, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import type { Group, InstancedMesh, Material, Mesh } from 'three'
import type { RollerGrid } from '../../../core/conveyor/rollerGrid'
import type { RigParams } from '../../../core/rig/rigPose'
import { evalPartGeometry, resolvePartParams } from '../../../core/geometry/geometryEval'
import { bedView } from '../../../core/parts/partGeometry'
import { beltXToS, beltXToSExt, buildBeltPath } from '../../../core/conveyor/beltPath'
import { withGuardGaps, type GuardOpenings } from '../../../core/guards/guardOpenings'
import { guardHoleRows } from '../../../core/guards/guardHoles'
import type { GuardHoles } from '../../../core/guards/guardHoles'
import type { GuardExtents } from '../../../core/guards/guardExtents'
import { guardMitreRows, withSnapExtents } from '../../../core/guards/guardExtents'
import type { LegRestRows } from '../../../core/legRests'
import { withLegRests } from '../../../core/legRests'
import type { PlatformCut } from '../../../core/structureCuts'
import type { MeshDescription, MeshPart, ParamValue } from '../../../core/parts/partApi'
import type { PartAsset, PartMaterial, PartPackage } from '../../../core/parts/partPackage'
import type { SdkPart } from '../../../core/types'
import { realizeInstancedTemplate, writeInstanceMatrices } from '../instancedTemplate'
import { realizeMeshDescription, rewriteMeshDescription } from '../meshDescriptionGeometry'
import { BELT_TEX_PERIOD, boltMaterial, createBeltSurface, gapFillMaterial, guardMaterial, legMaterial, markTickUniformsAdvanced, railMaterial, rollerMaterial, deckTriplanarMaterial, shadowMesh } from '../common'
import type { BeltTextureVariant } from '../common'
import { acquireBeltBankMaterial, beltClockEpoch, releaseBeltBankMaterial, rebaseBeltScroll, rebaseBeltScrollForWrap, writeFabricBankAttributes, writeFabricBankScroll } from '../beltFabricBank'
import { bumpRepaintEpoch, bumpStructureVersion } from '../structureRev'
import { retireGeometry, retireInstancedMesh } from '../../gpuRetire'
import { markLazyColliderBVH } from '../../bvh'
import type { Content } from './types'
import { descEqual, FN_NEUTRAL } from './shared'
import { advanceBankSpins, bankSpinSign, spinUniformOf } from './bankSpin'
import type { BankSpin } from './bankSpin'
import { buildMaterial } from './materials'

const _spinQ = new Quaternion()
const _spinV = new Vector3()

// ---- drawn geometry (geometry.kind: 'drawn': the shape comes from the part's geometry()) -------------
// The Tier-2 escape hatch (docs/procedural-geometry.md): a part's geometry(g, params) callback emits one or
// more MeshPart[] (a bent multi-segment belt = a scrolling fabric bed + a steel frame + side guards + support
// legs), realized via core/geometry/geometryEval - render's in-layer twin of the sim's embeddedBehavior.geometry
// (render may not import sim). Each part is realized into its own mesh with a per-role material ('belt' = the
// scrolling conveyor fabric, 'frame'/'guard'/'leg' = steel, else neutral; a `material` id overrides). The
// geometry re-runs (and the meshes rebuild) only when the resolved params change, never per frame.

// Fold the host-computed neighbour guard openings (centreline X) into a belt-like part's `guardOpenings`
// param as arc-length rows ([s0, s1, side]: −1 left / +1 right), so the pure geometry() cuts the guard ribbon
// where a conveyor butts - the same openings the sim cuts for collision. A no-op unless the part is belt-like
// and declares a `guardOpenings` param (the cut convention). geometry() stays world-unaware: the host resolves
// the neighbour fact and injects it as ordinary params, exactly like rest:'surfaceBelow' fills standHeight.
function withNeighborOpenings(p: SdkPart, pkg: PartPackage, params: Record<string, ParamValue>, openings?: GuardOpenings): Record<string, ParamValue> {
  if (!openings || (openings.left.length === 0 && openings.right.length === 0) || !pkg.params.guardOpenings) return params
  const view = bedView(p, 'path')
  if (!view) return params
  const path = buildBeltPath(view.segments, view.height)
  const rows: number[][] = []
  for (const [a, b] of openings.left) rows.push([beltXToS(path, a), beltXToS(path, b), -1])
  for (const [a, b] of openings.right) rows.push([beltXToS(path, a), beltXToS(path, b), 1])
  const existing = Array.isArray(params.guardOpenings) ? (params.guardOpenings as number[][]) : []
  return { ...params, guardOpenings: [...existing, ...rows] }
}

// Fold the host-derived sensor-beam holes (guardHoles.ts) into a function conveyor's `guardHoles` param as rows
// [x, y, side ±1], so its geometry() splits the guard sheet around each and draws the holed panel. x arrives in the
// host's guard frame: a belt-like part's plan X becomes arc length here (the frame its guard is built in, as for
// openings), extended along the end tangents, since its guards run on around each end drum and a hole there is
// negative or past the path's length; a centre-origin bed's X and a curve's arc angle pass through. A no-op unless
// the part declares the param (the hole convention) - a conveyor that doesn't draw holes keeps solid guards.
function withGuardHoles(p: SdkPart, pkg: PartPackage, params: Record<string, ParamValue>, holes?: GuardHoles): Record<string, ParamValue> {
  if (!holes || !pkg.params.guardHoles) return params
  const view = bedView(p, 'path')
  const path = view ? buildBeltPath(view.segments, view.height) : null
  const rows = guardHoleRows(holes).map(([x, y, side]) => [path ? beltXToSExt(path, x!) : x!, y!, side!])
  return rows.length ? { ...params, guardHoles: rows } : params
}

// Fold the junction mitres (guardExtents.ts GuardMitre) at this part's opening ends and its own extents ends into its
// `guardMitres` param as rows [x, c, side ±1], so geometry() cuts each guard end that meets another guard on the one
// plane both share. x stays in plan local X on every family: a belt matches it against its pieces' plan ends rather
// than arc length. A no-op unless the part declares the param (the cut convention).
// The same fold carries a mover's rail cuts (GuardExtents.railCuts) into `railCuts`, same row shape: where its frame
// rails stop against the host's frame, which stays whole.
function withGuardMitres(pkg: PartPackage, params: Record<string, ParamValue>, openings?: GuardOpenings, extents?: GuardExtents): Record<string, ParamValue> {
  let out = params
  const rows = pkg.params.guardMitres ? guardMitreRows(openings?.mitres, extents?.mitres) : []
  if (rows.length) out = { ...out, guardMitres: rows }
  const rails = pkg.params.railCuts ? guardMitreRows(extents?.railCuts) : []
  if (rails.length) out = { ...out, railCuts: rails }
  return out
}

export function buildFunctionMesh(geo: Extract<PartPackage['geometry'], { kind: 'drawn' }>, pkg: PartPackage, root: Group, assets: readonly PartAsset[], materials: readonly PartMaterial[]): Content {
  // host materials by role - the same textured-metal materials the built-in conveyor uses (railMaterial /
  // guardMaterial / legMaterial / boltMaterial) so a function-belt reads identically - plus the scrolling
  // fabric for 'belt' and any package material a part references by id. All created lazily (the first part
  // of each role makes its material) so a part allocates only the materials it actually uses.
  const allMats: Material[] = []
  let belt: ReturnType<typeof createBeltSurface> | null = null
  const beltMat = (): Material => {
    if (!belt) {
      belt = createBeltSurface()
      belt.material.side = DoubleSide
      allMats.push(belt.material)
    }
    return belt.material
  }
  // owned: never the WebGPU path's shared per-spec metal (common.ts sharedNodeMetal), for a caller that re-tints in place
  const makeRoleMat = (role: string, owned = false): Material => {
    const m = role === 'frame' ? railMaterial(owned) : role === 'guard' ? guardMaterial(owned) : role === 'leg' ? legMaterial(owned) : role === 'bolt' ? boltMaterial(owned) : role === 'gapfill' ? gapFillMaterial(owned) : role === 'roller' ? rollerMaterial() : role === 'deck' || role === 'tread' ? deckTriplanarMaterial(role) : FN_NEUTRAL()
    // frame + guards are open swept ribbons → double-sided; bolts are hand-built hex prisms (keep them
    // double-sided so any winding slip in the low-level surface never shows as a black facet)
    if (role === 'frame' || role === 'guard' || role === 'mesh' || role === 'bolt' || role === 'gapfill') m.side = DoubleSide
    return m
  }
  const roleMats = new Map<string, Material>()
  const roleMat = (role: string): Material => {
    let m = roleMats.get(role)
    if (!m) {
      m = makeRoleMat(role)
      roleMats.set(role, m)
      allMats.push(m)
    }
    return m
  }
  const makePkgMat = (id: string): Material => {
    const ref = materials.find((x) => x.id === id)
    const m = ref ? buildMaterial(ref, assets) : FN_NEUTRAL()
    m.side = DoubleSide
    return m
  }
  const pkgMats = new Map<string, Material>()
  const matForId = (id: string): Material => {
    let m = pkgMats.get(id)
    if (!m) {
      m = makePkgMat(id)
      pkgMats.set(id, m)
      allMats.push(m)
    }
    return m
  }
  // per-colorParam tinted materials (MeshPart.colorParam): a tinted submesh gets its own material instance -
  // role/package materials are shared, so tinting one in place would repaint every same-role part. Keyed by
  // base + param name so the instance keeps its identity across refreshes (the mesh reconcile below compares
  // materials by identity - a pure colour edit re-tints in place, like beltColor, and never rebuilds a mesh).
  const tintMats = new Map<string, { mat: Material; param: string }>()
  const tintMat = (part: { finish?: string; material?: string; colorParam: string }): Material => {
    const key = `${part.material ?? part.finish ?? 'mesh'}\0${part.colorParam}`
    let t = tintMats.get(key)
    if (!t) {
      t = { mat: part.material ? makePkgMat(part.material) : makeRoleMat(part.finish ?? 'mesh', true), param: part.colorParam }
      tintMats.set(key, t)
      allMats.push(t.mat)
    }
    return t.mat
  }
  // DoubleSide variants (MeshPart.doubleSided): a shared role/pkg material must stay single-sided for
  // everyone else, so a two-faced submesh gets its own clone, cached by base identity (the reconcile compares
  // materials by identity - a re-eval reuses the same clone, never rebuilds the mesh).
  const dblVariants = new Map<Material, Material>()
  const asDouble = (base: Material): Material => {
    let d = dblVariants.get(base)
    if (!d) { d = base.clone(); d.side = DoubleSide; dblVariants.set(base, d); allMats.push(d) }
    return d
  }
  const matFor = (part: { finish?: string; material?: string; colorParam?: string; doubleSided?: boolean }): Material => {
    const base = part.colorParam && part.finish !== 'belt' && !(!part.finish && geo.conveys) ? tintMat(part as { finish?: string; material?: string; colorParam: string })
      : part.material ? matForId(part.material)
      : part.finish === 'belt' || (!part.finish && geo.conveys) ? beltMat()
      : roleMat(part.finish ?? 'mesh')
    return part.doubleSided ? asDouble(base) : base
  }

  // one realized submesh per emitted MeshPart, holding the desc + material it was built from so a refresh can
  // reuse the slot when neither changed - only the roles a param edit actually altered re-realize.
  const meshes: { mesh: Mesh; desc: MeshDescription; mat: Material }[] = []
  // instanced-template banks (MeshPart.instances): one InstancedMesh per emitted bank, in stable emit order.
  const instMeshes: { mesh: InstancedMesh; desc: MeshDescription; mat: Material }[] = []
  // MeshPart.spin on a bank: its own material, whose object-space grain the tick turns about each instance's local Z
  // (bankSpin.ts) - one per (material, radius, speed, sense), so a bed's bodies and its axle stubs turn together
  const bankSpins: BankSpin[] = []
  const bankSpinMats = new Map<string, Material>()
  const spinMatFor = (part: { finish?: string; material?: string; spin: NonNullable<MeshPart['spin']> }): Material => {
    const sign = bankSpinSign(part.spin.axis)
    const speed = part.spin.speed ?? pkg.conveyor?.speedParam ?? ''
    const key = `${part.material ?? part.finish ?? 'mesh'}\0${part.spin.radius}\0${speed}\0${sign ?? 0}`
    let m = bankSpinMats.get(key)
    if (!m) {
      m = part.material ? makePkgMat(part.material) : makeRoleMat(part.finish ?? 'mesh')
      const uniform = spinUniformOf(m)
      if (uniform && sign !== null) bankSpins.push({ uniform, radius: part.spin.radius, speed, sign, angle: 0 })
      bankSpinMats.set(key, m)
      allMats.push(m)
    }
    return m
  }
  // MeshPart.spin on a plain submesh: the mesh itself turns about the axis through `center`, as a rig's geometry()
  // submesh does (rigProcedural.ts), so a toothed sprocket's teeth go round
  const meshSpins: { mesh: Mesh; axis: Vector3; center: Vector3; radius: number; speed: string; angle: number }[] = []
  let lastParams: Record<string, ParamValue> = {}
  // a spin's speed: the conveyor's declared speed param is the conveyor's own (live while running, else the param -
  // the belt convention above); any other name reads that param; '' (no name on a part that is no conveyor) is 0
  const spinSpeed = (name: string): number => {
    if (name === '') return 0
    if (name === pkg.conveyor?.speedParam) return liveSpeed ?? speed
    const v = lastParams[name]
    return typeof v === 'number' ? v : 0
  }
  let lastKey = ''
  let speed = 0 // cached belt speed (m/s) for the fabric scroll tick + the roller spin
  // fabric-bank scroll state, the instanced beds' twin of belt.uv.offset.x. A straight belt's
  // bed is instance banks with a shared material (beltFabricBank.ts), so its scroll is stored in per-instance
  // attributes rather than a texture offset, as [base, rate], with the shader integrating
  // `base + rate·beltClock`. These only change when the rate does (or when the clock wraps), so a
  // running belt needs no per-frame writes; bankEpoch is the wrap generation the base was written for.
  let bankBase = 0
  let bankRate = 0
  let bankEpoch = beltClockEpoch()
  let liveSpeed: number | null = null // frame-routed effective speed (m/s) while running; null = use the param
  // a curved conveyor (a param with the 'arc' handle) drives an arc field: the frame's live speed arrives as
  // omega (rad/s) - convert back to centreline m/s (omega × rc) so scroll/spin match the straight convention.
  let arcHandle: { innerRadiusParam?: string; widthParam?: string } | null = null
  for (const spec of Object.values(pkg.params)) if (spec.handle?.kind === 'arc') { arcHandle = spec.handle; break }
  let arcRc = 0 // centreline radius (m), resolved from the live params on refresh
  // Belt fabric u-direction. Every bed bakes u along travel - a straight one along +X, a curve as the
  // arc-length growing with the sweep angle (pinned by curvedConveyorRigParity) - and the arrows weave points
  // toward +u in the image, so the fabric is sampled unmirrored everywhere and the scroll just walks the
  // offset backwards at the belt speed.
  //
  // Caution: repeat.x and the scroll advance must always change together. Sampling mirrored
  // (a negative repeat.x) flips the baked image and reverses which way an offset delta walks the pattern, so
  // mirroring without flipping the advance fixes a backwards weave but makes the scroll run backwards. A curve must not
  // mirror: its u runs 0 at the +X inlet to ~2.0 at the −Z outlet, so a −1 repeat samples the arrows weave
  // backwards down the sweep (the diamond-symmetric plain weave hides it). Instanced fabric banks (a straight bed) carry their own uv
  // and scroll in per-instance attributes - a separate path, untouched by any of this.

  return {
    materials: allMats,
    refresh(p: SdkPart, openings?: GuardOpenings, _grid?: RollerGrid, extents?: GuardExtents, _platformCut?: PlatformCut, legRests?: LegRestRows, holes?: GuardHoles): void {
      const overrides = p.params as RigParams
      // resolve params, then fold in any neighbour-derived guard openings so a butted junction or a diverter opens
      // the guard (a belt takes them as arc-length guardOpenings rows, a straight or a spur as guardGaps), any
      // snap-derived extents so a merged mover's rails/guards end on the host wall plane
      // (a spur extends to it; a flush straight/belt retracts to it), any host-derived leg-rest rows so
      // a bed crossing a platform stands each leg on the surface actually below it (legRests.ts), and the
      // sensor-beam holes through its guards (guardHoles.ts).
      const params = withGuardMitres(pkg, withGuardHoles(p, pkg, withLegRests(p, withSnapExtents(p, withGuardGaps(p, withNeighborOpenings(p, pkg, resolvePartParams(pkg.params, overrides), openings), openings), extents), legRests), holes), openings, extents)
      // drives the fabric scroll (belt convention) - read the resolved speed: a belt left at its default speed
      // carries no override, so overrides.speed is undefined and the scroll would freeze. Folded with the
      // snap-owned `reverse` flag (conveyorDirection.ts) so a snapped-reversed curve scrolls back down its own
      // sweep; while the sim runs, applyConveyorSpeed's live value supersedes this and already carries the sign.
      // the default speed channel: the conveyor's declared speed param
      const sk = pkg.conveyor?.speedParam, rk = pkg.conveyor?.reverseParam
      speed = (sk && typeof params[sk] === 'number' ? (params[sk] as number) : 0) * (rk && params[rk] === true ? -1 : 1)
      if (arcHandle) {
        // resolve the arc centreline radius the same way the behavior does (its omega = speed / rc). The params
        // are schema-resolved (defaults filled), so the fallbacks only cover a package that declares neither
        // param - fall back to its own baked bounds, never a specific part's dimensions.
        const ir = params[arcHandle.innerRadiusParam ?? 'innerRadius']
        const w = params[arcHandle.widthParam ?? 'width']
        const bw = (pkg.geometry.kind !== 'cargo' ? pkg.geometry.bounds?.width : undefined) ?? 1
        arcRc = (typeof ir === 'number' && ir > 0 ? ir : 0.5) + (typeof w === 'number' && w > 0 ? w : bw) / 2
      }
      // the belt fabric's u is the loop arc length in metres (the geometry bakes it), so tile a constant 1 per
      // BELT_TEX_PERIOD metres - length-independent, no need to know the belt length here. The 'alternate'
      // beltTexture weave swaps the sampled image to the directional-arrows fabric (one arrow spans the
      // width, v-repeat 1) - see BeltSurface.setVariant; nothing else about the tiling/scroll changes.
      if (belt) {
        belt.setVariant(params.beltTexture === 'alternate' ? 'alternate' : 'standard')
        belt.uv.repeat.set(1 / BELT_TEX_PERIOD, 1)
      }
      lastParams = params
      const key = JSON.stringify(params)
      if (key === lastKey) return // re-run geometry() only when a param actually changes (never per frame)
      lastKey = key
      const allParts = evalPartGeometry(pkg.behavior, params, { partId: p.id, packageId: pkg.id })
      if (!allParts) return // no geometry()/a bad source: keep the last good meshes (empty on first build); the failure itself is reported in partDiagnostics
      // Structural tracking for render bundles: a recorded bundle bakes the draw list - geometry
      // objects, materials (pipelines/bind groups), instance counts. The reconcile below mostly
      // rewrites matrices/attributes in place (replay-safe); flag the mutations that actually
      // change the draw list and bump the visual root's structureVersion once at the end (the
      // view's syncBundleInvalidation poll re-records; staging re-tags - same seam as
      // sdkPart.rebuild / rig link regrow). Notifying on every params change instead would
      // re-record every frame of a reposition drag (standHeight churn).
      let structural = false
      // instanced-template banks are laid out as InstancedMeshes (below), never as plain reconcile slots
      const instancedParts = allParts.filter((p) => p.instances !== undefined)
      const parts = allParts.filter((p) => p.instances === undefined)
      // Reconcile per submesh (stable emit order): re-realize a slot only when its material or geometry changed,
      // so raising a legged deck (only the 'leg' desc differs) rebuilds one mesh instead of disposing + rebuilding
      // belt/frame/guards/legs every frame - the dominant cost when dragging many SDK conveyors.
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!
        const mat = matFor(part)
        const slot = meshes[i]
        if (slot && slot.mat === mat && descEqual(slot.desc, part.desc)) continue // unchanged - keep the mesh as-is
        // Recycle first. The common re-emit is the same topology at new coordinates (a drag moving a
        // dimension), and rewriting the existing buffers keeps every GPU handle alive: nothing is
        // freed under a live recording, and the recorded draw stays valid, with no re-record and no
        // allocation per pointer-move. Only a real topology change falls through to
        // the swap below. See meshDescriptionGeometry.rewriteMeshDescription / gpuRetire.ts.
        if (slot && slot.mat === mat && rewriteMeshDescription(slot.mesh.geometry, part.desc)) {
          slot.desc = part.desc
          continue // not structural: same geometry object, same index count - the bundle replays it
        }
        structural = true // geometry swap or new mesh
        const geo = realizeMeshDescription(part.desc)
        if (slot) {
          // Retire, never dispose: a recorded render bundle holds the outgoing geometry's actual
          // GPUBuffers, and a resize drag runs this on every pointer-move (gpuRetire.ts).
          retireGeometry(slot.mesh.geometry)
          slot.mesh.geometry = geo
          slot.mesh.material = mat
          slot.desc = part.desc
          slot.mat = mat
        } else {
          const mesh = shadowMesh(geo, mat, part.castShadow !== false)
          // the pilot collides against this render mesh; let it build a tree when it does (bvh.ts)
          markLazyColliderBVH(mesh)
          root.add(mesh)
          meshes.push({ mesh, desc: part.desc, mat })
        }
      }
      // drop any submeshes the new geometry no longer emits (e.g. a structure toggle removed a role)
      for (let i = meshes.length - 1; i >= parts.length; i--) {
        const slot = meshes.pop()!
        root.remove(slot.mesh)
        retireGeometry(slot.mesh.geometry)
        structural = true
      }
      // Pool opt-in: a plain submesh never moves relative to its part, so identical parts (three racks on
      // the same params, a row of the same shape) merge in the scene-global instance pool, which matches by
      // geometry content, not identity (geometryKey.ts). The in-place rewrite above is safe because the pool
      // folds each source's geometry version into its bake signature. The belt fabric stays out: its
      // material is this part's own and scrolls in place every tick, which the pool cannot see.
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!
        const fabric = part.finish === 'belt' || (!part.finish && geo.conveys)
        // a spinning submesh moves relative to its part every frame, so it never merges across parts either
        if (fabric || part.spin) delete meshes[i]!.mesh.userData.poolUnit
        else meshes[i]!.mesh.userData.poolUnit = true
      }
      // the spinning submeshes, re-registered on every emit; a reused mesh keeps its angle, and one that no longer
      // spins goes back to rest
      const prevAngle = new Map(meshSpins.map((sp) => [sp.mesh, sp.angle] as const))
      meshSpins.length = 0
      for (let i = 0; i < parts.length; i++) {
        const spin = parts[i]!.spin
        const mesh = meshes[i]!.mesh
        const axis = spin ? new Vector3(spin.axis[0], spin.axis[1], spin.axis[2]) : null
        if (spin && axis && axis.lengthSq() > 0) {
          const c = spin.center ?? [0, 0, 0]
          meshSpins.push({ mesh, axis: axis.normalize(), center: new Vector3(c[0], c[1], c[2]), radius: spin.radius, speed: spin.speed ?? pkg.conveyor?.speedParam ?? '', angle: prevAngle.get(mesh) ?? 0 })
        } else if (prevAngle.has(mesh)) {
          mesh.quaternion.identity()
          mesh.position.set(0, 0, 0)
        }
      }
      // instanced-template banks (MeshPart.instances): one InstancedMesh per bank, reconciled by stable emit
      // index. Reuse the slot when the template desc is unchanged and the new count still fits the buffer -
      // only the transforms rewrite (cheap); rebuild only when the geometry changed or the bank outgrew its
      // capacity. Because the geometry is byte-identical for the same template, identical banks across parts
      // collapse in the scene-global instance pool (keyed on geometryContentKey).
      //
      // Fabric banks (role 'belt' - a straight belt's instanced bed) take the shared bank material keyed by
      // (weave variant, belt colour) instead of the per-part scrolling beltMat, plus the per-instance
      // fabricUv/fabricScroll attributes - that shared identity is what lets beds pool across belts.
      const bankVariant: BeltTextureVariant = params.beltTexture === 'alternate' ? 'alternate' : 'standard'
      const bankTint = typeof params.beltColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(params.beltColor) ? params.beltColor : '#ffffff'
      for (let i = 0; i < instancedParts.length; i++) {
        const part = instancedParts[i]!
        const insts = part.instances!
        const isFabric = part.finish === 'belt' || (!part.finish && geo.conveys)
        // a slot holds one reference to a shared bank material: this pass's acquire replaces the one it held
        // (released after, so an unchanged colour never drops to zero), and dropping the slot releases it
        const mat = isFabric ? acquireBeltBankMaterial(bankVariant, bankTint) : part.spin ? spinMatFor({ ...part, spin: part.spin }) : matFor(part)
        const slot = instMeshes[i]
        releaseBeltBankMaterial(slot?.mat)
        if (slot && descEqual(slot.desc, part.desc) && insts.length <= slot.mesh.instanceMatrix.count) {
          if (slot.mat !== mat) { slot.mesh.material = mat; slot.mat = mat; structural = true } // pipeline/bindings swap
          if (slot.mesh.count !== insts.length) structural = true // a bundle bakes the draw's instance count
          writeInstanceMatrices(slot.mesh, insts)
          if (isFabric) writeFabricBankAttributes(slot.mesh, insts, bankBase, bankRate)
        } else {
          if (slot) { root.remove(slot.mesh); retireInstancedMesh(slot.mesh) }
          const mesh = realizeInstancedTemplate(part.desc, insts, mat)
          if (isFabric) writeFabricBankAttributes(mesh, insts, bankBase, bankRate) // before the pool first keys the geometry
          root.add(mesh)
          instMeshes[i] = { mesh, desc: part.desc, mat }
          structural = true
        }
      }
      // drop banks the new geometry no longer emits
      for (let i = instMeshes.length - 1; i >= instancedParts.length; i--) {
        const slot = instMeshes.pop()!
        root.remove(slot.mesh)
        retireInstancedMesh(slot.mesh)
        releaseBeltBankMaterial(slot.mat)
        structural = true
      }
      // (re)tile the fabric + pick its weave now that a 'belt' part may have created it this pass + apply any
      // beltColour tint (the belt is minted lazily during the mesh realization above, so it can be null earlier).
      let repainted = false
      if (belt) {
        belt.setVariant(params.beltTexture === 'alternate' ? 'alternate' : 'standard')
        belt.uv.repeat.set(1 / BELT_TEX_PERIOD, 1)
        const tint = params.beltColor
        if (typeof tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(tint)) {
          const beltMat = belt.material as MeshStandardMaterial
          const before = beltMat.color.getHex()
          beltMat.color.set(tint)
          if (beltMat.color.getHex() !== before) repainted = true
        }
      }
      // re-apply per-submesh colorParam tints (MeshPart.colorParam) - the materials are identity-stable
      // (tintMats), so a colour edit is applied here as an in-place repaint, never a mesh rebuild. An alpha:true
      // param arrives as 8-digit #rrggbbaa; strip the alpha for the RGB-only .color.set (the part decides what
      // the alpha means, e.g. a floor marking cutting out a transparent band in its geometry()).
      for (const t of tintMats.values()) {
        const v = params[t.param]
        if (typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
          const mat = t.mat as MeshStandardMaterial
          const before = mat.color.getHex()
          mat.color.set(v.slice(0, 7))
          if (mat.color.getHex() !== before) repainted = true
        }
      }
      // An in-place repaint changes render identity without changing the draw list, so the bundle keeps its
      // recording but instancePool's bake goes stale (colour is part of the key it groups by). See
      // structureRev.ts bumpRepaintEpoch: without it the demo's bollard posts bake white, tint amber a moment
      // later, and nothing re-bakes for the rest of the session.
      if (repainted) bumpRepaintEpoch()
      // the draw list changed under us - same seam as sdkPart.rebuild: staging re-tags the new
      // meshes and syncBundleInvalidation's poll re-records the render bundles. Matrix/attribute
      // rewrites above don't set `structural`: a recorded bundle replays those.
      if (structural) bumpStructureVersion(root)
    },
    // the running frame's live effective speed (tag-commanded/-gated) overrides the param for scroll + spin
    applyConveyorSpeed(v: number): void {
      liveSpeed = arcHandle ? v * Math.max(arcRc, 1e-3) : v // arc parts report omega - back to centreline m/s
    },
    tick(dt: number, running: boolean): boolean {
      if (!running) liveSpeed = null // a stale live speed must not outlive the run
      const s = liveSpeed ?? speed
      // scroll the belt fabric and spin the rollers (a part may have either, both, or neither). A bent
      // belt's swept bed scrolls its texture offset; a straight belt's instance banks carry the twin
      // per-instance [base, rate] the shader integrates against the shared belt clock.
      // Returns whether anything changed that needs the per-object bundle walk: only a bank-attr
      // rewrite (an InstancedBufferAttribute upload on the part's own bank when it renders unpooled),
      // which happens on rate changes and clock wraps, not every frame. The texture-offset scroll
      // and the roller spin use the shared TICK uniform group (belt/metalNodeMaterial.ts): direct
      // byte uploads, no walk, so no mark.
      let mutated = false
      if (running && s !== 0 && belt) {
        // Walk the offset backwards: the pattern sits at u = (texU − offset)·period, so a shrinking offset
        // carries it forward at the belt speed. That holds only while the sampling stays unmirrored
        // (repeat.x > 0) - see the u-direction note above before touching either sign.
        belt.uv.offset.x = (belt.uv.offset.x - (s * dt) / BELT_TEX_PERIOD) % 1
        markTickUniformsAdvanced()
      }
      // Fabric banks: the rate the shader should integrate at this instant. Stopped (or stopping) is
      // rate 0, which freezes the bed at the phase it currently shows - the clock stops advancing too
      // (view.tickBody only advances it while the sim runs), so both halves of the freeze agree.
      const rate = running ? -s / BELT_TEX_PERIOD : 0
      const epoch = beltClockEpoch()
      let rebased = false
      // wrap first (it must consume the old rate - that's the rate the shader was integrating at)
      if (epoch !== bankEpoch) {
        bankBase = rebaseBeltScrollForWrap(bankBase, bankRate, epoch - bankEpoch)
        bankEpoch = epoch
        rebased = true
      }
      if (rate !== bankRate) {
        bankBase = rebaseBeltScroll(bankBase, bankRate, rate)
        bankRate = rate
        rebased = true
      }
      if (rebased) {
        for (const im of instMeshes) {
          if (im.mesh.userData.beltFabricBank === true) {
            writeFabricBankScroll(im.mesh, bankBase, bankRate)
            mutated = true
          }
        }
      }
      if (running && advanceBankSpins(bankSpins, spinSpeed, dt)) markTickUniformsAdvanced() // tick group: no walk
      // a spinning submesh's own transform moves: that one needs the walk
      if (running) {
        for (const sp of meshSpins) {
          const v = spinSpeed(sp.speed)
          if (v === 0 || !(sp.radius > 0)) continue
          sp.angle = (sp.angle + (v / sp.radius) * dt) % (Math.PI * 2)
          _spinQ.setFromAxisAngle(sp.axis, sp.angle)
          sp.mesh.quaternion.copy(_spinQ)
          // turn about `center`, not the mesh origin: p' = q(p - c) + c, so the mesh sits at c - q c
          sp.mesh.position.copy(sp.center).sub(_spinV.copy(sp.center).applyQuaternion(_spinQ))
          mutated = true
        }
      }
      return mutated
    },
    dispose(): void {
      for (const m of allMats) m.dispose()
      // retired, not disposed: drawn in the bundled main pass, so a recording may still hold them (gpuRetire.ts)
      for (const m of meshes) retireGeometry(m.mesh.geometry)
      for (const m of instMeshes) { retireInstancedMesh(m.mesh); releaseBeltBankMaterial(m.mat) } // a bank material is shared, so released, not in allMats
      if (belt) belt.dispose() // every weave variant the belt minted, not just the bound one
    },
  }
}
