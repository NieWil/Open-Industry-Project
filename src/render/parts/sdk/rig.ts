import { Box3, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, EdgesGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial } from 'three'
import type { Material, Object3D, Texture } from 'three'
import { arrayInstanceDeltas, pitchCapMessage, resolvedBoxSize, resolvedCylinder, resolvedMeshScale, restQuatOf } from '../../../core/rig/rigPose'
import { reportPartDiagnostic } from '../../../core/parts/partDiagnostics'
import { rigPoseColumns, robotDeclOfScript, robotKinematicsOf } from '../../../core/robot/robotIk'
import type { SeamContext, SubPose } from '../../../core/rig/rigPose'
import type { RollerGrid } from '../../../core/conveyor/rollerGrid'
import type { RigParams } from '../../../core/rig/rigPose'
import { showParamShows } from '../../../core/rig/rigLinkBody'
import { resolvePartParams } from '../../../core/geometry/geometryEval'
import { rigInclineRad } from '../../../core/parts/partGeometry'
import type { GuardOpenings } from '../../../core/guards/guardOpenings'
import { rigFrameSide, rigGuardSide } from '../../../core/guards/guardOpenings'
import type { GuardExtents } from '../../../core/guards/guardExtents'
import type { LegRestRows } from '../../../core/legRests'
import type { GuardHoles } from '../../../core/guards/guardHoles'
import { isMultiInstance } from '../../../core/structureCuts'
import type { PlatformCut } from '../../../core/structureCuts'
import type { GeometryContext, ParamValue } from '../../../core/parts/partApi'
import type { MeshUvTile, PartAsset, PartMaterial, PartPackage, RigLink, RigShape, Vec3Tuple } from '../../../core/parts/partPackage'
import { subPosedLinkNames } from '../../../core/parts/partPackage'
import type { SdkPart } from '../../../core/types'
import { boltMaterial, createBeltSurface, createDeckSurface, createLegSet, disposeLegSet, gapFillMaterial, guardMaterial, legMaterial, railMaterial, ROLLER_MODEL_RADIUS, rollerMaterial, rollerSpinTick, unitBox } from '../common'
import type { DeckSurface, WalkFinish } from '../common'
import { removeSensorBeam } from '../../sensorBeamOverlay'
import type { Content } from './types'
import { FN_NEUTRAL } from './shared'
import { attachMesh, buildMaterial, loadMeshAsset, prepareMeshInstance } from './materials'
import type { CarvedMeshShape } from './materials'
import { drawnElsewhere } from '../../../core/glbBox'
import { LampBank, lampBankMaterial } from '../lampBank'
import type { LampSlot } from '../lampBank'
import { LinkBank } from '../linkBank'
import type { LinkSlot } from '../linkBank'
import { bumpStructureVersion } from '../structureRev'
import { retireGeometry, retireInstancedMeshOnly, retireTexture } from '../../gpuRetire'
import { bumpPoseRev as bumpVisualPoseRev } from '../poseRev'
import { buildRigGizmo } from './rigGizmo'
import { paintLamp, SQUASH_TAU } from './rigLamps'
import type { LampMat } from './rigLamps'
import { createProcGeometry } from './rigProcedural'
import { createRigPlacement } from './rigPlacement'
import { placePosedArray } from './rigArrayPose'
import type { PosedArray } from './rigArrayPose'
import { createRigBeams } from './rigBeams'
import { addLabelPlane, paintLabelPlates } from './rigLabels'
import type { RigLabel } from './rigLabels'
import { layoutArrayLink, layoutDeckCut, layoutGuardSplit, layoutLegs, releaseGuardSplit } from './rigLayout'
import type { DeckCutLink, GuardSplitLink, InstancedArrayLink, LegLink } from './rigLayout'

// ---- rig -----------------------------------------------------------------

const unitCylinder = new CylinderGeometry(1, 1, 1, 16) // axis +Y, scale (r, h, r)
// A large cylinder (a turntable's deck plate and drum, ~1.1 m across) shows every one of 16 facets as a flat
// panel on its rim; 64 reads round at that size. Picked from the authored radius, once, at build (a sizeParams
// radius rescales the same mesh). Shared like unitCylinder, so copies still pool and the draw count is unchanged.
const unitCylinderFine = new CylinderGeometry(1, 1, 1, 64)
const FINE_CYLINDER_RADIUS = 0.2
const cylinderGeoFor = (radius: number): CylinderGeometry => (radius >= FINE_CYLINDER_RADIUS ? unitCylinderFine : unitCylinder)
const unitCone = new ConeGeometry(1, 1, 20) // apex +Y, base −Y, scale (r, h, r) - a downward cue rotates the link
const LAMP_OFF_COLOR = 0x2a2d31 // dark neutral an unlit lamp link shows when its lamp authors no `offColor`

/**
 * Rendered roller radius (m) of a rig's spinning-roller links. The no-slip visual spin rate is
 * speed / radius, so the spin tick must divide by the radius the rollers are drawn at: a 'roller'-finish
 * cylinder draws at its own (param-resolved) radius; a 'roller'-finish mesh keeps the model's native radius.
 */
export function rigRollerSpinRadius(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, params: RigParams): number {
  for (const l of geo.links) {
    if (l.finish === 'roller' && l.shape.kind === 'cylinder') return resolvedCylinder(l.shape, params).radius
  }
  return ROLLER_MODEL_RADIUS
}

function linkMesh(shape: Exclude<RigShape, { kind: 'mesh' } | { kind: 'frame' } | { kind: 'label' } | { kind: 'roller' } | { kind: 'leg' }>, material: Material): Mesh {
  const mesh = shape.kind === 'cylinder' ? new Mesh(cylinderGeoFor(shape.radius), material) : shape.kind === 'cone' ? new Mesh(unitCone, material) : new Mesh(unitBox, material)
  if (shape.kind === 'cylinder' || shape.kind === 'cone') mesh.scale.set(shape.radius, shape.height, shape.radius)
  else mesh.scale.set(shape.size[0], shape.size[1], shape.size[2])
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

// ---- arrayed mesh links ---------------------------------------------------
// buildRig's entry type for an arrayed mesh link and its closure-free rebuild helpers. Field semantics are
// documented at the entry array inside buildRig.

type MeshArrayLink = { group: Group; array: NonNullable<RigLink['array']>; showParam?: string; shape: Extract<RigShape, { kind: 'mesh' }>; template: Object3D | null; instances: Object3D[]; name: string; squash?: { frac: number; signal: string; anchorY: number; restY: number[]; cur: number; target: number } }

// tileUv (RigMeshShape.tileUv): a stretched GLB member re-tiles its repeating texture instead of smearing it.
// Each matching mesh gets an owned geometry copy whose UV channel is the model's own times the stretch factor,
// rewritten in place on a param change (the attribute version bump is what the instance pool re-bakes on).
interface TiledMesh { tile: MeshUvTile; geo: BufferGeometry; base: Float32Array; attr: Float32BufferAttribute; k: number }
interface TiledMeshLink { sizeParams: NonNullable<Extract<RigShape, { kind: 'mesh' }>['sizeParams']>; tiles: MeshUvTile[]; meshes: TiledMesh[] }

function collectTiledMeshes(entry: TiledMeshLink, inst: Object3D): void {
  inst.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    const name = m.userData.glbMaterial as string | undefined
    const tile = name === undefined ? undefined : entry.tiles.find((t) => t.materials.includes(name))
    const uv = m.geometry.getAttribute('uv')
    if (!tile || !uv) return
    // an owned copy: the loaded geometry is shared by every part using this GLB, so rewriting its UVs in
    // place would re-tile them all at this part's length. Plain float UVs, because a quantized source
    // attribute (normalized ints) cannot hold a coordinate past 1.
    const geo = m.geometry.clone()
    const base = new Float32Array(uv.count * 2)
    for (let i = 0; i < uv.count; i++) { base[i * 2] = uv.getX(i); base[i * 2 + 1] = uv.getY(i) }
    const attr = new Float32BufferAttribute(base.slice(), 2)
    geo.setAttribute('uv', attr)
    m.geometry = geo
    entry.meshes.push({ tile, geo, base, attr, k: 1 })
  })
}

function applyTiledMeshes(entry: TiledMeshLink, params: RigParams): void {
  const f = resolvedMeshScale(entry.sizeParams, params)
  for (const tm of entry.meshes) {
    const k = f[tm.tile.axis]
    if (k === tm.k) continue // unchanged: no rewrite, no version bump, no pool re-bake
    tm.k = k
    const arr = tm.attr.array as Float32Array
    for (let i = tm.tile.uv === 'u' ? 0 : 1; i < arr.length; i += 2) arr[i] = tm.base[i]! * k
    tm.attr.needsUpdate = true
  }
}

// squash: compress every clone along local Y by `frac·cur`, anchored at the cup rim (anchorY) so the
// contact lip that meets the workpiece stays put and the bellows fold up toward the mount - the box the
// vacuum grips stays sealed against the lip instead of the lip springing off it. newY = restY + anchorY·frac·cur.
function applyMeshSquash(entry: MeshArrayLink): void {
  const s = entry.squash
  if (!s) return
  const scaleY = 1 - s.frac * s.cur
  const shift = s.anchorY * s.frac * s.cur // keep local y = anchorY fixed as scaleY shrinks
  for (let i = 0; i < entry.instances.length; i++) {
    const inst = entry.instances[i]!
    inst.scale.y = scaleY
    inst.position.y = (s.restY[i] ?? inst.position.y) + shift
  }
}
// (Re)build an arrayed mesh link's clones at each array delta. Shared with the async-load path.
function rebuildMeshArray(entry: MeshArrayLink, params: RigParams, seam: SeamContext | undefined): void {
  if (!entry.template) return
  const deltas = arrayInstanceDeltas(entry.array, params, seam, entry.showParam)
  while (entry.instances.length < deltas.length) {
    const inst = entry.template.clone(true)
    entry.group.add(inst)
    entry.instances.push(inst)
  }
  while (entry.instances.length > deltas.length) entry.group.remove(entry.instances.pop()!)
  // delta is relative to the template's own prepared position (0 for a node ref; a whole-scene ref may
  // carry a fitHeight centring offset the clones must keep)
  const base = entry.template.position
  for (let i = 0; i < deltas.length; i++) entry.instances[i]!.position.set(base.x + deltas[i]![0], base.y + deltas[i]![1], base.z + deltas[i]![2])
  // snapshot the rest layout + replay the current squash (a lit vacuum keeps its cups compressed across a
  // param edit that re-lays the grid)
  if (entry.squash) {
    entry.squash.restY = entry.instances.map((inst) => inst.position.y)
    applyMeshSquash(entry)
  }
}


// ---- rig build -------------------------------------------------------------

export function buildRig(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, root: Group, assets: readonly PartAsset[], materials: readonly PartMaterial[], paramSpecs: PartPackage['params'], pkg: PartPackage): Content {
  const fallback = new MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.4, roughness: 0.5 })
  const matById = new Map(materials.map((m) => [m.id, buildMaterial(m, assets)]))
  const allMaterials: Material[] = [fallback, ...matById.values()]
  // a primitive link's `color` gives it its own tinted material (vs the shared gray fallback); disposed with the
  // rest. `metalness`/`roughness` override the default gloss (0.3/0.6) - a link mirroring a built-in's flat
  // non-metallic steel passes 0/0.8 so it shows its albedo instead of the environment reflection.
  const colorMaterial = (c: Vec3Tuple, metalness = 0.3, roughness = 0.6): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ color: new Color(c[0], c[1], c[2]), metalness, roughness })
    allMaterials.push(m)
    return m
  }
  // C-paramgeo colour: a link tinted by a `color` param (link.colorParam) gets its own material, re-tinted live
  // in refresh from the current param value - the same in-place repaint the belt's beltColor / a MeshPart's
  // colorParam get, generalized to a rig primitive. Seeded from the static `color` (else the neutral fallback)
  // so the first frame is right before refresh resolves the param. The refresh reads the hex as sRGB
  // (`.color.set`), matching the built-in barriers' `mat.color.set('#f2bd0f')`.
  // a mesh-lamp entry also carries its LampMat (`lamp`): the param then drives the lamp's unlit base and lit
  // colour together (the push button's `button color`: albedo = emission = button_color)
  const colorParamMats: { mat: MeshStandardMaterial; param: string; lamp?: LampMat }[] = []
  const colorParamMaterial = (param: string, base?: Vec3Tuple, metalness = 0.3, roughness = 0.6): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ color: base ? new Color(base[0], base[1], base[2]) : new Color(0x9aa3ad), metalness, roughness })
    allMaterials.push(m)
    colorParamMats.push({ mat: m, param })
    return m
  }
  // link role materials - the same textured metal/fabric the built-in conveyors use (railMaterial/guardMaterial/
  // legMaterial/boltMaterial/rollerMaterial + the scrolling belt fabric), so a rig SDK conveyor reads identically
  // to its built-in. Created lazily + cached per finish; the 'roller' materials are collected for the spin tick.
  const roleMats = new Map<string, Material>()
  const rollerMats: MeshStandardMaterial[] = []
  // finish:'tread' / 'deck' - the walking surfaces (steel tread plate, solid concrete deck), whose texture tiles per
  // metre. Every box link wearing one gets its own DeckSurface (deckSizeLinks), tiled from that link's resolved size
  // by its broad face: a stair's treads, risers and landing are three sizes, and one shared tiling would squeeze the
  // lugs on all but the link that set it last. The maps behind them are shared app-wide, so a surface adds one
  // material and no texture. A mesh link has no box size to tile by: it shares one surface per finish at the default tiling.
  const deckSurfaces: DeckSurface[] = []
  const newDeckSurface = (kind: WalkFinish): DeckSurface => {
    const s = createDeckSurface(kind)
    allMaterials.push(s.material)
    deckSurfaces.push(s)
    return s
  }
  const meshDeckSurfaces = new Map<WalkFinish, DeckSurface>()
  const deckSizeLinks: { size: Vec3Tuple; sizeParams?: Extract<RigShape, { kind: 'box' }>['sizeParams']; surface: DeckSurface }[] = []
  /** a box link's own walking-surface material, tiled from its size; null when the link wears no walking finish */
  const walkMaterial = (link: RigLink): Material | null => {
    if ((link.finish !== 'deck' && link.finish !== 'tread') || link.shape.kind !== 'box') return null
    const surface = newDeckSurface(link.finish)
    surface.setBoxExtent(link.shape.size) // the unparameterised size; refresh re-tiles a sizeParams box
    deckSizeLinks.push({ size: link.shape.size, ...(link.shape.sizeParams ? { sizeParams: link.shape.sizeParams } : {}), surface })
    return surface.material
  }
  const roleMaterial = (role: NonNullable<RigLink['finish']>): Material => {
    if (role === 'deck' || role === 'tread') {
      let s = meshDeckSurfaces.get(role)
      if (!s) meshDeckSurfaces.set(role, (s = newDeckSurface(role)))
      return s.material
    }
    let m = roleMats.get(role)
    if (!m) {
      if (role === 'belt') { const b = createBeltSurface(); b.material.side = DoubleSide; m = b.material }
      else if (role === 'roller') { const rm = rollerMaterial(); rollerMats.push(rm); m = rm }
      else m = role === 'frame' ? railMaterial() : role === 'guard' ? guardMaterial() : role === 'leg' ? legMaterial() : role === 'gapfill' ? gapFillMaterial() : role === 'mesh' ? FN_NEUTRAL() : boltMaterial()
      if (role === 'frame' || role === 'guard' || role === 'gapfill') m.side = DoubleSide
      allMaterials.push(m)
      roleMats.set(role, m)
    }
    return m
  }
  const linkGroups = new Map<string, Group>()
  const linkByName = new Map(geo.links.map((l) => [l.name, l]))
  const jointedLinks = new Set(geo.joints.map((j) => j.link))
  // A link nothing moves at runtime can pool across parts (the scene-global instance pool ingests plain
  // tagged meshes - see instancePool poolUnit); the pool bakes world matrices at rebuild time, so a link
  // that does move must render live or its pooled copy sits at rest while the real one travels. What
  // moves a link: a joint, an aim constraint, and a behavior's setSubPose by name (the push button's cap
  // depressing), which no geometry field declares. A dynamically-named call can't be resolved statically
  // and conservatively grounds the whole rig (subPosedLinkNames).
  const subPosed = subPosedLinkNames(pkg.behavior)
  const mobileLink = (l: RigLink): boolean => jointedLinks.has(l.name) || !!l.aim || !!l.array?.posable || subPosed.unresolved || subPosed.names.has(l.name)
  // Per link, not per rig: a whole-rig rule lets one joint keep every link of the part out, including
  // hardware that never moves (the turntable's legs, feet and base frame, a blade stop's housing). What
  // makes that safe is `poolMobile` below: a mobile link's group
  // carries it and instancePool.collectEligible prunes the whole subtree, so a static link riding a
  // moving one (the turntable's deck-mounted motor, a child of the rotating deck) stays live whatever
  // its own tag says. Link groups nest by `parent` (the pass after this loop), so the subtree IS the
  // kinematic chain.
  const poolableLink = (l: RigLink): boolean => !mobileLink(l)
  // The same rule applies to the instanced banks a link builds (array links). `poolUnit` above is an opt-in the
  // pool reads off plain meshes, so withholding it is enough there. A bank is an InstancedMesh, which the pool
  // ingests on sight, so a mobile link needs an opt-out of its own. `poolMobile` on the link group makes
  // instancePool.collectEligible prune the whole subtree, which covers a bank hanging off a jointed link's child.
  // Example: the turntable's holders + rim bolts are children of the roller link, which is a child of the rotating
  // deck. Pooled, they would stand still at the last-baked deck angle while the rollers (exempt via their spin
  // material) turn with the platter.
  // GLB node names each rendered by their own mesh link - so a parent node ref drops just these (its articulated
  // sub-nodes), keeping its own primitive meshes (see attachMesh's child-drop).
  const referencedNodes = new Set(geo.links.flatMap((l) => (l.shape.kind === 'mesh' && l.shape.node ? [l.shape.node] : [])))
  // param-driven box links (C-paramgeo): their mesh rescales on each refresh from the instance params
  const paramBoxes: { mesh: Mesh; size: Vec3Tuple; sizeParams: NonNullable<Extract<RigShape, { kind: 'box' }>['sizeParams']> }[] = []
  // splittable side box links on a straight roller/face-handle conveyor, remapped along local X in refresh:
  // a guard (role:'guard') gets gaps cut by a butting neighbour (host-computed openings) and its end span
  // remapped by the part's own snap extents; a frame rail (role:'frame' wall/flange, `frame: true`) takes
  // extents only - the host frame never opens, a flush side-merge instead retracts the
  // mover's rails to the host's outer wall plane (guardExtents, the spur extension mirrored). Built as one
  // box by default (a paramBox would do the same); refresh rebuilds each into the kept segments. `children`
  // is the live box-per-segment pool; the first child is the box `linkMesh` already made, extras cloned on
  // demand. A guard sheet (a link tall enough to hold a sensor-beam hole) is also split around each hole on its
  // side (guardHoles.ts), and `panels` is the pool of holed plates that fill those gaps; `offsetY` is the link's
  // centre height, which is how a sheet is told from the thin top return above it (which stays whole).
  const guardSplitLinks: GuardSplitLink[] = []
  // stair→platform structure-cut deck pool (docs/part-snap-stairs.md): a notchable box link's children are
  // (re)laid out per refresh as the complement strips around the cut's deck notches (deckStripRects - the same
  // pure rects the sim carves its colliders from), the 2-axis twin of guardSplitLinks. No cut ⇒ one full-size
  // child, identical to the plain param-box rescale it replaces. Done in place like the conveyor guard cut, so a
  // stair sliding along a deck edge never tears the rig down (a full rebuild per pointer-move causes snap lag). The railing half of the cut rides instancedArrayLinks (see `railing` there).
  // `walk`/`strips`: a walking-surface deck tiles each strip by its own size, so strip i wears strips[i] (strip 0 the
  // link's own surface; more are minted as a cut adds strips, and kept for reuse when it removes them)
  const deckCutLinks: DeckCutLink[] = []
  // param-driven cylinder links (C-paramgeo): radius/height track a param (a roller's axle-length = belt width)
  const paramCylinders: { mesh: Mesh; shape: Extract<RigShape, { kind: 'cylinder' }> }[] = []
  // node scaling: a mesh-node link whose group stretches per-axis from a param (a GLB section that grows with a
  // width/length param). The factor multiplies the link group's scale (atop the node's fitHeight/scale base).
  const paramMeshes: { group: Group; sizeParams: NonNullable<Extract<RigShape, { kind: 'mesh' }>['sizeParams']> }[] = []
  // ...and those of them that re-tile a repeating texture along the stretch instead of smearing it (tileUv)
  const tiledMeshLinks: TiledMeshLink[] = []
  // a param-driven offset (C-paramgeo) or a whole-bed incline makes the refresh re-place the links (placeLinks)
  const paramPose = !!geo.inclineParam || geo.links.some((l) => !!l.offsetParams || !!l.rotationParams)
  // C-emissive: a link with a lamp (`lamps`) gets its own material so it can be lit per-tick. `off` is the
  // colour shown when dark - the lamp's authored `offColor` (its unlit albedo) else LAMP_OFF for a primitive, or a
  // mesh lamp's base (remapped) colour so e.g. a push-button cap reads as its matte colour when unlit, not a
  // dead grey. `opacity` (the lamp's own) makes the lit state translucent - a tinted lens over an inner
  // core, the built-in stack light's optics; off stays opaque.
  const lampMats: LampMat[] = []
  // showParam links: a param gates the whole link's visibility (a structural side-guard toggle, a robot's own hand). Refresh
  // sets group.visible from the resolved param; the sim skips its collision body in parallel (world.buildRigBodies).
  const showParamLinks: { group: Group; param: string }[] = []
  // array-links: a count-driven primitive link (box/cylinder/cone) whose N copies share one uniform scale and
  // vary only in position - a bed of rollers/stubs, a platform's railing posts + support-column grid, a rack's
  // shelves + uprights, a stair's treads. Every such link collapses into one InstancedMesh (built-in instanced-draw
  // parity - a couple of draw calls no matter the count, not N separate meshes). `cast` skips the
  // shadow pass for tiny hardware (the axle stubs) that gives no useful self-shadow; structural arrays cast like
  // the built-ins did. The pool is created lazily on the first refresh.
  // `railing` marks a platform-perimeter link the stair→platform structure cut reshapes in place per refresh
  // (docs/part-snap-stairs.md): a post run (multi-instance array) drops instances in the railing gap + gains a
  // framing post at each gap edge (cutPostDeltas - shared with the sim's collider rewrite); a rail/toe box
  // (bare-gate or no array → `segment`) is laid out as one instance per kept segment with per-instance length.
  const instancedArrayLinks: InstancedArrayLink[] = []
  // kind:'leg' links: the built-in dual-post steel trestle (createLegSet + legStations + writeLegs), auto-spaced
  // along the spanParam length and reflowed on width/length change, the same legs the built-in parts use.
  const legLinks: LegLink[] = []
  // arrayed mesh links: the prepared GLB instance is a template cloned per array delta, (re)built in refresh -
  // the EOAT suction-cup grid (a `grid` array on a mesh link). Clones share the template's geometry/materials,
  // so a lamp material tint (the vacuum-on green) lights every cup at once.
  // `squash` (link.squash): while its driving lamp (`signal` = squash.lamp or the link's own lamp) is lit,
  // the clones compress along local Y anchored at the cup's rim (anchorY = template min-Y bound) - the vacuum
  // bellows collapsing while the contact lip stays seated on the workpiece. `restY` snapshots each clone's laid-out y so the eased scale/shift replays on top of the
  // rebuilt layout; `cur`→`target` (0..1) is eased by the tick; `signal` routes the lamp state to it (applyLamps).
  const meshArrayLinks: MeshArrayLink[] = []
  // the last refreshed params/seam, so a GLB that resolves after the first refresh lays its instances out on the
  // right grid (the async load can't see refresh's locals otherwise).
  let lastParams: RigParams = {}
  let lastSeam: SeamContext | undefined
  // the last applied neighbour-cut inputs (guard openings + platform structure cut). A change reshapes draws
  // that live inside a recorded WebGPU render bundle (instanced segment/post counts, strip children) on a part
  // that is not being dragged, so it was never bundle-ejected. Without a structural bump the bundle keeps
  // replaying the old railing/deck (the hole never closes until a dev restart). One bump per cut change.
  let lastCutKey = ''
  // C-label: render-only text planes (3D labels). Each carries a CanvasTexture redrawn on
  // refresh from a static `text` or a `textParam` (Inspector-editable); the plane hides when the text is empty.
  const labels: RigLabel[] = []
  const labelDisposables: (Texture | Material | BufferGeometry)[] = []
  // the display values last routed from the running frame (ctx.display) - what a live `textFrom` caption
  // shows. A name absent from the bag falls back to the authored plate, so a stopped scene reads as the
  // engraved legend rather than going blank.
  let displayValues: Readonly<Record<string, number | boolean | string>> = {}
  // per-link wireframe outline geometries (link.outline) - their LineBasicMaterial goes in allMaterials; these
  // EdgesGeometry buffers are per-instance and disposed with the part.
  const edgeGeoms: BufferGeometry[] = []
  // Pool opt-in for a static rig's GLB mesh links: the scene's repeated dressing (photo-eyes, push
  // buttons, beacons, bollards). A mesh link is an async-loaded subtree, not one mesh, so its leaves are
  // tagged. The pool ingests each as one instance at its world matrix (the same plain-mesh path the
  // primitives use). prepareMeshInstance's clone() shares the loaded geometry and the GLB's own materials
  // across parts, so N copies of one asset collapse to one draw per primitive. The saving grows with the
  // scene: 4 sensors are a dozen draws, a real plant layout's dressing is hundreds.
  //
  // Tagged per leaf, not per link, because one GLB link mixes materials this part mutates at runtime with the
  // GLB's own untouched ones (`shape.materials` remaps a single cap to a package lamp material). A
  // link-level test would either pool that lamp (its per-tick repaint would change its twins' colour
  // and churn the pool signature, which folds the tint, on every toggle) or exclude a whole housing
  // over one cap. `colorParam` tints are included, like the primitives: the merge key and the signature both
  // fold colour, so a repainted part regroups instead. Transparent leaves stay out (per-mesh draw
  // order); a leaf with children stays out (the pool copy clones none) while its children still tag.
  const tagPoolLeaves = (inst: Object3D): void => {
    inst.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh || m.children.length > 0) return
      const mat = m.material
      if (Array.isArray(mat) || !mat || mat.transparent === true) return
      if (lampMats.some((l) => l.mat === mat)) return // lit per tick - see above
      m.userData.poolUnit = true
    })
  }
  // Lamp banks (lampBank.ts): primitive lamp links that share a unit geometry and a parent link draw as the
  // instances of one InstancedMesh instead of a mesh + material each. A stack light's 8 lens tiers are one
  // draw, not 8 (5 of them zero-height slivers). Per-instance colour/glow/opacity carry what paintLamp
  // writes on a material. Only where two or more share a bank (a lone LED keeps its plain mesh), and never a
  // link whose own draw state the bank can't express per instance: a mobile link (FK places it per frame),
  // an author-hidden or showParam-gated one (a bank can't hide one instance), edges (the outline child), a
  // finish/side-wall/notchable/railing link (their own layout paths), or an array.
  const lampGeoOf = (shape: RigShape): BufferGeometry => (shape.kind === 'cylinder' ? cylinderGeoFor(shape.radius) : shape.kind === 'cone' ? unitCone : unitBox)
  const lampBankGroups = new Map<string, string[]>()
  for (const l of geo.links) {
    if (!l.lamps?.length || l.array || l.outline || l.hidden || l.showParam || l.finish || l.sideGuard || l.sideRail || l.notchable || l.onEdge || mobileLink(l)) continue
    if (l.shape.kind !== 'cylinder' && l.shape.kind !== 'cone' && l.shape.kind !== 'box') continue
    const key = `${l.parent ?? ''}|${lampGeoOf(l.shape).uuid}`
    const names = lampBankGroups.get(key)
    if (names) names.push(l.name)
    else lampBankGroups.set(key, [l.name])
  }
  const lampBanked = new Set([...lampBankGroups.values()].filter((n) => n.length >= 2).flat())
  // a banked link's unit-primitive mesh, kept out of the scene: refresh's param sizing still scales it, and
  // its bank reads the scale from it (LampSlot.shape)
  const lampCarriers = new Map<string, Mesh>()
  // Link banks (linkBank.ts): plain decorative primitive links riding a moving link (the turntable's deck-
  // mounted gearmotor, 31 painted pieces on a pivot that turns with the deck) that share a parent, a unit
  // geometry and a look draw as the instances of one InstancedMesh hung off that parent, which carries them
  // through the joint's motion. Only where the scene-global pool can't reach: a link nothing moves is left
  // to the pool (which merges across parts, and this can't), and a link that moves itself can't share its
  // parent's frame. Allow-listed, not excluded: a link banks only when it is nothing but a painted shape -
  // `collision: 'none'` decoration with no finish, lamp, cue, visibility gate, beam, zone or grab - so any link
  // feature the bank can't express, including one added later, keeps its own mesh by default.
  const BANKABLE_KEYS = new Set(['name', 'parent', 'shape', 'offset', 'rotation', 'quat', 'offsetParams', 'color', 'metalness', 'roughness', 'collision'])
  const ridesMobile = (l: RigLink): boolean => {
    for (let p = l.parent ? linkByName.get(l.parent) : undefined; p; p = p.parent ? linkByName.get(p.parent) : undefined) if (mobileLink(p)) return true
    return false
  }
  const linkBankKey = (l: RigLink): string | null => {
    if (l.collision !== 'none' || mobileLink(l) || !ridesMobile(l)) return null
    if (l.shape.kind !== 'box' && l.shape.kind !== 'cylinder' && l.shape.kind !== 'cone') return null
    if (Object.keys(l).some((k) => !BANKABLE_KEYS.has(k))) return null
    const look = l.color ? `${l.color.join(',')}|${l.metalness ?? ''}|${l.roughness ?? ''}` : 'fallback'
    return `${l.parent}|${lampGeoOf(l.shape).uuid}|${look}`
  }
  const linkBankGroups = new Map<string, string[]>()
  for (const l of geo.links) {
    const key = linkBankKey(l)
    if (key === null) continue
    const names = linkBankGroups.get(key)
    if (names) names.push(l.name)
    else linkBankGroups.set(key, [l.name])
  }
  // banked link → its bank key (groups of two or more; a lone piece keeps its plain mesh)
  const linkBanked = new Map([...linkBankGroups].filter(([, n]) => n.length >= 2).flatMap(([key, n]) => n.map((name) => [name, key] as const)))
  const linkBankMats = new Map<string, Material>() // one material per bank: its members share a look by construction
  const linkCarriers = new Map<string, Mesh>() // like lampCarriers: the detached unit mesh refresh still scales
  for (const link of geo.links) {
    const g = new Group()
    g.userData.linkName = link.name
    // FK moves this group every frame ⇒ nothing under it may merge into the world-space instance pool
    if (mobileLink(link)) g.userData.poolMobile = true
    // author-mode visibility toggle (Scene-tree eye): hide this link's render group (and its subtree); the
    // sim/collision body is still built (render-only, like a frame/label link the other way round).
    if (link.hidden) {
      g.visible = false
      g.userData.authorHidden = true
      // ...and because the body IS built, the hidden link is still solid to the walking pilot, whose wall
      // rays test render meshes and would otherwise pass straight through it. A platform railing is the case
      // that matters: the rails/posts/toe board are decoration (collision: 'none') and the barrier is this hidden
      // wall, so without the flag the pilot walks off the deck between the rails. `collision: 'none'` opts out -
      // a hidden link with no body (the safety gate's full-span `interact` Use volume) must stay walk-through.
      if (link.collision !== 'none') g.userData.collisionSolid = true
    }
    // param-gated structural toggle: refresh sets g.visible from the boolean param (the sim drops the body to match)
    if (link.showParam) showParamLinks.push({ group: g, param: link.showParam })
    if (link.shape.kind === 'label') {
      addLabelPlane(link.shape, g, labels, labelDisposables)
    }
    else if (link.shape.kind === 'mesh') {
      // the GLB nodes other links of this asset keep are theirs to draw, not this link's
      const elsewhere = drawnElsewhere(geo.links, link)
      const meshShape: CarvedMeshShape = elsewhere ? { ...link.shape, drawnElsewhere: elsewhere } : link.shape
      // a finish overrides the GLB's own material with the host conveyor material (e.g. a 'roller'-finish GLB roller
      // gets the brushed roller metal + spin); else the shape's declared package material, else the GLB's own.
      const single = link.finish ? roleMaterial(link.finish) : link.shape.material ? matById.get(link.shape.material) : undefined
      // resolve the per-GLB-material remap (name → built package material), dropping any unresolved id
      const perMat = link.shape.materials
        ? new Map(Object.entries(link.shape.materials).flatMap(([glb, id]) => { const m = matById.get(id); return m ? [[glb, m] as [string, Material]] : [] }))
        : undefined
      // tileUv: the GLB loads async, so the owned UV copies are made in the load callback below and brought to
      // the current stretch there; refresh keeps them in sync after that
      const tiled: TiledMeshLink | undefined = link.shape.tileUv && link.shape.sizeParams
        ? { sizeParams: link.shape.sizeParams, tiles: link.shape.tileUv, meshes: [] }
        : undefined
      if (tiled) tiledMeshLinks.push(tiled)
      const prepareTiled = (inst: Object3D): void => {
        if (!tiled) return
        collectTiledMeshes(tiled, inst)
        applyTiledMeshes(tiled, lastParams)
      }
      // C-emissive on a mesh link (link.lamps): each lamp lights one remapped GLB material under its behavior
      // name, so an imported panel whose lenses share a node still gets a lamp per lens - the Diverter's LampRed
      // + LampGreen are two primitives of the same `Pusher` mesh, which hideNodes/keepNode (carving by node)
      // can't split into links. Off = that material's matte base colour (an unlit cap stays its own colour, not
      // a dead grey). Registered before attachMesh so tagPoolLeaves already sees these materials as lit-per-tick
      // and leaves them out of the static pool (a pooled copy would drag its twins' colour).
      for (const lamp of link.lamps ?? []) {
        const lampMat = matById.get(link.shape.materials?.[lamp.material ?? ''] ?? '')
        if (!lampMat) continue
        if (lamp.offColor) lampMat.color.setRGB(lamp.offColor[0], lamp.offColor[1], lamp.offColor[2]) // authored dark colour, else the material's own
        const lm: LampMat = { name: lamp.name ?? link.name, mat: lampMat, color: new Color(lamp.emissive[0], lamp.emissive[1], lamp.emissive[2]), off: lampMat.color.clone(), ...(lamp.opacity !== undefined ? { opacity: lamp.opacity } : {}) }
        lampMats.push(lm)
        // C-paramgeo colour on a mesh lamp: the colorParam re-tints the lamp's unlit base and lit colour in
        // refresh (the push button's `button color`: albedo = emission = button_color). Only
        // for a link's one lamp: a param names one colour, and a panel of several lenses has several.
        if (link.colorParam && link.lamps!.length === 1) colorParamMats.push({ mat: lampMat, param: link.colorParam, lamp: lm })
      }
      if (link.array) {
        // an arrayed mesh link: the prepared GLB instance becomes a template cloned per array delta (the EOAT
        // suction-cup grid). Loads async → rebuild once it arrives (using the last refreshed params/seam), and
        // bump structureVersion so a staged placement preview re-tags the new clones (like roller/chain links).
        const entry: MeshArrayLink = { group: g, array: link.array, ...(link.showParam ? { showParam: link.showParam } : {}), shape: meshShape, template: null, instances: [], name: link.name }
        // squash: the clones compress when their driving lamp lights - `squash.lamp` (the EOAT's vacuum-status
        // LED) or this link's own lamp. No lamp of its own required (the cups don't glow).
        // anchorY is filled from the template bounds once the GLB loads.
        if (link.squash) entry.squash = { frac: link.squash.amount, signal: link.squash.lamp ?? link.name, anchorY: 0, restY: [], cur: 0, target: 0 }
        meshArrayLinks.push(entry)
        const asset = assets.find((a) => a.id === entry.shape.asset)
        if (asset) {
          void loadMeshAsset(asset)
            .then((scene) => {
              entry.template = prepareMeshInstance(scene, entry.shape, single, perMat, referencedNodes)
              if (!entry.template) return
              prepareTiled(entry.template) // before the clones: they share the template's (now owned) geometry
              if (entry.squash) {
                entry.template.updateMatrixWorld(true)
                const box = new Box3().setFromObject(entry.template)
                entry.squash.anchorY = Number.isFinite(box.min.y) ? box.min.y : 0 // the cup rim (contact lip) - stays seated on the workpiece while the bellows fold up into the mount
              }
              rebuildMeshArray(entry, lastParams, lastSeam)
              bumpStructureVersion(root)
            })
            .catch((e) => console.error('[oip] custom-part mesh load failed', e))
        }
      } else {
        const poolable = poolableLink(link)
        attachMesh(g, root, meshShape, assets, single, perMat, referencedNodes, poolable || tiled ? (inst) => { prepareTiled(inst); if (poolable) tagPoolLeaves(inst) } : undefined)
      }
      if (!link.lamps?.length && link.colorParam && !link.finish && link.shape.material) {
        // C-paramgeo colour on a plain mesh link: tints its single package-material override (a `finish`'s shared
        // textured material and a GLB's own materials stay untouched - those aren't this part's to repaint)
        const m = matById.get(link.shape.material)
        if (m) colorParamMats.push({ mat: m, param: link.colorParam })
      }
      if (link.shape.sizeParams) paramMeshes.push({ group: g, sizeParams: link.shape.sizeParams })
    }
    else if (link.shape.kind === 'leg') {
      // the built-in trestle: two InstancedMeshes (boxes + hex bolts) sharing the leg/bolt metal; refresh writes
      // the per-station leg matrices (legStations cadence). The group is placed at the floor; legs grow up.
      const pool = createLegSet(g, roleMaterial('leg'), roleMaterial('bolt'))
      legLinks.push({ pool, spanParam: link.shape.spanParam, widthParam: link.shape.widthParam, standParam: link.shape.standParam, shape: link.shape, ...(link.shape.arc ? { arc: link.shape.arc } : {}) })
    }
    else if (link.shape.kind !== 'frame') {
      // a `railing`-tagged link participates in the stair→platform structure cut in refresh - including the
      // hidden collision walls: the walking pilot reads hidden-but-bodied links as walls (`collisionSolid`),
      // so an uncut invisible wall stops the pilot dead on the landing behind a rail that is open everywhere
      // else. A cut this rig applies to the rail must reach every link that makes up that rail.
      const railing = link.onEdge
        ? { edge: link.onEdge, axis: (link.onEdge === 'posX' || link.onEdge === 'negX' ? 2 : 0) as 0 | 2, segment: !isMultiInstance(link.array) }
        : undefined
      // a railing rail/toe box without an array still needs the per-segment instanced layout - an empty array
      // spec resolves to one instance at the origin
      if (link.array || (railing && link.shape.kind === 'box')) {
        // an array link is an empty container; refresh fills its one InstancedMesh with the resolved instance
        // count. Every arrayed primitive (rollers, axle stubs, railing posts, rack shelves, stair treads) is N
        // copies of one shape at a uniform scale → one draw call regardless of count (built-in instanced-draw
        // parity), instead of N meshes. Roller hardware (role:'roller' stubs) skips the shadow pass; structural
        // arrays cast like their built-ins did (linkMesh's default). geom pick mirrors linkMesh (prim-only).
        const arrMat = walkMaterial(link) ?? (link.finish ? roleMaterial(link.finish) : link.colorParam ? colorParamMaterial(link.colorParam, link.color, link.metalness, link.roughness) : link.color ? colorMaterial(link.color, link.metalness, link.roughness) : fallback)
        const geom = link.shape.kind === 'cylinder' ? cylinderGeoFor(link.shape.radius) : link.shape.kind === 'cone' ? unitCone : unitBox
        instancedArrayLinks.push({ group: g, shape: link.shape, array: link.array ?? {}, ...(link.showParam ? { showParam: link.showParam } : {}), pool: null, mat: arrMat, geom, cast: link.finish !== 'roller', ...(railing ? { railing } : {}) })
      } else {
        let mat: Material
        let cue = false // a translucent cue link - see the opacity branch (no shadow cast)
        const lamp = link.lamps?.[0] // a primitive carries at most one: its own material
        if (lamp && lampBanked.has(link.name)) {
          // an instance of its lamp bank (built after the parenting pass); the mesh below is only the detached
          // scale carrier, never drawn, so it takes the shared bank material rather than a per-link one
          mat = lampBankMaterial()
        } else if (lamp) {
          // its own lamp material; unlit shows the lamp's `offColor` (the lens/cup albedo) else the dark neutral
          const off = lamp.offColor ? new Color(lamp.offColor[0], lamp.offColor[1], lamp.offColor[2]) : new Color(LAMP_OFF_COLOR)
          const lm = new MeshStandardMaterial({ color: off.clone(), metalness: 0.1, roughness: 0.5 })
          allMaterials.push(lm)
          lampMats.push({ name: lamp.name ?? link.name, mat: lm, color: new Color(lamp.emissive[0], lamp.emissive[1], lamp.emissive[2]), off, ...(lamp.opacity !== undefined ? { opacity: lamp.opacity } : {}) })
          mat = lm
        } else if (link.opacity !== undefined && link.opacity < 1) {
          // a translucent cue (the spawner's drop cone): its own transparent material, never a shared role/fallback
          // (mutating those would fade every same-role link). depthWrite off so it doesn't occlude what's behind it.
          // An untinted cue falls back to a neutral grey - a part that wants a signature tint authors `color`.
          const c = link.color ?? [0.7, 0.7, 0.7]
          const tm = new MeshStandardMaterial({ color: new Color(c[0], c[1], c[2]), metalness: link.metalness ?? 0.2, roughness: link.roughness ?? 0.5, transparent: true, opacity: link.opacity, depthWrite: false })
          allMaterials.push(tm)
          mat = tm
          cue = true
        } else if (linkBanked.has(link.name)) {
          const key = linkBanked.get(link.name)!
          let bm = linkBankMats.get(key)
          if (!bm) linkBankMats.set(key, (bm = link.color ? colorMaterial(link.color, link.metalness, link.roughness) : fallback))
          mat = bm
        } else {
          // a walking surface of its own, host finish material, a param-driven tint, its own static tint, else shared gray
          mat = walkMaterial(link) ?? (link.finish ? roleMaterial(link.finish) : link.colorParam ? colorParamMaterial(link.colorParam, link.color, link.metalness, link.roughness) : link.color ? colorMaterial(link.color, link.metalness, link.roughness) : fallback)
        }
        const m = linkMesh(link.shape, mat) // 'frame' = transform-only, no mesh
        // A translucent cue is not a body, so it casts no shadow. three's shadow pass ignores
        // material.opacity, so a 25%-opaque volume would throw a 100%-opaque shadow (the
        // despawner's 2x1x2 mouth would paint a solid black rectangle onto the belt under it,
        // and the spawner marker a hard cube). The other cues follow the same rule (sensor beams,
        // flow arrows, guard walls), for the same reason as this material's depthWrite:false:
        // the cue does not occlude. receiveShadow stays on, so a marker in the building is still lit.
        if (cue) m.castShadow = false
        if (lampBanked.has(link.name)) lampCarriers.set(link.name, m)
        else if (linkBanked.has(link.name)) linkCarriers.set(link.name, m)
        else g.add(m)
        // pool opt-in (static rigs only): the mesh is a shared unit primitive with size in mesh.scale, so
        // identical links across parts merge in the scene-global pool. Exclude any link whose material
        // state can diverge per part at runtime in a way the pool's rebuild signature cannot see -
        // emissive lamps lit per-tick and translucent cues - and edges links (the pool copy would drop
        // the wireframe child). `colorParam` links are included: the merge key folds colour and the
        // signature tracks the tint, so a repainted rack regroups instead of changing its twins'
        // colour too. This is what pools the structural parts: a platform/stairs/rack is one unit
        // box repeated a dozen times with a colour param on it (e2e/probes/draw-census.mjs).
        if (poolableLink(link) && !link.lamps?.length && link.opacity === undefined && !link.outline) m.userData.poolUnit = true
        // C-edges: a crisp wireframe outline over the fill (the built-in spawner marker's light-blue edges).
        // A LineSegments child of the scaled mesh, so the outline tracks the link's size (incl. sizeParams).
        if (link.outline) {
          const eg = new EdgesGeometry(m.geometry)
          const em = new LineBasicMaterial({ color: new Color(link.outline[0], link.outline[1], link.outline[2]) })
          m.add(new LineSegments(eg, em))
          allMaterials.push(em)
          edgeGeoms.push(eg)
        }
        if (link.notchable && link.shape.kind === 'box') {
          // a deck slab is (re)laid out by the deck-cut pool: one full-size child normally, complement strips
          // around the notches a snapped stair carves - replaces its plain param-box rescale
          const own = link.finish === 'deck' || link.finish === 'tread' ? deckSizeLinks.find((d) => d.surface.material === mat)?.surface : undefined
          deckCutLinks.push({ group: g, size: link.shape.size, sizeParams: link.shape.sizeParams, mat, children: [m], ...(own && (link.finish === 'deck' || link.finish === 'tread') ? { walk: link.finish, strips: [own] } : {}) })
        }
        else if (link.shape.kind === 'box' && link.shape.sizeParams) {
          // a length-parametric side guard (sideGuard) or side rail (sideRail) is remapped at
          // neighbour junctions in refresh; other param boxes just rescale. One on a non-conveyor rig never
          // receives openings/extents (the scene resolvers only map conveyors), so it stays a single
          // full-span box - the same as a plain param box.
          const guardSide = rigGuardSide(link)
          const side = guardSide ?? rigFrameSide(link)
          if (side) guardSplitLinks.push({ group: g, size: link.shape.size, sizeParams: link.shape.sizeParams, mat, side, frame: guardSide === null, offsetY: link.offset[1], link, children: [m], panels: [], wedges: [] })
          else paramBoxes.push({ mesh: m, size: link.shape.size, sizeParams: link.shape.sizeParams })
        }
        else if (link.shape.kind === 'cylinder' && link.shape.sizeParams) paramCylinders.push({ mesh: m, shape: link.shape })
      }
    }
    linkGroups.set(link.name, g)
  }
  // parent + rest pose (a parent named but missing falls back to the root; validation rejects that case).
  // The rest rotation honors quat (else Euler) via the shared restQuatOf, so render matches the core FK.
  for (const link of geo.links) {
    const g = linkGroups.get(link.name)!
    ;(link.parent ? (linkGroups.get(link.parent) ?? root) : root).add(g)
    g.position.set(link.offset[0], link.offset[1], link.offset[2])
    const q = restQuatOf(link)
    g.quaternion.set(q[0], q[1], q[2], q[3])
  }
  // build the lamp banks now that every link group sits in its parent (the bank hangs off that shared parent,
  // so it rides whatever moves it) and register each instance as a lamp: applyLamps / a lamp's param paint it
  // through the bank. refresh re-places the instances after its param offsets + sizes (writeMatrices).
  const lampBanks: LampBank[] = []
  for (const names of lampBankGroups.values()) {
    if (names.length < 2) continue
    const first = linkByName.get(names[0]!)!
    const slots: LampSlot[] = names.map((name) => {
      const l = linkByName.get(name)!
      const lamp = l.lamps![0]!
      const e = lamp.emissive
      return {
        name: lamp.name ?? name,
        color: new Color(e[0], e[1], e[2]),
        off: lamp.offColor ? new Color(lamp.offColor[0], lamp.offColor[1], lamp.offColor[2]) : new Color(LAMP_OFF_COLOR),
        ...(lamp.opacity !== undefined ? { opacity: lamp.opacity } : {}),
        node: linkGroups.get(name)!,
        shape: lampCarriers.get(name)!,
      }
    })
    const bank = new LampBank(lampGeoOf(first.shape), slots)
    ;(first.parent ? (linkGroups.get(first.parent) ?? root) : root).add(bank.mesh)
    bank.writeMatrices()
    slots.forEach((s, index) => lampMats.push({ name: s.name, mat: bank.mesh.material as MeshStandardMaterial, color: s.color, off: s.off, ...(s.opacity !== undefined ? { opacity: s.opacity } : {}), bank: { bank, index } }))
    lampBanks.push(bank)
  }
  // ...and the link banks, the same way: each hangs off its members' shared (moving) parent
  const linkBanks: LinkBank[] = []
  for (const names of linkBankGroups.values()) {
    if (names.length < 2) continue
    const slots: LinkSlot[] = names.map((name) => ({ name, node: linkGroups.get(name)!, shape: linkCarriers.get(name)! }))
    const carrier = linkCarriers.get(names[0]!)!
    const bank = new LinkBank(carrier.geometry, carrier.material as Material, slots, carrier.castShadow)
    const parent = linkByName.get(names[0]!)!.parent!
    ;(linkGroups.get(parent) ?? root).add(bank.mesh)
    bank.writeMatrices()
    linkBanks.push(bank)
  }
  // a banked link's group moved outside refresh (a rest-pose reflow, a subPose the static scan missed)
  const replaceLinkBanks = (): void => {
    for (const lb of linkBanks) lb.writeMatrices()
  }

  // Transform-mutation tally for the matrix-freeze cache (viewMatrices.ts ensureFreshPose): every rig is
  // matrix-static, so each runtime mutator that moves a node transform outside apply() must bump the
  // root's poseRev: applyJoints/applySubPoses (frame routing, gizmo drag), squashTick (Stop-relax easing),
  // probeTick (beam stretch). apply()-driven moves (reflow, refresh, rebuild) are tallied by sdkPart's own
  // bump; a double bump is harmless. The bump goes through poseRev.ts, which also advances the global pose
  // epoch that the view's idle frozen-walk skip checks.
  const bumpPoseRev = (): void => {
    bumpVisualPoseRev(root)
  }

  const { beamVisuals, probeTick } = createRigBeams(geo, root, linkGroups)

  const { applyJoints, applyRestPose, applySubPoses: placeSubPoses, resetRunPose: placeRunReset, instancePoseInto, ...placement } = createRigPlacement({ geo, root, linkGroups, linkByName, hasLinkBanks: linkBanks.length > 0, replaceLinkBanks, bumpPoseRev })

  // squash links: the driving lamp's frame.lamps signal also sets the compression target (0/1), eased toward
  // by the tick (below). The signal is a different link than the squash (the cups squash off the tool's LED).
  const squashLinks = meshArrayLinks.filter((e) => !!e.squash)
  // the behavior's per-tick lamp state (frame.lamps), routed here by the view while the sim runs. A geometry()
  // submesh can be a lamp too (MeshPart.lamps) - those register on the first refresh, after this is built, so a rig
  // whose script has geometry() and declares lamps gets the hook up front (the loop reads lampMats at call time).
  const proc = createProcGeometry({ root, linkGroups, pkg, paramSpecs, materials, assets, allMaterials, lampMats, bumpPoseRev })

  // posable array links (array.posable): each instance's draws follow setSubPose(link, pose, i) (rigArrayPose.ts)
  const posedArrays = new Map<string, PosedArray>()
  for (const link of geo.links) {
    if (!link.array?.posable) continue
    const ial = instancedArrayLinks.find((x) => x.group === linkGroups.get(link.name))
    posedArrays.set(link.name, {
      rest: [],
      poses: undefined,
      primitive: () => (ial?.pool && ial.scale ? { mesh: ial.pool.mesh, scale: ial.scale } : null),
      banks: () => proc.banksOn(link.name),
      place: (out, pose, rest) => instancePoseInto(out, link.name, pose, rest),
    })
  }
  // a refresh re-lays the rows at rest: take the new rest places and put back the run's poses
  const refreshPosedArrays = (params: RigParams): void => {
    for (const [name, pa] of posedArrays) {
      const link = linkByName.get(name)!
      pa.rest = arrayInstanceDeltas(link.array!, params, undefined, link.showParam)
      const capped = pitchCapMessage(link, params)
      if (capped) reportPartDiagnostic({ source: 'geometry', partId: typeof root.userData.partId === 'string' ? root.userData.partId : '', packageId: pkg.id, message: capped })
      placePosedArray(pa)
    }
  }
  const applySubPoses = (subPoses: Record<string, SubPose>): void => {
    placeSubPoses(subPoses)
    let moved = false
    for (const name in subPoses) {
      const pa = posedArrays.get(name)
      const poses = subPoses[name]!.instances
      if (!pa || (!poses && !pa.poses)) continue
      pa.poses = poses
      placePosedArray(pa)
      moved = true
    }
    if (moved) bumpPoseRev()
  }
  const resetRunPose = (): void => {
    placeRunReset()
    proc.setCopySpeeds({}) // Stop: every copy's belt stops where it stands
    for (const pa of posedArrays.values()) {
      if (!pa.poses) continue
      pa.poses = undefined
      placePosedArray(pa)
    }
  }
  const procMayLight = proc.mayLight
  const applyLamps = lampMats.length || squashLinks.length || procMayLight
    ? (lamps: Record<string, boolean>): void => {
        for (const lm of lampMats) paintLamp(lm, lamps[lm.name] === true)
        for (const e of squashLinks) e.squash!.target = lamps[e.squash!.signal] === true ? 1 : 0
        proc.setLampTargets(lamps)
      }
    : undefined
  // idle lit-state (a lamp's `param`): a lamp bound to a boolean param shows that param whenever the behavior isn't
  // driving it - painted by refresh (place, param edit, sim stop), like the built-ins' authored lamps.
  const lampParamOf = new Map(geo.links.flatMap((l) => (l.lamps ?? []).flatMap((lamp) => (lamp.param ? [[lamp.name ?? l.name, lamp.param] as [string, string]] : []))))
  const paintLabels = (params: RigParams): boolean => paintLabelPlates(labels, displayValues, params, root)

  // The behavior's per-tick display values (frame.displays), routed here by the view while the sim runs.
  // Not a full refresh: a running panel would then re-derive guards, legs and roller grids sixty
  // times a second just to repaint a number. It repaints only the two surfaces that read displays, off the
  // params the last real refresh already resolved.
  const applyDisplays = labels.some((l) => l.shape.textFrom !== undefined)
    ? (displays: Record<string, number | boolean | string>): boolean => {
        displayValues = displays
        return paintLabels(lastParams)
      }
    : undefined


  // roller spin: each 'roller'-finish material's brushed grain sweeps around the cylinder from the part's `speed`
  // (the built-in's rollerSpinTick), so an SDK roller bed animates like the built-in. rollerSpeed/-SpinRadius
  // are refreshed from the instance params; the no-slip rate is speed / rendered radius (rigRollerSpinRadius) -
  // the class radius for roller-GLB links, not the GLB's native 0.12 m (which would spin ~5× slow).
  let rollerSpeed = 0
  let liveRollerSpeed: number | null = null // frame-routed effective speed (m/s) while running; null = use the param
  let rollerSpinRadius = rigRollerSpinRadius(geo, resolvePartParams(paramSpecs, {}) as RigParams)
  const spinTicks = rollerMats.map((m) => rollerSpinTick(m, () => ({ speed: liveRollerSpeed ?? rollerSpeed, radius: rollerSpinRadius })))
  const rollerTick = spinTicks.length
    ? (dt: number, running: boolean): boolean => {
        if (!running) liveRollerSpeed = null // a stale live speed must not outlive the run
        let mutated = false
        for (const t of spinTicks) if (t(dt, running)) mutated = true
        return mutated
      }
    : undefined
  // squash ease: each frame draw `cur` toward its lamp target (0 while the sim is stopped, so a cup
  // relaxes on Stop) with a frame-rate-independent exponential, re-laying the clones when it moves.
  const squashTick = squashLinks.length
    ? (dt: number, running: boolean): boolean => {
        const k = 1 - Math.exp(-dt / SQUASH_TAU)
        let moved = false
        for (const e of squashLinks) {
          const s = e.squash!
          const target = running ? s.target : 0
          if (s.cur === target) continue
          s.cur += (target - s.cur) * k
          if (Math.abs(target - s.cur) < 1e-3) s.cur = target
          applyMeshSquash(e)
          moved = true
        }
        if (moved) bumpPoseRev() // the ease moved clone transforms (incl. the Stop-relax on a frozen part)
        return moved
      }
    : undefined
  const conveyorSpeedKey = pkg.conveyor?.speedParam
  const procTick = proc.tick
  const tick = rollerTick || squashTick || procTick
    ? (dt: number, running: boolean): boolean => {
        // no short-circuit: every sub-tick must run each frame; OR their mutation reports
        let mutated = false
        if (rollerTick?.(dt, running)) mutated = true
        if (squashTick?.(dt, running)) mutated = true
        if (procTick?.(dt, running)) mutated = true
        return mutated
      }
    : undefined

  // a robot's gizmo drags its grip point, which is the tool's it carries (core robotKinematics): read per refresh
  const robotDecl = geo.posable === true ? robotDeclOfScript(pkg.behavior) : null
  const gripEnd = (params: Record<string, ParamValue>): string | undefined => (robotDecl ? robotKinematicsOf(geo, robotDecl, params)?.end : undefined)
  const gizmo = buildRigGizmo(geo, root, linkGroups, applyJoints, paramSpecs, gripEnd(resolvePartParams(paramSpecs, {})))
  // the authored idle pose: a `pose` numberList param whose first row is the rig's at-rest pose, in the columns and
  // units Capture Pose writes (core rigPoseColumns: a robot's controller joints in ° and mm, any other rig's posable
  // joints in ° and m). Only an array is valid, matching the numberList grid the Inspector edits; a legacy JSON
  // string is ignored.
  const poseColumns = gizmo ? rigPoseColumns(geo, robotDecl) : []
  const applyIdlePose = gizmo
    ? (poseParam: unknown): void => {
        const idle: Record<string, number> = {}
        const row = Array.isArray(poseParam) && Array.isArray(poseParam[0]) ? (poseParam[0] as unknown[]) : undefined
        if (row) poseColumns.forEach(({ joint, unit }, i) => { const d = row[i]; if (typeof d === 'number') idle[joint.name] = d / unit })
        gizmo.applyIdle(idle)
      }
    : undefined

  return {
    materials: allMaterials,
    // C-paramgeo: reflow param-driven box sizes + link offsets when an instance param (e.g. width/length)
    // changes. Static rigs have neither, so this is a no-op for them (the rig is otherwise static at rest).
    refresh: (p: SdkPart, openings?: GuardOpenings, grid?: RollerGrid, extents?: GuardExtents, platformCut?: PlatformCut, legRests?: LegRestRows, holes?: GuardHoles): void => {
      // cache the belt/roller speed for the spin tick (before any early-out) so a static roller bed still spins
      const sp = conveyorSpeedKey !== undefined ? (p.params as Record<string, unknown>)[conveyorSpeedKey] : undefined
      rollerSpeed = typeof sp === 'number' ? sp : 0
      // keep the spin radius tracking a radius-parametric roller cylinder (default-resolved like the speed)
      if (spinTicks.length > 0) rollerSpinRadius = rigRollerSpinRadius(geo, resolvePartParams(paramSpecs, p.params as Record<string, ParamValue>) as RigParams)
      // cache the beam draw params + paint idle param-bound lamps (also before the early-out - a static
      // sensor/beacon rig has no param-driven links). Default-resolved, so a sparse instance (all defaults)
      // still shows the beam at its range param's default / its default-lit lamps.
      if (beamVisuals.length > 0 || lampParamOf.size > 0 || colorParamMats.length > 0 || showParamLinks.length > 0) {
        const rp = resolvePartParams(paramSpecs, p.params as Record<string, ParamValue>)
        if (beamVisuals.length > 0) {
          for (const bv of beamVisuals) {
            const v = bv.rangeParam !== undefined ? rp[bv.rangeParam] : undefined
            bv.paramRange = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
            bv.shown = bv.showParam === undefined || rp[bv.showParam] !== false
          }
        }
        // param-gated structural links: show the group unless its boolean param resolves false (the sim drops
        // the matching collision body). A hidden (author-eye) link stays hidden regardless.
        // A flip is a draw-list change (same rule as the guard-split/deck-cut counts below), so it must bump
        // the structural counter the view's bundle invalidation polls. Turning a side guard off re-records by
        // side effect: dropping the guard mesh from the instance pool fails tryUpdateParts' membership check and
        // forces a full poolRebuild, which notifies. Turning it back on has no such side effect (the mesh is no
        // longer a recorded member), so without the bump the bundle keeps replaying the hidden list and the
        // guard never comes back.
        for (const sp of showParamLinks) {
          if (sp.group.userData.authorHidden) continue
          const want = showParamShows(sp.param, rp)
          if (sp.group.visible === want) continue
          sp.group.visible = want
          bumpStructureVersion(root)
        }
        for (const lm of lampMats) {
          const key = lampParamOf.get(lm.name)
          if (key !== undefined) paintLamp(lm, rp[key] === true)
        }
        // C-paramgeo colour: repaint each colorParam link from its (default-resolved) hex, read as sRGB so a
        // `#f2bd0f` default matches the built-in's linear steel. Runs before the param-geo early-out, so a
        // purely-static barrier (colours but no reflow) still re-tints.
        for (const cm of colorParamMats) {
          const v = rp[cm.param]
          // 8-digit #rrggbbaa (an alpha:true param) → strip alpha for the RGB-only .color.set
          if (typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
            if (cm.lamp) {
              // a mesh lamp: retint the unlit base and the lit colour, then repaint in the lamp's current state
              // (read from the material - lit mid-run keeps glowing in the new colour, off recolours the cap)
              cm.lamp.off.set(v.slice(0, 7))
              cm.lamp.color.set(v.slice(0, 7))
              paintLamp(cm.lamp, cm.lamp.mat.emissiveIntensity > 0)
            } else {
              cm.mat.color.set(v.slice(0, 7))
            }
          }
        }
      }
      // rigSize handles: keep the dots + tool outline at the resolved param values (default-resolved, so a
      // sparse instance shows the package defaults; streamed transient params track a live gizmo drag)
      // Every size and pose below reads the default-resolved params: a sparse instance is drawn at its defaults, as its
      // geometry(), its gizmo and the sim's bodies (world.ts) all take it, so the links, the colliders and the host's
      // footprint describe one part.
      const resolvedParams = resolvePartParams(paramSpecs, p.params as Record<string, ParamValue>)
      gizmo?.setSizes?.(resolvedParams)
      const end = gripEnd(resolvedParams)
      if (end !== undefined) gizmo?.setEnd(end)
      const params = resolvedParams as RigParams
      // Pass the part placement as the seam so world-phase beds (roller grids) align across butted parts;
      // the centred default ignores it (docs/seam-resolvers.md).
      const seam = { worldPos: p.position, worldRotY: p.rotationY, anchor: grid?.anchor }
      // Resolve the world-phase bed grid for geometry() (GeometryContext): the rollers and the plates that fill
      // between them are authored against this one array, so they cannot disagree about where a roller sits.
      // `butt` comes straight off the resolved grid: the edge nudge is suppressed exactly where the end abuts
      // a collinear roller neighbour, which is the same question "does my end geometry meet anything?" asks.
      // The grid is declared by a link that draws nothing - an arrayed `frame` - for a bed whose rollers its own
      // geometry() draws: the grid is the host's (it spans butted parts), the rollers are the part's.
      const bedArray = geo.links.find((l) => l.array?.distribute?.worldPhase)?.array
      const bedDeltas = bedArray ? arrayInstanceDeltas(bedArray, params, seam) : null
      const geoCtx: GeometryContext = bedDeltas
        ? { deltas: bedDeltas, pitch: bedArray!.distribute!.maxSpacing, butt: { head: grid ? !grid.nudgeHi : false, tail: grid ? !grid.nudgeLo : false } }
        : {}
      // (re)emit the behavior's geometry() into the rig links (MeshPart.link) - before the param-geo early-out,
      // so a purely-static procedural rig (a fence: dressing only, no param-driven primitive links) still draws.
      proc.realize(p, geoCtx)
      if (posedArrays.size > 0) refreshPosedArrays(params)
      if (paramBoxes.length === 0 && guardSplitLinks.length === 0 && deckCutLinks.length === 0 && paramCylinders.length === 0 && !paramPose && instancedArrayLinks.length === 0 && legLinks.length === 0 && meshArrayLinks.length === 0 && paramMeshes.length === 0 && labels.length === 0) return
      // C-label: redraw each text plane from its static text or its (Inspector-editable) param value.
      //
      // A changed caption can invalidate the render bundle. Without a re-record every label is invisible under
      // WebGPU while WebGL shows it (headless gates and shots run WebGL, so they don't catch it). A label is
      // built with an empty canvas and `visible = false`, because the text only arrives on the first refresh.
      // At record time the plane is either out of the draw list or bound to a blank texture, and the replay
      // keeps showing that: the plate renders as a bare white rectangle. `?nobundle` shows the text.
      //
      // So the `visible` flip (the first non-empty caption, or back to empty) re-records: paintLabels bumps
      // structure for it. A later retype is not structural: the canvas keeps its size, three re-uploads into
      // the same GPU texture, and the edit's syncScene marks the part so the replay walks its draw and uploads
      // it. (Checked on WebGPU: an Inspector-style retype and a live `textFrom` counter both reach the screen
      // with no re-record.)
      paintLabels(params)
      for (const pb of paramBoxes) {
        const sz = resolvedBoxSize(pb.size, pb.sizeParams, params)
        pb.mesh.scale.set(sz[0], sz[1], sz[2])
      }
      // splittable side guards/frames: rebuild each into the kept segments of its span. The span defaults to
      // the full length (centre-origin ±L/2); the part's own snap extents override an end (a flush side-merge
      // retracts the mover's rails to the host wall plane - guardExtents). Guards additionally lose the
      // host-computed openings on their side; frames never do (the host frame never opens).
      // No openings/extents ⇒ one child at full length (identical to a plain param box). The child pool
      // grows/shrinks to one box per kept segment; each is scaled to the segment length and centred on it.
      // The link group already carries the incline tilt + ±width offset, so children ride it.
      for (const gs of guardSplitLinks) {
        if (layoutGuardSplit(gs, params, linkByName, openings, extents, holes)) bumpStructureVersion(root)
      }
      // walking surfaces: retile the texture to the slab's resolved metre extents (X→U, Z→V), so a
      // resized/non-square deck keeps a fixed ~0.5 m crop instead of stretching (createDeckSurface.setExtent)
      for (const dl of deckSizeLinks) {
        if (dl.sizeParams) dl.surface.setBoxExtent(resolvedBoxSize(dl.size, dl.sizeParams, params))
      }
      // deck-cut pool: lay the deck out as the complement strips around a snapped stair's notches (guardSplit's
      // 2-axis twin, deckStripRects = the sim's collider rects). No cut ⇒ one full-size child (a plain rescale).
      for (const dc of deckCutLinks) {
        if (layoutDeckCut(dc, params, platformCut, newDeckSurface)) bumpStructureVersion(root)
      }
      // node scaling: stretch each param-scaled mesh node's group per-axis (atop its fitHeight/scale base)
      for (const pm of paramMeshes) {
        const f = resolvedMeshScale(pm.sizeParams, params)
        pm.group.scale.set(f[0], f[1], f[2])
      }
      for (const tl of tiledMeshLinks) applyTiledMeshes(tl, params)
      for (const pc of paramCylinders) {
        const { radius, height } = resolvedCylinder(pc.shape, params)
        pc.mesh.scale.set(radius, height, radius)
      }
      // place every link from the one resolver, with these params: param-driven offsets (a hinge at -length/2, the
      // blade stop's airPressureHeight mount on a jointed link) and the whole-bed incline (deck, rollers, walls and
      // guards climb the grade; the legs, below, stay vertical) both come out of it, from the current geometry.
      // inclineRad/cosIncline/sinIncline are read again by the leg layout; 0 ⇒ flat.
      lastParams = params
      placement.place(params)
      const inclineRad = rigInclineRad(geo, params)
      const cosIncline = Math.cos(inclineRad)
      const sinIncline = Math.sin(inclineRad)
      // array-links: (re)build the container's instance meshes to the resolved count, place + scale each.
      // (`seam` - the part placement that aligns world-phase beds across butted parts - is built at the top
      // of the refresh, because geometry() takes the grid it resolves; docs/seam-resolvers.md.)
      lastParams = params // remembered so an async GLB load lays out on the right grid after this refresh
      lastSeam = seam
      for (const ml of meshArrayLinks) rebuildMeshArray(ml, params, seam)
      // kind:'leg': (re)write the trestle instances at each station, reflowing with length + width, and the leg
      // height auto-adjusting to the stand param (deck→floor) minus the frame depth - so raising/lowering the deck
      // (or dropping it on a platform) regrows the legs to reach.
      for (const ll of legLinks) {
        layoutLegs(ll, params, legRests, cosIncline, sinIncline)
      }
      // arrayed primitive links (rollers/stubs/railings/shelves/treads): one InstancedMesh at a uniform per-copy
      // scale (from the shape's size + any sizeParams), only the grid delta varies per copy. `cast` was decided
      // at build time (roller hardware skips the shadow pass; structural arrays cast like the built-ins).
      for (const ial of instancedArrayLinks) {
        layoutArrayLink(ial, params, seam, platformCut, root, pkg.id)
      }
      if (posedArrays.size > 0) refreshPosedArrays(params)
      // a changed neighbour cut reshaped draws that live inside this part's recorded render bundle (instanced
      // rail segments/posts, deck strips) while the part itself was never dragged/ejected. Bump the structural
      // counter so the bundle re-records, or WebGPU keeps replaying the old railing/deck until a dev restart.
      // One bump per cut change; an idle refresh with the same cut bumps nothing.
      // lamp banks: re-place their instances from the links' freshly resolved offsets + sizes
      for (const lb of lampBanks) lb.writeMatrices()
      replaceLinkBanks()
      const cutKey = (openings || platformCut || legRests) ? JSON.stringify([openings ?? null, platformCut ?? null, legRests ?? null]) : ''
      if (cutKey !== lastCutKey) {
        lastCutKey = cutKey
        bumpStructureVersion(root)
      }
    },
    applyJoints,
    applySubPoses,
    applyRestPose,
    resetRunPose,
    ...(posedArrays.size > 0 ? { applyCopySpeeds: proc.setCopySpeeds } : {}),
    ...(applyLamps ? { applyLamps } : {}),
    ...(applyDisplays ? { applyDisplays } : {}),
    // per-frame animation: roller-bed spin + squash cup ease (combined). Roller beds also follow the
    // frame's live effective speed (a tag-stopped roller stops spinning).
    ...(tick ? { tick } : {}),
    ...(rollerTick ? { applyConveyorSpeed: (v: number): void => { liveRollerSpeed = v } } : {}),
    // geometry() channels take the behavior's reported values (a program-commanded speed), not the deck's surface
    // speed: a chain transfer's deck runs across its chains while raised, so frame.conveyorSpeeds reads 0 exactly then
    ...(procTick ? { applyValues: proc.applyValues } : {}),
    ...(probeTick ? { probeTick } : {}),
    ...(gizmo ? { gizmo: gizmo.api, applyIdlePose } : {}),
    dispose: () => {
      for (const m of allMaterials) m.dispose() // textures are module-cached/shared, like meshCache - not disposed
      // beams are instances of the scene-level bank, not children of this rig, so disposing the part
      // doesn't detach them - they'd linger in the scene forever. (The bank owns the shared geometry
      // and the one beam material; neither is per-part, so neither is disposed here.)
      for (const bv of beamVisuals) removeSensorBeam(bv.beam)
      for (const s of deckSurfaces) s.dispose() // a walking surface's material (its maps are shared app-wide)
      proc.dispose() // the procedural rig-link geometries and their scroll texture copies (materials are in allMaterials, above)
      for (const tl of tiledMeshLinks) for (const tm of tl.meshes) retireGeometry(tm.geo) // tileUv's owned UV copies (the source GLB geometry is shared, never freed here)
      for (const ial of instancedArrayLinks) retireInstancedMeshOnly(ial.pool?.mesh) // array-link InstancedMesh buffers; mesh-only: the geom is shared (unitBox / unitCone / cylinderGeoFor), mats are in allMaterials
      for (const lb of lampBanks) lb.dispose() // lamp-bank instance buffers + cloned geometry (retired; the material is shared)
      for (const lb of linkBanks) lb.dispose() // link-bank instance buffers (retired; shared unit geometry, material in allMaterials)
      for (const ll of legLinks) disposeLegSet(ll.pool) // the trestle InstancedMesh buffers
      for (const gs of guardSplitLinks) releaseGuardSplit(gs) // the shared hole-panel plates its panels hold (retired at zero)
      // label canvas textures/materials/geometries are per-instance. Textures + geometries retire (a recording may
      // still bind them, gpuRetire.ts); a material's dispose is already safe (bindings.deleteForRender).
      for (const d of labelDisposables) {
        if ((d as Texture).isTexture) retireTexture(d as Texture)
        else if ((d as BufferGeometry).isBufferGeometry) retireGeometry(d as BufferGeometry)
        else d.dispose()
      }
      for (const eg of edgeGeoms) retireGeometry(eg) // per-link wireframe outline buffers (link.outline); their material is in allMaterials
    },
  }
}
