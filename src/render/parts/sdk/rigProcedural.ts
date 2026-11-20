// A rig dressed by its behavior's geometry() (MeshPart.link): each emitted submesh is realized into the group of
// the rig link it names, with its materials, and animated by the scroll, spin and squash channels it declares.
// buildRig (rig.ts) owns the rig. This owns the submeshes and hands back the hooks buildRig wires in.

import { Color, DoubleSide, Group, Mesh, MeshStandardMaterial, Quaternion, RepeatWrapping, Vector3 } from 'three'
import type { InstancedMesh, Material, Texture } from 'three'
import { getPackage } from '../../../core/parts/partRegistry'
import { evalPartGeometry, geometryAnimates, partDeclaredLamps, partHasGeometry, resolvePartParams } from '../../../core/geometry/geometryEval'
import type { GeometryContext, MeshDescription, MeshPart, ParamValue } from '../../../core/parts/partApi'
import type { PartAsset, PartMaterial, PartPackage, RigLink } from '../../../core/parts/partPackage'
import { arrayInstanceDeltas } from '../../../core/rig/rigPose'
import type { RigParams } from '../../../core/rig/rigPose'
import type { SdkPart } from '../../../core/types'
import { realizeMeshDescription, rewriteMeshDescription } from '../meshDescriptionGeometry'
import { boltMaterial, scrollMaterial, createBeltSurface, deckTriplanarMaterial, gapFillMaterial, guardMaterial, legMaterial, markTickUniformsAdvanced, railMaterial, rollerMaterial, shadowMesh } from '../common'
import { FN_NEUTRAL, descEqual } from './shared'
import { buildMaterial } from './materials'
import { realizeInstancedTemplate, writeInstanceMatricesHeld } from '../instancedTemplate'
import { acquireBeltBankMaterial, beltClockEpoch, releaseBeltBankMaterial, rebaseBeltScroll, rebaseBeltScrollForWrap, writeFabricBankAttributes, writeFabricBankScrolls } from '../beltFabricBank'
import { BELT_TEX_PERIOD } from '../common'
import { bumpRepaintEpoch, bumpStructureVersion } from '../structureRev'
import { retireGeometry, retireInstancedMesh, retireTexture } from '../../gpuRetire'
import { markLazyColliderBVH } from '../../bvh'
import { advanceBankSpins, bankSpinSign, spinUniformOf } from './bankSpin'
import type { BankSpin } from './bankSpin'
import { paintLamp, SQUASH_TAU } from './rigLamps'
import type { LampMat } from './rigLamps'

const _spinQ = new Quaternion()
const _spinV = new Vector3()

// MeshPart.squash: a geometry() submesh (or a whole instanced bank) compressed along its link's Y, anchored at its
// lowest point, the same ease and anchor as a mesh link's clones (applyMeshSquash in rig.ts).
type ProcSquash = { mesh: Mesh; frac: number; signal: string; anchorY: number; cur: number; target: number }
function applyProcSquash(s: ProcSquash): void {
  s.mesh.scale.y = 1 - s.frac * s.cur
  s.mesh.position.y = s.anchorY * s.frac * s.cur
}

/** What the procedural geometry needs from the rig it dresses. */
export interface ProcGeometryDeps {
  root: Group
  linkGroups: ReadonlyMap<string, Group>
  pkg: PartPackage
  paramSpecs: PartPackage['params']
  materials: readonly PartMaterial[]
  assets: readonly PartAsset[]
  /** every material the part owns, disposed with it: the submeshes' materials join it */
  allMaterials: Material[]
  /** the lamps the rig paints: a lamp submesh joins them */
  lampMats: LampMat[]
  bumpPoseRev: () => void
}

export interface ProcGeometry {
  /** whether the script's geometry() declares lamps, so the rig needs a lamp hook before the first emit */
  mayLight: boolean
  /** (re)emit geometry() for the part's current params and bed grid */
  realize(p: SdkPart, ctx: GeometryContext): void
  /** the scroll, spin and squash channels per frame; undefined when geometry() never animates */
  tick: ((dt: number, running: boolean) => boolean) | undefined
  /** the behavior's reported values while the sim runs (a program-commanded channel speed) */
  applyValues(v: Record<string, number | boolean>): void
  /** the per-tick lamp state: a squash channel compresses while its lamp is lit */
  setLampTargets(lamps: Record<string, boolean>): void
  /** the banks drawn once per instance of the posable array link `link` (its attached submeshes) */
  banksOn(link: string): InstancedMesh[]
  /** each conveying copy's belt speed (frame.copySpeeds), by link: a copy's belt fabric runs at its own speed */
  setCopySpeeds(speeds: Record<string, number[]>): void
  dispose(): void
}

export function createProcGeometry(deps: ProcGeometryDeps): ProcGeometry {
  const { root, linkGroups, pkg, paramSpecs, materials, assets, allMaterials, lampMats, bumpPoseRev } = deps
  // private texture copies minted for scroll channels (MeshPart.scroll). Not module-cached, so disposed with the part.
  const scrollTexClones: Texture[] = []
  // A geometry() submesh can squash too (MeshPart.squash): registered by the procedural refresh, eased by procTick.
  const procSquashes: ProcSquash[] = []
  // ---- geometry() animation channels: MeshPart.scroll (a texture moving along its U) and MeshPart.spin (a submesh
  // turning about an axis). A channel's speed is a reported value while the sim runs (applyValues: ctx.report, the
  // number the Inspector's live readout shows), so a program-commanded speed drives it; otherwise the part's param
  // of that name. The procedural refresh registers the channels as it emits the submeshes; the hook they run in has
  // to exist from the start, so it is built whenever the script's geometry() animates at its default params.
  // the posable array links (array.posable), whose attached submeshes draw once per instance
  const posableLinks = new Map<string, RigLink>(pkg.geometry.kind === 'rig' ? pkg.geometry.links.filter((l) => l.array?.posable).map((l) => [l.name, l]) : [])
  // A belt submesh (finish 'belt') on a posable conveying array is drawn as belt fabric (beltFabricBank.ts) whose
  // copies scroll at their own copy's belt speed: [base, rate] per copy, the shader integrating base + rate·clock, so
  // a copy's scroll is rewritten only when its speed changes or the clock wraps.
  const copyBelts: { link: string; mesh: InstancedMesh; base: Float64Array; rate: Float64Array; epoch: number }[] = []
  let copySpeeds: Record<string, number[]> = {}
  const conveyingCopies = [...posableLinks.values()].some((l) => l.conveys === true)
  const procMayAnimate = (partHasGeometry(pkg.behavior) && geometryAnimates(pkg.behavior, paramSpecs)) || conveyingCopies
  let liveValues: Record<string, number | boolean> | null = null
  let procResolved: Record<string, ParamValue> = {}
  // a scroll/spin channel names the param that turns it; left out, it is the conveyor's declared speed param
  // (conveyor.speedParam). A part that is no conveyor must name it (validatePart refuses one that doesn't), so
  // its empty key here only ever reads 0.
  const conveyorSpeedKey = pkg.conveyor?.speedParam
  const channelKey = (named: string | undefined): string => named ?? conveyorSpeedKey ?? ''
  const channelSpeed = (key: string): number => {
    if (key === '') return 0
    const live = liveValues?.[key]
    if (typeof live === 'number') return live
    const p = procResolved[key]
    return typeof p === 'number' ? p : 0
  }
  const procScrolls: { tex: Texture; src: Texture; srcVersion: number; tilesPerMeter: number; speed: string }[] = []
  const procSpins: { mesh: Mesh; axis: Vector3; center: Vector3; radius: number; speed: string; angle: number }[] = []
  const procBankSpins: BankSpin[] = [] // MeshPart.spin on an instanced bank: its material turns (bankSpin.ts)
  const procTick = procMayAnimate
    ? (dt: number, running: boolean): boolean => {
        if (!running) liveValues = null // a stale reported speed must not outlive the run
        // conveying copies' belts: a copy's rate follows its speed (0 while stopped, freezing it where it stands)
        const epoch = beltClockEpoch()
        for (const cb of copyBelts) {
          const speeds = copySpeeds[cb.link]
          let changed = false
          if (epoch !== cb.epoch) {
            for (let i = 0; i < cb.base.length; i++) cb.base[i] = rebaseBeltScrollForWrap(cb.base[i]!, cb.rate[i]!, epoch - cb.epoch)
            cb.epoch = epoch
            changed = true
          }
          for (let i = 0; i < cb.rate.length; i++) {
            // the weave walks backwards at the belt speed so the pattern moves along +u, the copy's +X
            const rate = running ? -(speeds?.[i] ?? 0) / BELT_TEX_PERIOD : 0
            if (rate === cb.rate[i]) continue
            cb.base[i] = rebaseBeltScroll(cb.base[i]!, cb.rate[i]!, rate)
            cb.rate[i] = rate
            changed = true
          }
          if (changed) writeFabricBankScrolls(cb.mesh, cb.base, cb.rate)
        }
        let scrolled = false
        for (const sc of procScrolls) {
          // the shared texture decoded after this part's copy was made: the copy shares its image, but only the
          // copy's own version makes the renderer upload it
          if (sc.src.version !== sc.srcVersion) {
            sc.srcVersion = sc.src.version
            if (sc.src.image) sc.tex.needsUpdate = true // never flag an upload before there is an image to upload
          }
          if (!running) continue
          const v = channelSpeed(sc.speed)
          if (v === 0) continue
          sc.tex.offset.x = (sc.tex.offset.x - v * sc.tilesPerMeter * dt) % 1 // the pattern moves toward +U
          scrolled = true
        }
        // the scroll uses the shared tick uniform group on WebGPU (scrollNodeMaterial.ts): a direct upload, no mark
        if (scrolled) markTickUniformsAdvanced()
        let spun = false
        if (running) {
          for (const sp of procSpins) {
            const v = channelSpeed(sp.speed)
            if (v === 0 || sp.radius <= 0) continue
            sp.angle = (sp.angle + (v / sp.radius) * dt) % (Math.PI * 2)
            _spinQ.setFromAxisAngle(sp.axis, sp.angle)
            sp.mesh.quaternion.copy(_spinQ)
            // turn about `center`, not the mesh origin: p' = q(p - c) + c, so the mesh sits at c - q c
            sp.mesh.position.copy(sp.center).sub(_spinV.copy(sp.center).applyQuaternion(_spinQ))
            spun = true
          }
        }
        // squash ease, the mesh links' rule (squashTick): toward the lamp while running, relaxed when stopped
        let squashed = false
        const k = 1 - Math.exp(-dt / SQUASH_TAU)
        for (const s of procSquashes) {
          const target = running ? s.target : 0
          if (s.cur === target) continue
          s.cur += (target - s.cur) * k
          if (Math.abs(target - s.cur) < 1e-3) s.cur = target
          applyProcSquash(s)
          squashed = true
        }
        if (spun || squashed) bumpPoseRev()
        // a spinning bank turns its material's spin uniform, which rides the shared tick group: no pose, no mark
        if (running && advanceBankSpins(procBankSpins, channelSpeed, dt)) markTickUniformsAdvanced()
        return spun || squashed
      }
    : undefined

  // ---- procedural rig-link geometry (MeshPart.link) ---------------------------------------------------------
  // A rig can be dressed by the part's geometry() output: each emitted MeshPart is realized into the group of
  // the rig link named by MeshPart.link (so it follows that link's joint/rest pose), or the rig root when
  // untagged. Collision still comes from the declarative link shapes (a `hidden` box = collision-only), so this
  // is render-only: the wire-mesh the built-in fence/gate draw over a solid barrier/leaf box. Each submesh's
  // material follows the same rules as the function tier (role / package material / a colorParam tint), so a
  // rig-dressed part looks identical to a function part. Lazy: a rig whose behavior declares no geometry()
  // does no work here (procDisabled latches after the first empty eval).
  const procRoleMat = (role: string): Material => {
    switch (role) {
      case 'frame': return railMaterial()
      case 'guard': return guardMaterial()
      case 'leg': return legMaterial()
      case 'bolt': return boltMaterial()
      case 'gapfill': return gapFillMaterial()
      case 'roller': return rollerMaterial()
      case 'belt': return createBeltSurface().material
      case 'deck': return deckTriplanarMaterial('deck')
      case 'tread': return deckTriplanarMaterial('tread')
      default: return FN_NEUTRAL()
    }
  }
  const procPkgMat = (id: string): Material => {
    const ref = materials.find((m) => m.id === id)
    return ref ? buildMaterial(ref, assets) : FN_NEUTRAL()
  }
  const procShared = new Map<string, Material>() // shared role/package materials (untinted submeshes)
  const procTintMats: { mat: MeshStandardMaterial; param: string; lamp?: LampMat }[] = []
  const procLampByName = new Map<string, MeshStandardMaterial>() // MeshPart.lamp: one material per lamp name
  const procTintByKey = new Map<string, MeshStandardMaterial>()
  const procScrollByKey = new Map<string, Material>() // MeshPart.scroll: one moving copy per (material, rate, speed)
  // DoubleSide variants for procedural rig submeshes (MeshPart.doubleSided) - own clone per base, like the
  // function tier; keeps shared role materials single-sided for the other links.
  const procDblVariants = new Map<Material, Material>()
  const asDoubleProc = (base: Material): Material => {
    let d = procDblVariants.get(base)
    if (!d) { d = base.clone(); d.side = DoubleSide; procDblVariants.set(base, d); allMaterials.push(d) }
    return d
  }
  const procBankSpinByKey = new Map<string, Material>() // spinning banks: one turning material per (material, radius, speed, sense)
  const procMatFor = (part: MeshPart): Material => {
    if (part.spin && part.instances) {
      // a spinning bank: its own material, whose object-space grain the tick turns about each instance's local Z
      // (bankSpin.ts). Shared by the banks that spin alike (a roller bed's bodies and its axle stubs).
      const sign = bankSpinSign(part.spin.axis)
      const speed = channelKey(part.spin.speed)
      const key = `${part.material ?? part.finish ?? 'mesh'}\0${part.spin.radius}\0${speed}\0${sign ?? 0}`
      let m = procBankSpinByKey.get(key)
      if (!m) {
        m = part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh')
        const uniform = spinUniformOf(m)
        if (uniform && sign !== null) procBankSpins.push({ uniform, radius: part.spin.radius, speed, sign, angle: 0 })
        procBankSpinByKey.set(key, m)
        allMaterials.push(m)
      }
      return m
    }
    if (part.scroll) {
      // its own material over its own copy of the albedo (the package texture is shared by every part that uses
      // it), whose offset the tick moves. On WebGPU a node material samples through live offset uniforms
      // (scrollMaterial), since three never re-uploads a plain material's uv transform there.
      const speed = channelKey(part.scroll.speed)
      const key = `${part.material ?? part.finish ?? 'mesh'}\0${part.scroll.tilesPerMeter}\0${speed}`
      let m = procScrollByKey.get(key)
      if (!m) {
        const base = (part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh').clone()) as MeshStandardMaterial
        if (base.map) {
          const tex = base.map.clone()
          tex.wrapS = RepeatWrapping
          tex.wrapT = RepeatWrapping
          // A URL texture is still loading when the part builds, and Texture.clone() (copy) flags the copy for upload
          // regardless, an upload with no image, which the renderer throws on. Hold it at version 0 (nothing to upload)
          // until there is an image; the tick flags it when the original's version moves.
          if (!base.map.image) tex.version = 0
          scrollTexClones.push(tex)
          m = scrollMaterial(base, tex)
          procScrolls.push({ tex, src: base.map, srcVersion: base.map.version, tilesPerMeter: part.scroll.tilesPerMeter, speed })
        } else {
          m = base // no texture: nothing to move, but still its own instance
        }
        procScrollByKey.set(key, m)
        allMaterials.push(m)
      }
      return m
    }
    const lamp = part.lamps?.[0]
    if (lamp) {
      // a lamp submesh: its own material, painted per tick by applyLamps (dark = its offColor else the material's
      // colour, lit = the emissive glow); a colorParam sets both, as it does for a mesh link's lamp
      let m = procLampByName.get(lamp.name)
      if (!m) {
        const base = part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh')
        m = (part.material ? base : base.clone()) as MeshStandardMaterial // finish materials are shared singletons
        if (lamp.offColor) m.color.setRGB(lamp.offColor[0], lamp.offColor[1], lamp.offColor[2])
        const e = lamp.emissive
        const lm: LampMat = { name: lamp.name, mat: m, color: new Color(e[0], e[1], e[2]), off: m.color.clone(), ...(lamp.opacity !== undefined ? { opacity: lamp.opacity } : {}) }
        lampMats.push(lm)
        if (part.colorParam) procTintMats.push({ mat: m, param: part.colorParam, lamp: lm })
        procLampByName.set(lamp.name, m)
        allMaterials.push(m)
      }
      return m
    }
    if (part.colorParam) {
      // a tinted submesh gets its own material instance (shared role/pkg materials must not be repainted),
      // identity-stable across refreshes so a colour edit re-tints in place instead of rebuilding the mesh
      const key = `${part.material ?? part.finish ?? 'mesh'}\0${part.colorParam}`
      let m = procTintByKey.get(key)
      if (!m) {
        m = (part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh')) as MeshStandardMaterial
        procTintByKey.set(key, m)
        procTintMats.push({ mat: m, param: part.colorParam })
        allMaterials.push(m)
      }
      return m
    }
    const key = part.material ? `m:${part.material}` : `r:${part.finish ?? 'mesh'}`
    let m = procShared.get(key)
    if (!m) {
      m = part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh')
      procShared.set(key, m)
      allMaterials.push(m)
    }
    return m
  }
  // one realized submesh per emitted MeshPart (stable emit order), holding its target group + desc + material so
  // a refresh reuses the slot when none changed - only a target/role/geometry change re-realizes (a colour edit
  // keeps every mesh and just repaints, exactly like buildFunctionMesh).
  const procSlots: { group: Group; mesh: Mesh; desc: MeshDescription; mat: Material }[] = []
  // MeshPart.instances banks: one InstancedMesh per emitted bank (stable emit order among the banks), the function
  // tier's realization (instancedTemplate.ts) hung on the bank's link group
  const procBanks: { group: Group; mesh: InstancedMesh; desc: MeshDescription; mat: Material; /** the shared bank material it holds a reference to (beltFabricBank.ts) */ bank: Material | null; perInstance?: string }[] = []
  let procKey = '' // last (behavior-source + resolved-params) key; re-emit only when it changes
  let procDisabled = false
  /** returns whether it actually removed anything (a draw-list change - see the bump below) */
  const clearProcSlots = (): boolean => {
    if (procSlots.length === 0 && procBanks.length === 0) return false
    // Retire, never dispose: a recorded render bundle holds this geometry's actual GPUBuffers, and
    // freeing them here would blank the whole main pass on replay. gpuRetire.ts holds each one
    // until a re-record has been requested and has run. The same applies to every procedural re-emit below,
    // since a resize drag runs this on every pointer-move.
    for (const s of procSlots) { s.group.remove(s.mesh); retireGeometry(s.mesh.geometry) }
    procSlots.length = 0
    for (const b of procBanks) { b.group.remove(b.mesh); retireInstancedMesh(b.mesh); releaseBeltBankMaterial(b.bank) }
    procBanks.length = 0
    return true
  }
  const realizeProceduralGeometry = (p: SdkPart, ctx: GeometryContext): void => {
    if (procDisabled) return
    const source = getPackage(p.packageId)?.behavior ?? pkg.behavior // fresh source so a geometry() hot-reload takes effect
    const resolved = resolvePartParams(paramSpecs, p.params as Record<string, ParamValue>)
    procResolved = resolved // the channels' fallback speed while no run reports one
    // The seam context is an input to geometry(), so every field of it belongs in the re-emit key alongside the
    // params. Otherwise a bed that slides along its own axis keeps the plate its old grid phase implied. Keyed
    // on the grid's endpoints + count (an arithmetic world-phase sequence, so those pin the whole array) and
    // the butt flags. The first refresh of a part runs before the scene resolve hands the rig its grid, so the
    // butt flags are the only thing that changes on the pass that learns the bed has a neighbour. Without them
    // that pass early-outs on an unchanged key and the seam geometry never appears. A part with no
    // world-phase bank contributes nothing here and keeps its param-only key, so nothing else re-emits more often.
    const d = ctx.deltas
    const b = ctx.butt
    const gridKey = d && d.length > 0 ? `${ctx.pitch ?? 0}|${d[0]![0]}|${d[d.length - 1]![0]}|${d.length}|${b?.head ? 1 : 0}${b?.tail ? 1 : 0}` : ''
    const key = `${source}\0${JSON.stringify(resolved)}\0${gridKey}`
    if (key === procKey) return
    procKey = key
    const emitted = evalPartGeometry(source, resolved, { partId: p.id, packageId: pkg.id }, ctx)
    // drop any meshes; latch off only when the part declares no geometry() at all. A geometry() that emitted
    // nothing for this param set (e.g. the transfer plate on a straight bed) must stay live so a later skew re-emits.
    if (!emitted) {
      if (clearProcSlots()) bumpStructureVersion(root)
      procDisabled = !partHasGeometry(source)
      return
    }
    // a submesh on a posable array link is drawn once per instance: a bank at the instances' rest places, which the
    // rig re-places as the behavior moves them (rigArrayPose.ts)
    const perInstance = new Set<MeshPart>()
    const drawn = emitted
      .filter((mp) => mp.desc.positions.length > 0) // drop empty descs (render-only roller banks)
      .map((mp) => {
        const link = mp.instances === undefined && mp.link ? posableLinks.get(mp.link) : undefined
        if (!link) return mp
        const rest = arrayInstanceDeltas(link.array!, resolved as RigParams, undefined, link.showParam)
        const banked: MeshPart = { ...mp, instances: rest.map((d) => ({ position: d })) }
        perInstance.add(banked)
        return banked
      })
    const parts = drawn.filter((mp) => mp.instances === undefined)
    const bankParts = drawn.filter((mp) => mp.instances !== undefined)
    // adding / swapping / dropping a submesh is a draw-list change; an unchanged slot is not (see the bump below)
    let structural = false
    // instanced banks first (their materials are minted by procMatFor like any submesh's). Reuse a slot when the
    // template, material and link are unchanged and the count still fits its buffer: only the transforms rewrite,
    // which a recorded bundle replays. A bank's count is baked into the recorded draw, so a count change is
    // structural; a new template or an outgrown buffer mints a fresh mesh.
    for (let i = 0; i < bankParts.length; i++) {
      const part = bankParts[i]!
      const insts = part.instances!
      const group = (part.link ? linkGroups.get(part.link) : undefined) ?? root
      const copyBelt = perInstance.has(part) && part.finish === 'belt' && posableLinks.get(part.link!)?.conveys === true
      // a slot holds one reference to its shared bank material (beltFabricBank.ts), released when it lets go. It
      // keeps it through a double-sided copy too, which procDblVariants caches by the bank material's identity.
      const bankMat = copyBelt ? acquireBeltBankMaterial('standard', '#ffffff') : null
      let mat = bankMat ?? procMatFor(part)
      if (part.doubleSided) {
        if (part.lamps?.length || part.colorParam || part.scroll || part.spin) mat.side = DoubleSide
        else mat = asDoubleProc(mat)
      }
      const slot = procBanks[i]
      if (slot && slot.group === group && slot.mat === mat && descEqual(slot.desc, part.desc) && insts.length <= slot.mesh.instanceMatrix.count) {
        releaseBeltBankMaterial(bankMat) // the slot already holds its reference
        // a bed sliding along its world grid gains and loses a roller as it goes: hold the drawn count (see there)
        if (writeInstanceMatricesHeld(slot.mesh, insts)) structural = true
        continue
      }
      structural = true
      if (slot) { slot.group.remove(slot.mesh); retireInstancedMesh(slot.mesh); releaseBeltBankMaterial(slot.bank) }
      const mesh = realizeInstancedTemplate(part.desc, insts, mat)
      if (part.castShadow === false) mesh.castShadow = false
      group.add(mesh)
      procBanks[i] = { group, mesh, desc: part.desc, mat, bank: bankMat }
    }
    for (let i = 0; i < bankParts.length; i++) procBanks[i]!.perInstance = perInstance.has(bankParts[i]!) ? bankParts[i]!.link : undefined
    // (re)attach the fabric attributes of each copy belt: its u tiles by the submesh's length along X (a builder box
    // maps u 0..1 across it), and a copy keeps its scroll phase and rate across a re-emit
    const keptBelts = new Map(copyBelts.map((cb) => [cb.mesh, cb] as const))
    copyBelts.length = 0
    for (let i = 0; i < bankParts.length; i++) {
      const part = bankParts[i]!
      const mesh = procBanks[i]!.mesh
      if (!(perInstance.has(part) && part.finish === 'belt' && posableLinks.get(part.link!)?.conveys === true)) continue
      const xs = part.desc.positions.filter((_, k) => k % 3 === 0)
      const uLen = xs.length ? Math.max(...xs) - Math.min(...xs) : 1
      const n = part.instances!.length
      writeFabricBankAttributes(mesh, part.instances!.map((t) => ({ ...t, data: [uLen, 0, 1, 0] })), 0, 0)
      const was = keptBelts.get(mesh)
      const cb = { link: part.link!, mesh, base: new Float64Array(n), rate: new Float64Array(n), epoch: beltClockEpoch() }
      if (was) {
        cb.base.set(was.base.subarray(0, Math.min(n, was.base.length)))
        cb.rate.set(was.rate.subarray(0, Math.min(n, was.rate.length)))
        cb.epoch = was.epoch
      }
      writeFabricBankScrolls(mesh, cb.base, cb.rate)
      copyBelts.push(cb)
    }
    for (let i = procBanks.length - 1; i >= bankParts.length; i--) {
      const b = procBanks.pop()!
      b.group.remove(b.mesh); retireInstancedMesh(b.mesh); releaseBeltBankMaterial(b.bank)
      structural = true
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const group = (part.link ? linkGroups.get(part.link) : undefined) ?? root
      let mat = procMatFor(part)
      // A lamp or tinted submesh already has its own material, and that instance is the one painted and retinted:
      // a double-sided clone of it would be what renders, and would never see the paint. Flip its side instead.
      if (part.doubleSided) {
        if (part.lamps?.length || part.colorParam || part.scroll) mat.side = DoubleSide
        else mat = asDoubleProc(mat)
      }
      const slot = procSlots[i]
      if (slot && slot.group === group && slot.mat === mat && descEqual(slot.desc, part.desc)) continue
      // Recycle first: a resize drag re-emits this on every pointer-move, and the usual re-emit is the
      // same topology at new coordinates. Rewriting the existing buffers frees nothing (so nothing can
      // be freed under a live recording) and keeps the recorded draw valid, so it needs no re-record
      // either - only a genuine topology change falls through to the swap (gpuRetire.ts).
      if (slot && slot.group === group && slot.mat === mat && rewriteMeshDescription(slot.mesh.geometry, part.desc)) {
        slot.desc = part.desc
        continue
      }
      structural = true
      if (slot) { slot.group.remove(slot.mesh); retireGeometry(slot.mesh.geometry) }
      const mesh = shadowMesh(realizeMeshDescription(part.desc), mat, part.castShadow !== false)
      // the pilot collides against this render mesh; let it build a tree when it does (bvh.ts)
      markLazyColliderBVH(mesh)
      group.add(mesh)
      procSlots[i] = { group, mesh, desc: part.desc, mat }
    }
    for (let i = procSlots.length - 1; i >= parts.length; i--) {
      const s = procSlots.pop()!
      s.group.remove(s.mesh); retireGeometry(s.mesh.geometry)
      structural = true
    }
    // spin channels: which slot meshes turn, and about what. Re-registered on every emit; a mesh keeps its angle,
    // and one that stopped spinning (its part changed) goes back to rest.
    const prevAngle = new Map(procSpins.map((sp) => [sp.mesh, sp.angle] as const))
    procSpins.length = 0
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!, mesh = procSlots[i]!.mesh
      if (part.spin) {
        const ax = new Vector3(part.spin.axis[0], part.spin.axis[1], part.spin.axis[2])
        if (ax.lengthSq() > 0) {
          const c = part.spin.center ?? [0, 0, 0]
          procSpins.push({ mesh, axis: ax.normalize(), center: new Vector3(c[0], c[1], c[2]), radius: part.spin.radius, speed: channelKey(part.spin.speed), angle: prevAngle.get(mesh) ?? 0 })
          continue
        }
      }
      if (prevAngle.has(mesh)) { mesh.quaternion.identity(); mesh.position.set(0, 0, 0) }
    }
    // squash channels: re-registered on every emit like the spins, a reused mesh keeping how far it is compressed (a
    // lit vacuum stays squashed across a resize). The anchor is the mesh's lowest point in its link's frame, which an
    // InstancedMesh's box measures across every instance. The pool must not bake a copy of a mesh that changes size.
    const prevSquash = new Map(procSquashes.map((s) => [s.mesh, s] as const))
    procSquashes.length = 0
    const squashed = [
      ...bankParts.map((part, i) => ({ part, mesh: procBanks[i]!.mesh as Mesh, bank: procBanks[i]!.mesh as InstancedMesh | null })),
      ...parts.map((part, i) => ({ part, mesh: procSlots[i]!.mesh, bank: null })),
    ]
    for (const { part, mesh, bank } of squashed) {
      const was = prevSquash.get(mesh)
      if (!part.squash || part.spin) {
        if (was) { mesh.scale.y = 1; mesh.position.y = 0; delete mesh.userData.poolMobile }
        continue
      }
      let minY: number | undefined
      if (bank) { bank.computeBoundingBox(); minY = bank.boundingBox?.min.y }
      else { mesh.geometry.computeBoundingBox(); minY = mesh.geometry.boundingBox?.min.y }
      const s: ProcSquash = { mesh, frac: part.squash.amount, signal: part.squash.lamp, anchorY: minY !== undefined && Number.isFinite(minY) ? minY : 0, cur: was?.cur ?? 0, target: was?.target ?? 0 }
      mesh.userData.poolMobile = true
      applyProcSquash(s)
      procSquashes.push(s)
    }
    // Pool opt-in, the function tier's rule (functionMesh.ts): identical dressing on identical parts (three racks,
    // two push buttons) merges in the scene-global pool, which matches by geometry content and folds each
    // source's geometry version into its bake, so the in-place rewrite above stays coherent. A submesh riding a
    // moving link is still kept live by that link's `poolMobile`. Out: a lamp (its material is painted per
    // tick) and the belt fabric (its own material, scrolled in place).
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      // ...and an animated one (MeshPart.scroll/spin): its texture or pose moves per part, which a merged copy can't
      if (part.lamps?.length || part.finish === 'belt' || part.scroll || part.spin || part.squash) delete procSlots[i]!.mesh.userData.poolUnit
      else procSlots[i]!.mesh.userData.poolUnit = true
    }
    // re-apply each colorParam tint from the resolved value (materials are identity-stable → in-place repaint)
    let repainted = false
    for (const t of procTintMats) {
      const v = resolved[t.param]
      if (typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
        const before = t.mat.color.getHex()
        if (t.lamp) {
          // a lamp: retint the unlit base and the glow, then repaint in its current state (lit keeps glowing)
          t.lamp.off.set(v.slice(0, 7))
          t.lamp.color.set(v.slice(0, 7))
          paintLamp(t.lamp, t.mat.emissiveIntensity > 0)
        } else {
          t.mat.color.set(v.slice(0, 7))
        }
        if (t.mat.color.getHex() !== before) repainted = true
      }
    }
    // A repaint moves render identity without moving the draw list: the bundle keeps drawing the right
    // pixels (same material object) and must not be re-recorded, but instancePool groups by a key that
    // includes colour, so its bake is stale. Hence the repaint epoch rather than a structural bump, and only
    // when a colour actually changed, so the common unchanged re-apply does nothing.
    if (repainted) bumpRepaintEpoch()
    // A recorded WebGPU render bundle bakes the draw list, so a mesh that entered/left/swapped here never
    // reaches the screen until something unrelated re-records (without the bump, the roller bed's skew transfer
    // plates would stay invisible after the edit that creates them; verify-roller-skew.mjs's live-edit check). Same rule (and
    // same seam) as the guard-split / deck-cut count changes (rigLayout.ts): bump the structural counter
    // view.syncBundleInvalidation polls. Only then: an unchanged re-emit (the common case, a param that
    // geometry() ignores) must not re-record, and a pure colorParam re-tint above is an in-place repaint,
    // not a draw-list change.
    if (structural) bumpStructureVersion(root)
  }

  return {
    mayLight: partHasGeometry(pkg.behavior) && partDeclaredLamps(pkg.behavior).length > 0,
    realize: realizeProceduralGeometry,
    tick: procTick,
    applyValues: (v) => { liveValues = v },
    setLampTargets: (lamps) => { for (const s of procSquashes) s.target = lamps[s.signal] === true ? 1 : 0 },
    banksOn: (link) => procBanks.filter((b) => b.perInstance === link).map((b) => b.mesh),
    setCopySpeeds: (speeds) => { copySpeeds = speeds },
    dispose: () => {
      clearProcSlots() // the submesh geometries (their materials are in allMaterials) and the bank materials they hold
      for (const t of scrollTexClones) retireTexture(t) // private scroll-channel texture copies (not the shared package texture)
    },
  }
}
