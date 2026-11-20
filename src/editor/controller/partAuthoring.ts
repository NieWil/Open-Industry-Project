// Part authoring of the EditorController (../controller.ts): rig node / joint edits, the
// behavior script, importing and creating parts. No state of its own: every edit is a package commit through
// the store, so each function takes only the narrow slice of the controller it uses (AuthoringDeps).

import { getPackage, hasPackage, listPackages, registerPackage } from '../../core/parts/partRegistry'
import { packageCategory, sameCategory } from '../../core/parts/partCategory'
import { behaviorMentions, renameRigJoint as renamedJoints, renameRigLink, renameRigNameRefs } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { asNewPartFrom } from '../../core/builtInVersion'
import { bytesToBase64 } from '../../core/parts/partAssets'
import { fitRigToModel } from '../../core/parts/modelFit'
import { meshLinkBox, parseGlb, type Box3Like } from '../../core/glbBox'
import { canDeleteRigNode, defaultShape, rigSubtree } from '../rigTree'
import { mergeRigPiece as mergedGeometry, releaseKeptNodes, reparentRigLink as reparentedGeometry, setRigPivot as pivotedGeometry, splitRigNode as splitGeometry } from '../rigSplit'
import { isReplaceableBehavior, jointPlcBehavior, readJointPlcConfig, type JointPlcMode } from '../jointPlcControl'
import type { AuthorableShapeKind } from '../rigTree'
import type { PartAsset, PartMaterial, PartPackage, RigGeometry, RigJoint, RigLink, RigServo, RigShape } from '../../core/parts/partPackage'
import { buildPackage, manifestOfPackage } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'
import { parsePartBytes, parsePartText } from '../parts/partFile'
import { largeModelAdvisory } from '../parts/modelStorage'
import { rigPoseColumns, robotDeclOfScript, type RobotColumn } from '../../core/robot/robotIk'
import { validatePart } from '../../sim/validatePart'
import type { PartDiagnostic } from '../../sim/validatePart'
import type { SdkPart } from '../../core/types'
import type { EditorController } from '../controller'

/** what part authoring reads and drives: the store (packages, selection, undo), the view (the rig gizmo's held pose),
 *  the read-only gate, and opening a definition as its own scene */
export type AuthoringDeps = Pick<EditorController, 'store' | 'view' | 'readOnly' | 'editPartPackage'>

export function editRigLink(
  ec: AuthoringDeps,
  packageId: string,
  linkName: string,
  patch: { offset?: [number, number, number]; rotation?: [number, number, number]; shape?: RigShape },
): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const links = pkg.geometry.links.map((l): RigLink => {
    if (l.name !== linkName) return l
    const next: RigLink = { ...l }
    if (patch.offset) next.offset = patch.offset
    // editing the Euler rotation supersedes any authored quaternion (restQuatOf prefers quat otherwise)
    if (patch.rotation) {
      next.rotation = patch.rotation
      delete next.quat
    }
    if (patch.shape) next.shape = patch.shape
    return next
  })
  ec.store.commitPackage('Edit node', { ...pkg, geometry: { ...pkg.geometry, links } }, { coalesceKey: `rig:${packageId}:${linkName}` })
}

export function setRigLinkHidden(ec: AuthoringDeps, packageId: string, linkName: string, hidden: boolean): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const links = pkg.geometry.links.map((l): RigLink => {
    if (l.name !== linkName) return l
    if (hidden) return { ...l, hidden: true }
    const rest = { ...l } // unhiding drops the flag entirely (visible is the default)
    delete rest.hidden
    return rest
  })
  ec.store.commitPackage(hidden ? 'Hide node' : 'Show node', { ...pkg, geometry: { ...pkg.geometry, links } })
}

export function renameRigNode(
  ec: AuthoringDeps,
  packageId: string,
  linkName: string,
  rawName: string,
  confirmBehaviorRewrite?: (count: number) => boolean,
): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  const next = renameRigLink(pkg.geometry, linkName, rawName)
  if (!next) return false // blank/unchanged/colliding name - nothing to commit (and no prompt)
  const newName = rawName.trim()
  // guarded behavior-source half: rewrite whole-literal link-name args only when the author opts in
  const rewrite = renameRigNameRefs(pkg.behavior, linkName, newName)
  const behavior = rewrite.count > 0 && confirmBehaviorRewrite?.(rewrite.count) ? rewrite.source : pkg.behavior
  ec.store.commitPackage('Rename node', { ...pkg, behavior, geometry: { ...pkg.geometry, links: next.links, joints: next.joints } })
  // keep the renamed node selected under its new identity (so the Inspector + highlight don't drop it)
  const st = ec.store.getState()
  const sel = st.selectedRigNode
  if (sel && sel.linkName === linkName) {
    const p = st.scene.parts.find((x) => x.id === sel.partId)
    if (p?.type === 'part' && (p as SdkPart).packageId === packageId) ec.store.selectRigNode(sel.partId, newName)
  }
  return true
}

export function renameRigJoint(ec: AuthoringDeps, packageId: string, jointName: string, rawName: string): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  if (behaviorMentions(pkg.behavior, jointName)) return false
  const joints = renamedJoints(pkg.geometry.joints, jointName, rawName)
  if (!joints) return false
  ec.store.commitPackage('Rename joint', { ...pkg, geometry: { ...pkg.geometry, joints } })
  return true
}

/**
 * Make `linkName` a mesh of the GLB `glb`, embedded in the part, as one undo step. When the part is just that model
 * (core/parts/modelFit.ts) it is fitted to it in the same step: standing on the origin, with a collider and bounds
 * of the model's size. `warning` is the advisory for a large embed. Bytes that are not a GLB change nothing and come
 * back `unreadable`: embedded, they would draw nothing and give no reason.
 */
export function setLinkMesh(
  ec: Pick<AuthoringDeps, 'store'>,
  packageId: string,
  linkName: string,
  glb: Uint8Array,
  label = 'Import model',
): { warning: string | null; fitted: boolean; unreadable?: true } {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return { warning: null, fitted: false }
  let json: ReturnType<typeof parseGlb>['json']
  try {
    json = parseGlb(glb).json
  } catch {
    return { warning: null, fitted: false, unreadable: true }
  }
  const dataBase64 = bytesToBase64(glb)
  const assets = [...(pkg.assets ?? [])]
  let n = assets.length + 1
  let assetId = `mesh-${n}`
  while (assets.some((a) => a.id === assetId)) assetId = `mesh-${++n}`
  assets.push({ id: assetId, mime: 'model/gltf-binary', data: dataBase64 })
  const shape = { kind: 'mesh' as const, asset: assetId }
  const geometry = { ...pkg.geometry, links: pkg.geometry.links.map((l): RigLink => (l.name === linkName ? { ...l, shape } : l)) }
  let box: Box3Like | null = null
  try {
    // the whole model, as the new shape draws it (no node, carving or scale yet)
    box = meshLinkBox(json, {})
  } catch {
    // a GLB with nothing to measure: it is embedded, and there is nothing to fit to
  }
  const fitted = box ? fitRigToModel(geometry, linkName, box) : null
  ec.store.commitPackage(label, { ...pkg, geometry: fitted ?? geometry, assets })
  // advisory only: a refused save is detected and reported by projectFile.saveStoredProject, which sees the quota
  return { warning: largeModelAdvisory(glb.length), fitted: !!fitted }
}

/** setLinkMesh from the Inspector's import: a part fitted to its model took the model's size, so the open Part Editor
 *  frames it again, as opening it did */
export function importLinkMesh(ec: Pick<AuthoringDeps, 'store' | 'view'>, packageId: string, linkName: string, glb: Uint8Array): ReturnType<typeof setLinkMesh> {
  const res = setLinkMesh(ec, packageId, linkName, glb)
  const focus = ec.store.getState().focusedPartId
  if (res.fitted && focus) ec.view.focusOn([focus])
  return res
}

export function addRigNode(ec: AuthoringDeps, packageId: string, parentLinkName: string, kind: AuthorableShapeKind = 'box'): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const links = pkg.geometry.links
  let n = links.length + 1
  let name = `node-${n}`
  while (links.some((l) => l.name === name)) name = `node-${++n}`
  const node: RigLink = { name, parent: parentLinkName, shape: defaultShape(kind), offset: [0, 0.3, 0] }
  ec.store.commitPackage('Add node', { ...pkg, geometry: { ...pkg.geometry, links: [...links, node] } })
  const focused = ec.store.getState().focusedPartId
  if (focused) ec.store.selectRigNode(focused, name)
}

/** Split a GLB node out of a whole-scene mesh link into a new node under `parentLinkName` (rigSplit.splitRigNode),
 *  and select the new node so its joint can be added next. False when the split would not line up. */
export function splitRigMeshNode(ec: AuthoringDeps, packageId: string, sourceLinkName: string, glbNode: string, parentLinkName: string): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  const out = splitGeometry(pkg.geometry, sourceLinkName, glbNode, parentLinkName)
  if (!out) return false
  ec.store.commitPackage('Split out node', { ...pkg, geometry: out.geometry })
  const focused = ec.store.getState().focusedPartId
  if (focused) ec.store.selectRigNode(focused, out.name)
  return true
}

/** Move the pivot of a link's joint to a point in part coordinates, keeping the rest pose (rigSplit.setRigPivot).
 *  When a frame had to be inserted to carry the joint, it is selected, since the joint now lives there. */
export function setRigJointPivot(ec: AuthoringDeps, packageId: string, linkName: string, pivot: [number, number, number]): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  const out = pivotedGeometry(pkg.geometry, linkName, pivot)
  if (!out) return false
  if (out.geometry === pkg.geometry) return true
  ec.store.commitPackage('Move pivot', { ...pkg, geometry: out.geometry }, { coalesceKey: `pivot:${packageId}:${out.jointLink}` })
  const focused = ec.store.getState().focusedPartId
  if (focused && out.jointLink !== linkName) ec.store.selectRigNode(focused, out.jointLink)
  return true
}

/** Put a split piece back into the model node it came from (rigSplit.mergeRigPiece), selecting that node. */
export function mergeRigPiece(ec: AuthoringDeps, packageId: string, linkName: string): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  const out = mergedGeometry(pkg.geometry, linkName)
  if (!out) return false
  ec.store.commitPackage('Merge node back', withJointPlcScript({ ...pkg, geometry: out.geometry }))
  const focused = ec.store.getState().focusedPartId
  if (focused) ec.store.selectRigNode(focused, out.select)
  return true
}

/** Move a node under another (undefined = the part root) without it moving at rest (rigSplit.reparentRigLink). */
export function reparentRigLink(ec: AuthoringDeps, packageId: string, linkName: string, parent: string | undefined): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  const geometry = reparentedGeometry(pkg.geometry, linkName, parent)
  if (!geometry) return false
  ec.store.commitPackage('Change parent', { ...pkg, geometry })
  return true
}

/** The columns a posed row lists, in order (core rigPoseColumns, which the stopped scene's idle pose reads too). */
function poseColumns(pkg: PartPackage | undefined): RobotColumn[] {
  if (pkg?.geometry.kind !== 'rig') return []
  return rigPoseColumns(pkg.geometry, robotDeclOfScript(pkg.behavior))
}

export function captureRigPose(ec: AuthoringDeps, partId: string): number[] | null {
  const part = ec.store.getState().scene.parts.find((p) => p.id === partId)
  if (!part || part.type !== 'part') return null
  const columns = poseColumns(getPackage((part as SdkPart).packageId))
  if (columns.length === 0) return null
  const pose = ec.view.rigJointPose(partId) ?? {}
  const round = (v: number): number => Math.round(v * 100) / 100
  return columns.map(({ joint, unit }) => round((pose[joint.name] ?? 0) * unit))
}

export function previewRigPose(ec: AuthoringDeps, partId: string, row: readonly number[]): void {
  const part = ec.store.getState().scene.parts.find((p) => p.id === partId)
  if (!part || part.type !== 'part') return
  const pose: Record<string, number> = {}
  poseColumns(getPackage((part as SdkPart).packageId)).forEach(({ joint, unit }, i) => {
    const v = row[i]
    if (typeof v === 'number') pose[joint.name] = v / unit
  })
  ec.view.setRigJointPose(partId, pose)
}

export function deleteRigNode(ec: AuthoringDeps, packageId: string, linkName: string): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const { links, joints } = pkg.geometry
  if (!canDeleteRigNode(pkg.geometry, linkName)) return // never empty a rig
  const remove = rigSubtree(pkg.geometry, linkName)
  // a removed piece of an imported model is drawn by the model again (rigSplit.releaseKeptNodes)
  const remaining = releaseKeptNodes(
    links.filter((l) => !remove.has(l.name)),
    links.filter((l) => remove.has(l.name)),
  )
  ec.store.commitPackage('Delete node', withJointPlcScript({ ...pkg, geometry: { ...pkg.geometry, links: remaining, joints: joints.filter((j) => !remove.has(j.link)) } }))
  const parent = links.find((l) => l.name === linkName)?.parent
  const next = parent && remaining.some((l) => l.name === parent) ? parent : remaining[0]!.name
  const focused = ec.store.getState().focusedPartId
  if (focused) ec.store.selectRigNode(focused, next)
}

export function setRigJoint(
  ec: AuthoringDeps,
  packageId: string,
  linkName: string,
  joint: { type: 'revolute' | 'prismatic'; axis: [number, number, number]; min: number; max: number; servo?: RigServo | null } | null,
): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const all = pkg.geometry.joints
  const existing = all.find((j) => j.link === linkName)
  let joints: RigJoint[] = all.filter((j) => j.link !== linkName)
  if (joint) {
    const name = existing?.name ?? `${linkName}-joint`
    // the fields the panel does not edit (servo, rest, cosmetic, param limits) survive an edit of the ones it does
    let next: RigJoint = { ...existing, name, link: linkName, type: joint.type, axis: joint.axis, min: joint.min, max: joint.max }
    if (existing && existing.type !== joint.type) {
      // servo caps, rest and param limits are in the joint's unit (radians or metres), so a new type clears them
      const { servo: _servo, rest: _rest, minParam: _minParam, maxParam: _maxParam, ...kept } = next
      next = kept
    } else if (next.servo?.modulo !== undefined && (next.min > 0 || next.max < next.servo.modulo)) {
      // a wrapping servo's limits must cover 0 to modulo, so narrower limits stop the wrap
      const { modulo: _modulo, ...servo } = next.servo
      next.servo = servo
    }
    // a servo the panel sets or clears itself (Spins endlessly) comes after those rules
    if (joint.servo === null) delete next.servo
    else if (joint.servo) next.servo = joint.servo
    // in place: the idle pose rows and the servo list follow the joints' order
    joints = existing ? all.map((j) => (j === existing ? next : j)) : [...joints, next]
  }
  ec.store.commitPackage(joint ? 'Edit joint' : 'Remove joint', withJointPlcScript({ ...pkg, geometry: { ...pkg.geometry, joints } }))
}

/** `pkg` with a panel-written PLC control script written again for its joints (their limits, or their removal).
 *  Every edit that changes or removes joints commits through this: a script still naming a removed joint does not
 *  build. Any other script, or a rewrite that does not build, leaves `pkg` as it is. */
function withJointPlcScript(pkg: PartPackage): PartPackage {
  const config = readJointPlcConfig(pkg.behavior)
  if (!config || pkg.geometry.kind !== 'rig') return pkg
  const result = validatePart(manifestOfPackage(pkg), jointPlcBehavior(pkg.name, config, pkg.geometry.joints))
  return result.ok && result.package ? result.package : pkg
}

/**
 * Set the panel's PLC control for one joint (Two positions with its stroke time, or Spin) or turn it off (null), by
 * writing the behavior script. A script the panel did not write is replaced only after `confirmReplace`.
 */
export function setJointPlcControl(
  ec: AuthoringDeps,
  packageId: string,
  jointName: string,
  mode: JointPlcMode | null,
  confirmReplace?: () => boolean,
): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  if (!isReplaceableBehavior(pkg.behavior) && !confirmReplace?.()) return false
  const config = { ...readJointPlcConfig(pkg.behavior) }
  const key = config[jointName]?.key
  if (mode === null) delete config[jointName]
  // a joint already driven keeps its key stem, so its placed copies' tag names stay bound
  else config[jointName] = key ? { ...mode, key } : mode
  const result = validatePart(manifestOfPackage(pkg), jointPlcBehavior(pkg.name, config, pkg.geometry.joints))
  if (!result.ok || !result.package) return false
  ec.store.commitPackage('PLC control', result.package, { coalesceKey: `plc:${packageId}:${jointName}` })
  return true
}

/** The rig edits the Inspector calls, bound to the controller (EditorController.rig, kept off the class itself). */
export function rigEdits(ec: AuthoringDeps) {
  return {
    splitRigMeshNode: (packageId: string, sourceLinkName: string, glbNode: string, parentLinkName: string): boolean =>
      splitRigMeshNode(ec, packageId, sourceLinkName, glbNode, parentLinkName),
    setRigJointPivot: (packageId: string, linkName: string, pivot: [number, number, number]): boolean => setRigJointPivot(ec, packageId, linkName, pivot),
    mergeRigPiece: (packageId: string, linkName: string): boolean => mergeRigPiece(ec, packageId, linkName),
    reparentRigLink: (packageId: string, linkName: string, parent: string | undefined): boolean => reparentRigLink(ec, packageId, linkName, parent),
    setJointPlcControl: (packageId: string, jointName: string, mode: JointPlcMode | null, confirmReplace?: () => boolean): boolean =>
      setJointPlcControl(ec, packageId, jointName, mode, confirmReplace),
  }
}

/**
 * Reconstruct a part's manifest from its live package so geometry/assets/materials stay the source of
 * truth; validatePart re-bakes the param schema from the behavior, exactly like a hand-authored folder.
 */
export function partManifest(ec: AuthoringDeps, pkg: PartPackage): PackageManifest {
  return manifestOfPackage(pkg)
}

export function validateBehavior(ec: AuthoringDeps, packageId: string, source: string): PartDiagnostic[] {
  const pkg = getPackage(packageId)
  if (!pkg) return [{ kind: 'load', message: "The part isn't loaded." }]
  return validatePart(partManifest(ec, pkg), source).diagnostics
}

export function editBehavior(ec: AuthoringDeps, packageId: string, source: string): PartDiagnostic[] {
  const pkg = getPackage(packageId)
  if (!pkg) return [{ kind: 'load', message: "The part isn't loaded." }]
  const result = validatePart(partManifest(ec, pkg), source)
  if (!result.ok || !result.package) return result.diagnostics
  ec.store.commitPackage('Edit behavior', result.package)
  return []
}

export async function importPart(
  ec: AuthoringDeps,
  file: string | Uint8Array,
  confirmReplace?: (existingName: string) => boolean,
): Promise<string | null> {
  const res = await importPartFile(ec, file, confirmReplace)
  return 'error' in res ? res.error : null
}

/** importPart, answering with the imported part's id: null when the person declined to replace one already here */
export async function importPartFile(
  ec: AuthoringDeps,
  file: string | Uint8Array,
  confirmReplace?: (existingName: string) => boolean,
): Promise<{ error: string } | { id: string | null }> {
  const res = typeof file === 'string' ? parsePartText(file) : await parsePartBytes(file)
  if ('error' in res) return { error: res.error }
  const existing = getPackage(res.pkg.id)
  if (existing && confirmReplace && !confirmReplace(existing.name)) return { id: null }
  registerPackage(res.pkg, true)
  ec.store.addUserPackage(res.pkg)
  return { id: res.pkg.id }
}

export function saveAsNewPart(ec: AuthoringDeps, packageId: string): string | null {
  if (ec.readOnly) return null
  const state = ec.store.getState()
  const src = state.userPackages.find((p) => p.id === packageId) ?? getPackage(packageId)
  if (!src) return null
  const stem = packageId.replace(/^[^.]*\./, '') || 'part'
  let n = 1
  let id = `user.${stem}`
  while (hasPackage(id)) id = `user.${stem}-${++n}`
  const name = n === 1 ? `${src.name} (variant)` : `${src.name} (variant ${n})`
  const base = state.bundledPackages.find((b) => b.id === (src.origin?.appPart ?? packageId))
  const pkg = asNewPartFrom(src, id, name, base)
  if (validatePartPackage(pkg).length > 0) return null
  registerPackage(pkg, true)
  ec.store.addUserPackage(pkg)
  return id
}

/**
 * Change a part's own name and catalog category (the definition, not a placed copy's name). Refused for a built-in's
 * copy, whose name is the built-in's (Save as New Part makes one to name). Returns '' or why not.
 */
export function setPartInfo(ec: AuthoringDeps, packageId: string, patch: { name?: string; category?: string }): string {
  if (ec.readOnly) return 'This project is view only.'
  const pkg = getPackage(packageId)
  if (!pkg) return 'This part is not loaded.'
  if (ec.store.getState().bundledPackages.some((b) => b.id === packageId)) return `“${pkg.name}” is a built-in part. Save it as a new part to name your own.`
  const name = patch.name?.trim() ?? pkg.name
  if (name === '') return 'A part needs a name.'
  // a category spelled as the one it already is: a standard name as the app spells it, another as the first part
  // that named it, so a difference of case does not split a tab
  let category = pkg.category
  if (patch.category !== undefined) {
    const named = packageCategory({ category: patch.category })
    if (named.length > 64) return 'A category name can be at most 64 characters.'
    const known = listPackages().find((p) => p.id !== packageId && p.category !== undefined && sameCategory(p.category, named))
    category = known ? packageCategory(known) : named
  }
  if (name === pkg.name && category === pkg.category) return ''
  const next: PartPackage = { ...pkg, name }
  if (category !== undefined) next.category = category
  ec.store.commitPackage(name !== pkg.name ? 'Rename part' : 'Change part category', next)
  return ''
}

/** New part: a one-box rig, or (`from`) a rig, its models and its behavior that an import built, such as a URDF robot. */
/** What an import builds a new part from (a URDF robot): its name, rig, models, materials and behavior. */
export interface ImportedPart {
  name: string
  geometry: RigGeometry
  assets?: PartAsset[]
  materials?: PartMaterial[]
  behavior?: string
}

export function createBlankPart(ec: AuthoringDeps, from?: ImportedPart): string | null {
  if (ec.readOnly) return null
  const packageId = addNewPart(ec.store, from)
  // Open the new package as its own scene to author it, reusing the Catalog ✎ throwaway-draft session
  // (editPartPackage → enterPackageEdit): it stamps an origin instance so the rig-node tools are live,
  // but that instance is a draft in the session's own scene, never the document's, and goes on Back.
  // So a new part is added only to the catalog, never to the working scene; it reaches the scene
  // only when the user drags it in (placePart). editPartPackage selects the 'body' root node for us.
  // (Committing a real instance here would durably pollute the scene and the saved project.)
  ec.editPartPackage(packageId)
  return packageId
}

/** A new part in the project's library, without opening it: the one-box template, or `from`. Returns its id. */
export function addNewPart(store: AuthoringDeps['store'], from?: ImportedPart): string {
  // a free package id, skipping any already registered (e.g. a reload that restored user parts)
  let n = store.getState().userPackages.length + 1
  let packageId = `user.part-${n}`
  while (hasPackage(packageId)) packageId = `user.part-${++n}`
  const manifest: PackageManifest = {
    id: packageId,
    name: from?.name ?? `My Part ${n}`,
    category: 'Equipment',
    geometry: from?.geometry ?? { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.6, 0.6, 0.6] }, offset: [0, 0.3, 0] }], joints: [] },
    ...(from?.assets?.length ? { assets: from.assets } : {}),
    ...(from?.materials?.length ? { materials: from.materials } : {}),
  }
  // the name goes into a // comment, so a line break in it (a URDF robot's name can carry one) would end the comment
  const behavior = [
    `// ${manifest.name.replace(/[\r\n\u2028\u2029]+/g, ' ')} - a custom part. Its geometry (links/joints) lives in manifest.json; edit it in the`,
    `// app (select a node → Inspector) or here. This script is the behavior, run every simulation tick.`,
    `definePart({`,
    `  params: {},`,
    `  step(ctx) {`,
    `    // Command joints with ctx.setJoint('name', value); read your params via ctx.params.*`,
    `  },`,
    `})`,
    ``,
  ].join('\n')
  const pkg = buildPackage(manifest, from?.behavior ?? behavior)
  registerPackage(pkg)
  store.addUserPackage(pkg)
  return packageId
}
