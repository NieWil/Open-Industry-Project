// --- the rig-node editor: one internal node of a custom part, picked inside its open scene ---
// Its own module so the first frame does not carry it: it renders only once a node is selected, and the Inspector
// loads it lazily (rigNodeChunk.ts), starting when a part is opened as a scene.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent as ReactChangeEvent } from 'react'
import type { SdkPart } from '../../../core/types'
import { getPackage } from '../../../core/parts/partRegistry'
import { partDisplayName } from '../../../core/parts/partDisplayName'
import { inspectGlb } from '../../parts/glbInspect'
import type { RigJoint, RigLink, RigServo, RigShape } from '../../../core/parts/partPackage'
import { behaviorMentions } from '../../../core/parts/partPackage'
import { linkCollisionBox, partLinkOwnership } from '../../../core/rig/rigPose'
import type { LinkFieldOwner, LinkNote } from '../../../core/rig/rigPose'
import { AUTHORABLE_SHAPE_KINDS, canDeleteRigNode, convertShape, isAuthorableShapeKind, shapeLabel } from '../../rigTree'
import { keptNodes, movingPartCentre, reparentTargets, rigPivot, splitSourcesFor } from '../../rigSplit'
import { drawnElsewhere, meshLinkBox, parseGlb } from '../../../core/glbBox'
import { canSpin, canTwoPositions, DEFAULT_STROKE_TIME, readJointPlcConfig, type JointPlcMode } from '../../jointPlcControl'
import { base64ToBytes } from '../../../core/parts/partAssets'
import type { AuthorableShapeKind } from '../../rigTree'
import type { EditorStore } from '../../store/store'
import type { EditorController } from '../../controller'
import { AxisInput, BoolRow, Fold, NumberField, TextField, useShownLengthUnit, VectorRow } from './fields'
import { InspectorHeader } from './header'
import { DEFAULT_STEP_OPTIONS, importStep, isStepFile, type StepImportOptions } from '../../stepImport'
import { takePendingModel } from '../../parts/modelPartImport'
import {
  DEFAULT_USD_OPTIONS,
  importUsd,
  isUsdFile,
  missingUsdLayers,
  USD_TEXTURE_SIZES,
  usdFolderOf,
  usdRootCandidates,
  type UsdDetail,
  type UsdImportOptions,
} from '../../usdImport'
import type { StepDetail } from '../../stepConvert'
import { stepUpAxisGuess, type StepUpAxis, type StepUpAxisGuess } from '../../../core/stepToGlb'
import { PartActions, PartStatus } from './rig'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.rigNode', {
  aimsAt: 'aims at {target}',
  and: '{a} and {b}',
  axesSetBy: { one: '{axes} is set by {owner}', other: '{axes} are set by {owner}' },
  cantChange: { one: "{clauses}, so it can't be changed here.", other: "{clauses}, so they can't be changed here." },
  noteJointTurns: 'Joint {joint} turns this node from the pose set here (its rest pose).',
  noteJointSlides: 'Joint {joint} slides this node from the pose set here (its rest pose).',
  noteArrayWorld: 'This node is repeated on a world-wide pitch along X, so butted conveyors line up; moving it along X pulls the copies off that pitch.',
  noteArray: 'This node is repeated; moving it moves every copy.',
  noteDrawn: "The part's script draws on this node: the drawing moves with it, but its shape is the script's.",
  importing: 'Importing {file}…',
  imported: 'Imported {file}.',
  importedWarn: 'Imported {file}. {warning}',
  readFailed: 'Could not read the file.',
  notAModel: '{file} is not a model this importer can read. Export it again as glTF Binary (.glb), a STEP file or a USD file.',
  convertingStep: 'Converting {file} from STEP. A large assembly can take a minute.',
  nothingToImport: 'Nothing to import: all {solids} solids in {file} are smaller than {mm} mm.',
  importSummary: {
    one: 'Imported {file}: {solids} solids, {count} mesh, {k}k triangles, {size} m.',
    other: 'Imported {file}: {solids} solids, {count} meshes, {k}k triangles, {size} m.',
  },
  importSummarySkipped: {
    one: 'Imported {file}: {solids} solids, {skipped} under {mm} mm skipped, {count} mesh, {k}k triangles, {size} m.',
    other: 'Imported {file}: {solids} solids, {skipped} under {mm} mm skipped, {count} meshes, {k}k triangles, {size} m.',
  },
  summaryWarn: '{summary} {warning}',
  importFailed: 'Could not import {file}: {error}',
  nodeOf: 'A node of {part}',
  rigNodeNoCopies: 'Node in “{part}”. Edits here change the part itself (it has no placed copies in this scene).',
  rigNodeCopies: {
    one: 'Node in “{part}”. Edits here change the part itself, so its {count} placed copy in this scene follows.',
    other: 'Node in “{part}”. Edits here change the part itself, so all {count} placed copies in this scene follow.',
  },
  link: 'Placement',
  parent: 'Parent',
  rigRoot: '(root)',
  parentTip: 'The node this one hangs off. Its offset, rotation and joint are all relative to this parent, so moving the parent moves this node with it.',
  offset: 'Offset ({unit})',
  offsetTip: 'Local position relative to the parent node (the part root if none)',
  setOnEachPlaced: { one: '{params} is set on each placed {part}, not here.', other: '{params} are set on each placed {part}, not here.' },
  goToParamTip: 'Select the part and go to its {param}, which sets part of this node',
  changeParam: 'Change {param}',
  rotation: 'Rotation (°)',
  rotationTip: 'Local rotation relative to the parent node',
  rotationAimAt: "Its rotation is set by its aim at {target}, so it can't be changed here.",
  rotationAim: "Its rotation is set by its aim, so it can't be changed here.",
  shape: 'Shape',
  kindTip:
    "What this node is drawn as. “Frame” draws nothing and is just a pivot for its children; the primitives are editable here, while a scripted shape (roller, chain, a built deck) is sized by the part's build script and can only be replaced, not tuned.",
  kind: 'Kind',
  kindSelectTip: "Replace this node's shape, keeping its size and position",
  boxSize: 'Box size ({unit})',
  boxSizeTip: "Full extent along the node's local {ax}. The box is centered on the node origin, so it grows both ways. Shift it with Offset above.",
  cylinder: 'Cylinder ({unit})',
  radius: 'Radius',
  height: 'Height',
  cylinderRadiusTip: 'Cylinder radius.',
  cylinderHeightTip: "Length along the node's local Y (a cylinder stands up the Y axis). Rotate the node to lay it down.",
  cone: 'Cone ({unit})',
  coneRadiusTip: 'Radius of the base.',
  coneHeightTip: "Base-to-apex length along the node's local Y, apex pointing +Y. Rotate the node to aim it elsewhere.",
  mesh: 'Mesh',
  asset: 'Asset',
  assetTip: 'The model file backing this node, and the single node inside it being used (if any). Pick a different one from the list below.',
  scale: 'Scale',
  scaleTip: "Uniform multiplier on the imported model. 1 = the file's own size, so a model authored in centimeters needs 0.01.",
  glbNodes: "Nodes: click to use just one node as this node's mesh",
  wholeModelTip: 'Use the whole model',
  wholeModel: 'whole model',
  useNodeTip: "Use only the “{node}” node's geometry",
  glbMaterials: 'Materials in this model',
  darkTip: "Fully metallic and untextured. Renders dark without a recolor (map it to a matte material in the part's build script)",
  metal: 'metal {value}',
  textured: 'textured',
  rendersDark: '⚠ renders dark',
  frameHint: 'A frame node draws nothing. It is a pivot that child nodes hang off.',
  scriptedHint: 'A {kind} node is built and sized by the part script. Pick another kind above to replace it with a primitive you can edit here.',
  joint: 'Joint',
  name: 'Name',
  jointNameTip: "The name the behavior script drives this joint by: ctx.setJoint('{name}', value), or ctx.joints.{name} = value.",
  jointNameFixed: "The behavior script uses “{name}”, so it can't be renamed here. Change it in the script first (Edit Behavior…), then here.",
  jointNamePlc: "PLC control drives “{name}”, so it can't be renamed here. Set PLC control to None, rename it, then choose Two positions again.",
  jointNameFreeTip:
    "The name the behavior script drives this joint by: ctx.setJoint('{name}', value), or ctx.joints.{name} = value. The script doesn't use it yet, so it can be renamed freely.",
  jointNeedsName: 'A joint needs a name.',
  jointNameTaken: 'Another joint is already called “{name}”.',
  typeTip:
    'Revolute rotates the node about the axis below (value in radians); prismatic slides it along that axis (value in meters). Switching kind reinterprets Min/Max in the new units.',
  type: 'Type',
  axis: 'Axis {ax}',
  axisTurnTip:
    "{ax} component of the axis this joint turns about, in the node's own rest frame, so [0, 1, 0] is straight up before the node's Rotation is applied.\n\nOnly the DIRECTION counts: the axis is normalized, so [0, 2, 0] and [0, 1, 0] behave identically. Negate it to reverse which way a positive command moves the node.",
  axisSlideTip:
    "{ax} component of the axis this joint slides along, in the node's own rest frame, so [0, 1, 0] is straight up before the node's Rotation is applied.\n\nOnly the DIRECTION counts: the axis is normalized, so [0, 2, 0] and [0, 1, 0] behave identically. Negate it to reverse which way a positive command moves the node.",
  min: 'Min',
  max: 'Max',
  minRotTip: "Hard lower limit on the rotation. A script commanding past it is clamped, not ignored, so the node parks at the limit instead of failing. 0° is the node's rest pose.",
  maxRotTip: "Hard upper limit on the rotation. A script commanding past it is clamped, not ignored, so the node parks at the limit instead of failing. 0° is the node's rest pose.",
  minTravelTip:
    "Hard lower limit on the travel. A script commanding past it is clamped, not ignored, so the node parks at the limit instead of failing. 0 is the node's rest position; a negative limit lets it retract behind that.",
  maxTravelTip:
    "Hard upper limit on the travel: the node's stroke measured from its rest position along the axis above. A script commanding past it is clamped, not ignored.",
  pivot: 'Pivot ({unit})',
  pivotTip:
    "The point this joint turns about, in the part's coordinates. Changing it keeps everything where it is at rest: on a node that draws something, a frame is added above it to carry the joint, and the joint keeps its name.",
  pivotCentre: 'Pivot at centre',
  pivotCentreTip: 'Put the pivot at the centre of everything this joint moves. Type the pivot above to put it on a hinge line instead.',
  pivotLocked: 'A node above this one is rotated or placed by a parameter, so the pivot is set with Offset on the nodes instead.',
  split: 'Split into pieces',
  splitHereHint: 'Click a piece of the model to give it its own node under this one. It stays where it is, and can then get a joint.',
  splitUnderHint: 'Click a piece of “{source}” to move it with this node. It stays where it is at rest.',
  splitPieceTip: 'Split “{node}” out into its own node',
  splitNone: 'Every piece of this model is already split out.',
  mergeBack: 'Merge back into model',
  mergeBackTip: 'Undo the split: “{node}” goes back into “{source}” and this node is removed with its joint. Pieces under it move up and stay in place.',
  parentSelectTip: 'Move this node under another one. Its offset changes so it stays where it is.',
  spin: 'Spins endlessly',
  spinTip: 'Make this joint turn without end, like a drill spindle or a rotary table, instead of between Min and Max. The behavior runs it at a speed.',
  spinSpeed: 'Speed',
  spinSpeedTip: 'The top speed the spindle runs at, in turns per minute. The behavior can ask for less, never more.',
  spinUp: 'Spin-up time',
  spinUpTip: 'How long the spindle takes to get from standstill to the speed above, and to stop again.',
  spinHint: 'A spinning joint is run by the host, so the behavior starts and stops it with these lines. Replace true with your start condition, for example a PLC tag:',
  position: 'Position',
  positionTip: 'Drag across the field to move the joint between Min and Max and check it by eye, or type a value. Nothing is saved: the joint goes back to rest when you select another node.',
  testMotion: 'Test motion',
  stopTest: 'Stop test',
  testMotionTip: 'Move the joint from Min to Max and back twice, then return it to rest, to check the axis and limits. Works while the simulation is stopped.',
  plcControl: 'PLC control',
  plcControlTip: 'How a PLC drives this joint without code. Two positions and Spin write the behavior script for you; None leaves the script to you.',
  plcNone: 'None (behavior code)',
  plcTwoPositions: 'Two positions',
  plcSpin: 'Spin',
  plcSpinHint: "On each placed copy, the Comms fields name the PLC variables: Run is a BOOL the program writes (TRUE spins), Speed (rpm) an optional REAL it writes (empty: the copy's own speed, up to {rpm} rpm, the Speed above), At speed a BOOL it reads. Example names: Run, Speed, AtSpeed, or Main.Run for one inside a program on an external PLC.",
  strokeTime: 'Stroke time',
  strokeTimeTip: 'Time the joint takes from A to B, and back. Each placed copy can change it in its own Inspector.',
  plcHint: 'A is Min and B is Max. On each placed copy, the Comms fields name the PLC variables: Command (to B) is a BOOL the program writes, At A and At B are BOOLs it reads. Example names: ToB, AtA, AtB, or Main.ToB for one inside a program on an external PLC.',
  plcReplace: 'This part has its own behavior script. Two positions writes a new one in its place. Undo brings yours back. Continue?',
  removeJoint: 'Remove joint',
  addJointTip: 'Make this node articulated: add a joint the behavior script drives with ctx.setJoint(name, …)',
  addJoint: 'Add joint',
  node: 'Node',
  newNodeTip: 'The type of the next child node. “Add child node” below uses it.',
  newNode: 'New node',
  newNodeSelectTip: 'The type of the next child node',
  addChildTip: 'Add a child node of the chosen kind under this one',
  addChild: 'Add child node',
  onlyNodeTip: 'A part needs at least one node, and deleting this one would take every node with it',
  deleteNodeTip: 'Delete this node and its children',
  deleteNode: 'Delete node',
  importTip:
    "Replace this node's shape with an imported model, embedded in the part: a .glb, a STEP file (.step / .stp) from CAD, or a USD model (.usd / .usda / .usdc / .usdz)",
  converting: 'Converting…',
  importModel: 'Import model…',
  stepFileSize: '{name} ({mb} MB). Converting takes about 2 s per MB.',
  detailTip: 'How closely curved surfaces are followed. Coarse has about half the triangles, which a big assembly needs to stay light.',
  detail: 'Detail',
  detailNormal: 'normal',
  detailCoarse: 'coarse',
  upAxisTip:
    "Which of the file's axes points up. A STEP file does not record it: it follows the CAD program the model was drawn in. SolidWorks and Inventor usually draw Y-up; CATIA, NX, Creo, Solid Edge, Onshape and FreeCAD Z-up.\n\nIf the model comes in lying on its side, import it again with the other axis.",
  upAxis: 'Up axis',
  zUp: 'Z up',
  yUp: 'Y up',
  exportedFrom: 'Exported from {system}, which usually draws {up} up.',
  exportedThrough: 'Exported through {system}, which does not say how the model was drawn. Z up is assumed.',
  unknownSystem: 'The file does not say which program drew it. Z up is assumed.',
  skipUnder: 'Skip parts under',
  skipUnderTip:
    "Leave out solids whose overall size (bounding-box diagonal) is under this. Screws, nuts and washers are often a third of an assembly's solids and add nothing to a simulation.\n\n0 keeps everything.",
  mergeByColour: 'Merge by color',
  mergeByColourTip:
    'One mesh per color instead of one per solid. A machine assembly of hundreds of solids then draws as a handful of meshes.\n\nTurn it off to keep each solid as its own named node, for example to split moving parts into nodes of their own.',
  convertAndImport: 'Convert and import',
  cancel: 'Cancel',
  usdFile: '{name} ({size}).',
  usdFolder: { one: 'Folder {name}: {count} file.', other: 'Folder {name}: {count} files.' },
  usdChecking: 'Checking which files the model pulls in…',
  usdNeedsFolder: {
    one: 'This file is the index of a model: it pulls in {count} file that is not here, a layer or texture beside it. Pick the folder it is in to import the whole model.',
    other: 'This file is the index of a model: it pulls in {count} files that are not here, layers and textures beside it. Pick the folder it is in to import the whole model.',
  },
  usdPickFolder: 'Pick its folder…',
  usdPickFolderTip: "Pick the model's folder, so every file the model pulls in comes with it",
  usdNoModelInFolder: 'The folder {name} has no USD file (.usd / .usda / .usdc / .usdz).',
  usdRoot: 'Model file',
  usdRootTip: 'The file the model starts from. Its folder has several USD files at the top level; the others are usually variants or parts of it.',
  usdDetailTip:
    'Reduced simplifies each mesh to about a quarter of its triangles, keeping texture seams in place. Models made for rendering are often far heavier than a simulation needs; cargo spawned by the hundred needs reduced.',
  usdDetailFull: 'full',
  usdDetailReduced: 'reduced',
  usdTextureSize: 'Texture size',
  usdTextureSizeTip: 'The longest side of each imported texture. Larger is sharper up close and heavier to download and draw.',
  convertingUsd: 'Converting {file} from USD… {pct}%',
  usdImportSummary: {
    one: 'Imported {file}: {parts} parts, {count} mesh, {k}k triangles, {size} m.',
    other: 'Imported {file}: {parts} parts, {count} meshes, {k}k triangles, {size} m.',
  },
  usdImportSummaryReduced: {
    one: 'Imported {file}: {parts} parts, {count} mesh, {k}k triangles (from {k0}k), {size} m.',
    other: 'Imported {file}: {parts} parts, {count} meshes, {k}k triangles (from {k0}k), {size} m.',
  },
  usdWarnings: { one: '{count} thing could not be shown as authored: {first}', other: '{count} things could not be shown as authored, for example: {first}' },
  usdMissingLayers: 'Some files the model pulls in were not found: import its folder to include them.',
  usdNothingDrawn: 'Nothing to import: {file} has no meshes this importer can read.',
  usdHeavy: 'At {k}k triangles this model is heavy for a simulation, above all as cargo placed many times: import it again with Detail reduced for about a quarter of that.',
  fittedToModel: "The part now fits the model: it stands on the floor, and its footprint and collider are the model's size.",
  placeFitted: 'To place it, go back to the scene (‹ Scene, top left) and drag “{name}” from the Parts dock.',
})

/** past this, a full-detail import suggests reduced: a few such models fill a scene's triangle budget */
const HEAVY_TRIANGLES = 100_000

/** a file's size as people read it: KB under a megabyte */
const fileSize = (bytes: number): string => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`) // i18n-ok: units

/** A USD model picked for import: one file, or a folder and the file in it the model starts from. */
interface UsdPick {
  /** every picked file, keyed by its path inside the pick (what the USD reader resolves layer paths against) */
  files: Map<string, Blob>
  /** the files the model could start from; more than one only for a folder */
  roots: string[]
  root: string
  /** the file or folder name, as shown */
  label: string
  /** a lone file's size; 0 for a folder */
  bytes: number
  folder: boolean
  /** layers and textures a lone file pulls in that were not handed over: null while that is checked, 0 for a folder */
  missing: number | null
}

/**
 * Author-mode editor for a rig-node selection: one internal link of a custom part, picked inside its open
  scene. Its geometry (offset, rest rotation, shape), joint and child nodes are EDITABLE here and apply live
 * to the part definition, so every placed copy changes. Edits go through the controller's package edits
 * (store.commitPackage), one scene-undo step each, and land in the project's parts (stored with the project,
 * on the desktop in its folder) like any other edit - there is nothing separate to save.
 */
export function RigNodePanel({
  part,
  link,
  joint,
  store,
  controller,
  buildError,
  placedCopies,
  definitionSession,
  focused,
  running,
}: {
  part: SdkPart
  link: RigLink
  joint: RigJoint | undefined
  store: EditorStore
  controller: EditorController | null
  /** the package's latest blocked/failed edit diagnostics (state.packageBuildErrors), echoed inline */
  buildError?: string
  /** placed copies of this part in the scene, which an edit here changes (treeNode.placedCopiesOf) */
  placedCopies: number
  /** this node belongs to a definition session's throwaway copy (Catalog ✎), not a placed part: its params
   *  are thrown away with it, so a param that owns a field is pointed at, not offered */
  definitionSession: boolean
  /** the part is the open scene (state.focusedPartId): the header's scene button closes it */
  focused: boolean
  /** the sim is running: the host poses the rig then, so Test motion and Position are off */
  running: boolean
}) {
  const [msg, setMsg] = useState<string | null>(null)
  // the sections' folds, as the part Inspector's (Fold): open until closed, for as long as the panel is up
  // the Mesh details (asset, scale, the model's material list) start folded: they run long and are rarely needed
  const [folds, setFolds] = useState<Record<string, boolean>>({ 'Shape/Mesh': true })
  const toggle = (path: string): void => setFolds((c) => ({ ...c, [path]: !(c[path] ?? false) }))
  const editable = controller !== null
  const lengthUnit = useShownLengthUnit()
  // lengths are stored in metres and shown in the scene's Length by the fields; a 1 mm arrow step suits part-sized nodes
  const lenStep = 0.001
  // a part needs one node (controller.deleteRigNode refuses to empty a rig, as the scene tree's Delete does)
  const pkgGeometry = getPackage(part.packageId)?.geometry
  // the joint's name is renamable here only while the behavior never mentions it (controller.renameRigJoint)
  const jointMentioned = !!joint && behaviorMentions(getPackage(part.packageId)?.behavior ?? '', joint.name)
  // Who owns which field (core linkFieldOwnership, held to the resolver by linkOwnership.test.ts): a field the part
  // sets itself is read-only here and says what sets it - an edit to it would be overwritten - and what is true of
  // the node without owning a field (a joint, an array, the script drawing on it) is a line below.
  const ownPkg = getPackage(part.packageId)
  const own = ownPkg ? partLinkOwnership(ownPkg, link.name, part.params) : null
  const ownerName = (o: LinkFieldOwner | null | undefined): string | undefined => {
    if (!o) return undefined
    if (o.by === 'aim') return t(M.aimsAt, { target: o.target })
    const spec = (ownPkg?.params as Record<string, { label?: string } | undefined> | undefined)?.[o.param]
    return spec?.label ?? o.param
  }
  // "Y and Z are set by Width" - one line under a row, naming each owner once
  const ownedLine = (owners: readonly (LinkFieldOwner | null)[]): string | null => {
    const byName = new Map<string, string[]>()
    owners.forEach((o, i) => {
      const n = ownerName(o)
      if (n) byName.set(n, [...(byName.get(n) ?? []), 'XYZ'[i]!])
    })
    if (byName.size === 0) return null
    const parts = [...byName].map(([n, axes]) =>
      t(M.axesSetBy, { count: axes.length, axes: axes.reduce((a, b) => t(M.and, { a, b })), owner: n }),
    )
    const one = byName.size === 1 && [...byName.values()][0]!.length === 1
    return t(M.cantChange, { count: one ? 1 : 2, clauses: parts.join('; ') })
  }
  const noteText = (n: LinkNote): string =>
    n.kind === 'joint'
      ? t(n.type === 'revolute' ? M.noteJointTurns : M.noteJointSlides, { joint: n.joint })
      : n.kind === 'array'
        ? n.worldPhase
          ? t(M.noteArrayWorld)
          : t(M.noteArray)
        : t(M.noteDrawn)
  const offsetOwned = own ? ownedLine(own.offset) : null
  // the params that own any of this node's fields, once each: the way to change what the panel can't
  const ownerParams = own
    ? [...new Set([...own.offset, ...(own.boxSize ?? []), own.cylinder?.radius ?? null, own.cylinder?.height ?? null].flatMap((o) => (o?.by === 'param' ? [o.param] : [])))]
    : []
  const paramLabel = (param: string): string => ownerName({ by: 'param', param }) ?? param
  // bumped when a rename is refused, so the field remounts showing the stored name again; the reason shows under it
  const [jointNameRev, setJointNameRev] = useState(0)
  const [jointNameMsg, setJointNameMsg] = useState<string | null>(null)
  // deleting takes the node's subtree, so a root holding every node can't go either (rigTree canDeleteRigNode)
  const onlyNode = pkgGeometry?.kind === 'rig' && !canDeleteRigNode(pkgGeometry, link.name)
  const row = (key: string, value: string, tip?: string) => (
    <div className="rig-joint" title={tip}>
      <span className="rig-joint-name">{key}</span>
      <span className="rig-joint-meta">{value}</span>
    </div>
  )
  const rot = link.rotation ?? [0, 0, 0]
  const setOffset = (i: number, v: number): void => {
    const o: [number, number, number] = [link.offset[0], link.offset[1], link.offset[2]]
    o[i] = v
    controller?.editRigLink(part.packageId, link.name, { offset: o })
  }
  const setRotation = (i: number, deg: number): void => {
    const r: [number, number, number] = [rot[0]!, rot[1]!, rot[2]!]
    r[i] = (deg * Math.PI) / 180
    controller?.editRigLink(part.packageId, link.name, { rotation: r })
  }
  const setShape = (shape: RigShape): void => controller?.editRigLink(part.packageId, link.name, { shape })
  // what + Add child node drops in. Panel-local: a preference for the next add, not part data.
  const [addKind, setAddKind] = useState<AuthorableShapeKind>('box')
  // M3: import a .glb and make this node a mesh of it. Read the file as base64 (readAsDataURL handles
  // multi-MB binaries; we strip the data: prefix), then embed it in the package via controller.setLinkMesh.
  // A STEP file stops first at its options (stepFile), then goes through the CAD kernel's worker to a GLB.
  const fileRef = useRef<HTMLInputElement>(null)
  const [stepFile, setStepFile] = useState<File | null>(null)
  const [stepOptions, setStepOptions] = useState<StepImportOptions>({ detail: 'normal', ...DEFAULT_STEP_OPTIONS })
  const [stepGuess, setStepGuess] = useState<StepUpAxisGuess | null>(null)
  const [converting, setConverting] = useState(false)
  // A USD model stops at its options too (usdPick). It is often several files - a root layer pulling in others
  // beside it - and a page can only read files it was handed, so a model can also be picked as its folder.
  const folderRef = useRef<HTMLInputElement>(null)
  const [usdPick, setUsdPick] = useState<UsdPick | null>(null)
  const [usdOptions, setUsdOptions] = useState<UsdImportOptions>(DEFAULT_USD_OPTIONS)
  const onPickModel = (e: ReactChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked
    if (file) pickModelFile(file)
  }
  // a model file handed over by Import part (parts/modelPartImport.ts), which made this part for it
  useEffect(() => {
    const file = takePendingModel(part.packageId)
    if (file) pickModelFile(file)
    // once per part opened: the hand-over is taken once
  }, [part.packageId])
  const pickModelFile = (file: File): void => {
    if (!controller) return
    if (isUsdFile(file.name)) {
      setMsg(null)
      setStepFile(null)
      // a .usdz carries everything it needs; another USD file may be only an index of the files beside it
      const packaged = /\.usdz$/i.test(file.name)
      setUsdPick({ files: new Map([[file.name, file]]), roots: [file.name], root: file.name, label: file.name, bytes: file.size, folder: false, missing: packaged ? 0 : null })
      if (!packaged) void completeLoneUsd(file)
      return
    }
    if (isStepFile(file.name)) {
      setUsdPick(null)
      setMsg(null)
      // the header names the exporting program, whose default up axis preselects the choice
      void file
        .slice(0, 16384)
        .text()
        .then(
          (head) => stepUpAxisGuess(head),
          () => stepUpAxisGuess(''),
        )
        .then((guess) => {
          setStepGuess(guess)
          setStepOptions((o) => ({ ...o, upAxis: guess.up }))
          setStepFile(file)
        })
        .catch((e: unknown) => console.warn('[oip] reading the STEP header failed', e))
      return
    }
    setMsg(t(M.importing, { file: file.name }))
    file.arrayBuffer().then(
      (buf) => {
        // a big model still imports; the warning is advisory (the autosave banner is the real alarm)
        const { warning, fitted, unreadable } = controller.setLinkMesh(part.packageId, link.name, new Uint8Array(buf))
        if (unreadable) return setMsg(t(M.notAModel, { file: file.name }))
        setMsg(withFit(warning ? t(M.importedWarn, { file: file.name, warning }) : t(M.imported, { file: file.name }), fitted))
      },
      () => setMsg(t(M.readFailed)),
    )
  }
  /** an import's message, and the line saying the part was fitted to the model when it was */
  const withFit = (summary: string, fitted: boolean): string => (fitted ? `${summary} ${fittedLine()}` : summary)
  // a part that is just its model is ready to place: say where it went and how to put it in the scene
  const fittedLine = (): string => `${t(M.fittedToModel)} ${t(M.placeFitted, { name: getPackage(part.packageId)?.name ?? '' })}`
  // the node is captured at the start: a conversion outlives a selection change and still lands where it began
  const convertStepFile = async (): Promise<void> => {
    const file = stepFile
    if (!file || !controller) return
    const options = stepOptions
    setStepFile(null)
    setConverting(true)
    setMsg(t(M.convertingStep, { file: file.name }))
    try {
      const { glb, stats } = await importStep(new Uint8Array(await file.arrayBuffer()), options)
      if (stats.meshes === 0) {
        setMsg(t(M.nothingToImport, { solids: stats.solids, file: file.name, mm: options.minPartMm }))
        return
      }
      const { warning, fitted } = controller.setLinkMesh(part.packageId, link.name, glb)
      const size = stats.size.map((s) => s.toFixed(2)).join(' x ')
      const counts = { file: file.name, solids: stats.solids, count: stats.meshes, k: Math.round(stats.triangles / 1000), size }
      const summary = withFit(
        stats.skipped ? t(M.importSummarySkipped, { ...counts, skipped: stats.skipped, mm: options.minPartMm }) : t(M.importSummary, counts),
        fitted,
      )
      setMsg(warning ? t(M.summaryWarn, { summary, warning }) : summary)
    } catch (err) {
      setMsg(t(M.importFailed, { file: file.name, error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setConverting(false)
    }
  }
  // A lone USD layer, before anything is converted. On the desktop its folder is read with it, so the model comes
  // whole; in a browser, which reads only what it was handed, whatever it pulls in that is missing is counted, and
  // the panel asks for the folder rather than converting an index into nothing.
  const completeLoneUsd = async (file: File): Promise<void> => {
    const still = (p: UsdPick | null): p is UsdPick => !!p && !p.folder && p.root === file.name
    const desktop = await usdFolderOf(file).catch(() => null)
    if (desktop) {
      setUsdPick((p) => (still(p) ? { files: desktop.files, roots: [desktop.root], root: desktop.root, label: desktop.folder, bytes: 0, folder: true, missing: 0 } : p))
      return
    }
    const missing = await missingUsdLayers(new Map([[file.name, file]]), file.name)
    setUsdPick((p) => (still(p) ? { ...p, missing } : p))
  }
  const onPickFolder = (e: ReactChangeEvent<HTMLInputElement>): void => {
    const picked = [...(e.target.files ?? [])]
    e.target.value = ''
    if (picked.length === 0 || !controller) return
    // keyed as the reader resolves them: each file's path inside the picked folder
    const files = new Map<string, Blob>(picked.map((f) => [f.webkitRelativePath || f.name, f]))
    const folder = (picked[0]!.webkitRelativePath || picked[0]!.name).split('/')[0]!
    const roots = usdRootCandidates([...files.keys()])
    if (roots.length === 0) {
      setMsg(t(M.usdNoModelInFolder, { name: folder }))
      return
    }
    // the file picked first, if it is one of the folder's candidates
    const first = usdPick && !usdPick.folder ? roots.find((r) => r.endsWith('/' + usdPick.root)) : undefined
    setMsg(null)
    setUsdPick({ files, roots, root: first ?? roots[0]!, label: folder, bytes: 0, folder: true, missing: 0 })
  }
  const convertUsdFile = async (): Promise<void> => {
    const pick = usdPick
    if (!pick || !controller) return
    const options = usdOptions
    const file = pick.root.split('/').pop()!
    setUsdPick(null)
    setConverting(true)
    setMsg(t(M.convertingUsd, { file, pct: 0 }))
    try {
      const { glb, stats } = await importUsd(pick.files, pick.root, options, (f) => setMsg(t(M.convertingUsd, { file, pct: Math.round(f * 100) })))
      // a lone file whose layers are elsewhere: say so first, it is the likely reason for whatever went missing
      const missingLayers = !pick.folder && stats.warnings.some((w) => w.code === 'layer-missing')
      if (stats.meshes === 0) {
        setMsg([t(M.usdNothingDrawn, { file }), ...(missingLayers ? [t(M.usdMissingLayers)] : [])].join(' '))
        return
      }
      const { warning, fitted } = controller.setLinkMesh(part.packageId, link.name, glb)
      const counts = { file, parts: stats.parts, count: stats.meshes, k: Math.round(stats.triangles / 1000), size: stats.size.map((s) => s.toFixed(2)).join(' x ') }
      const reduced = stats.triangles < stats.sourceTriangles
      const lines = [reduced ? t(M.usdImportSummaryReduced, { ...counts, k0: Math.round(stats.sourceTriangles / 1000) }) : t(M.usdImportSummary, counts)]
      if (fitted) lines.push(fittedLine())
      // a heavy model at full detail: say what reduced would give, since only now is its size known
      if (!reduced && stats.triangles > HEAVY_TRIANGLES) lines.push(t(M.usdHeavy, { k: Math.round(stats.triangles / 1000) }))
      if (missingLayers) lines.push(t(M.usdMissingLayers))
      else if (stats.warnings.length) lines.push(t(M.usdWarnings, { count: stats.warnings.length, first: stats.warnings[0]!.message }))
      if (warning) lines.push(warning)
      setMsg(lines.join(' '))
    } catch (err) {
      setMsg(t(M.importFailed, { file, error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setConverting(false)
    }
  }
  // Introspect an imported (embedded) GLB so the author can SEE its node + material names instead of
  // reverse-engineering them - the discovery affordance behind shape.node / shape.materials. URL-referenced
  // assets (committed parts) carry no `data`, so there's nothing to parse; the panel just stays hidden.
  const meshAsset =
    link.shape.kind === 'mesh' ? (getPackage(part.packageId)?.assets ?? []).find((a) => a.id === (link.shape as Extract<RigShape, { kind: 'mesh' }>).asset) : undefined
  const glb = useMemo(() => (meshAsset?.data ? inspectGlb(meshAsset.data) : null), [meshAsset?.data])

  // Split into pieces: the whole-scene model this node can take pieces from (itself, or an ancestor it lines up
  // with), and that model's nodes still drawn there. Nodes come from the asset's own GLB, not this link's.
  const pkgAssets = ownPkg?.assets
  const rig = pkgGeometry?.kind === 'rig' ? pkgGeometry : null
  const splitSource = rig ? (splitSourcesFor(rig, link.name)[0] ?? null) : null
  const splitAsset = splitSource?.shape.kind === 'mesh' ? splitSource.shape.asset : undefined
  const splitAssetData = (pkgAssets ?? []).find((a) => a.id === splitAsset)?.data
  const splitGlb = useMemo(() => (splitAssetData ? inspectGlb(splitAssetData) : null), [splitAssetData])
  const splitHidden = splitSource?.shape.kind === 'mesh' ? new Set(splitSource.shape.hideNodes ?? []) : new Set<string>()
  // a node a link already keeps is not offered again, so a piece is never split out twice
  const kept = rig && splitAsset ? keptNodes(rig, splitAsset) : new Set<string>()
  const splitCandidates = splitGlb ? splitGlb.nodes.filter((n) => !splitHidden.has(n) && !kept.has(n)) : []
  const pivot = rig && joint ? rigPivot(rig, link.name) : null
  const setPivot = (p: [number, number, number]): void => {
    controller?.rig.setRigJointPivot(part.packageId, link.name, p)
  }
  // the GLBs are parsed on the click, not on every render: an imported CAD model can be megabytes of base64
  const centrePivot = (): void => {
    if (!rig) return
    const json = new Map<string, unknown>()
    const jsonOf = (asset: string): unknown => {
      if (!json.has(asset)) {
        const bytes = base64ToBytes((pkgAssets ?? []).find((a) => a.id === asset)?.data ?? '')
        let parsed: unknown = null
        try {
          parsed = bytes ? parseGlb(bytes).json : null
        } catch {
          // not a GLB: nothing to measure
        }
        json.set(asset, parsed)
      }
      return json.get(asset)
    }
    const c = movingPartCentre(rig, link.name, (l) => {
      if (l.shape.kind !== 'mesh') return null
      const j = jsonOf(l.shape.asset)
      return j ? meshLinkBox(j, { ...l.shape, drawnElsewhere: drawnElsewhere(rig.links, l) }) : null
    })
    if (c) setPivot(c)
  }

  // M4: add / edit / remove the joint that articulates this node (the script drives it by name).
  const revolute = joint?.type === 'revolute'
  const addJoint = (): void => controller?.setRigJoint(part.packageId, link.name, { type: 'revolute', axis: [0, 1, 0], min: -Math.PI / 2, max: Math.PI / 2 })
  const removeJoint = (): void => controller?.setRigJoint(part.packageId, link.name, null)
  // Spins endlessly: a revolute servo that wraps a full turn (servo.modulo), run at a speed by the behavior with
  // ctx.servos.<name>.moveVelocity. Its min / max must cover 0 to the turn, and the host poses it, not ctx.joints.
  const TURN = 2 * Math.PI
  const spinning = revolute && joint?.servo?.modulo !== undefined
  const editJoint = (patch: { type?: 'revolute' | 'prismatic'; axis?: [number, number, number]; min?: number; max?: number; servo?: RigServo | null }): void => {
    if (!joint) return
    // leaving revolute ends the spin, and its 0..360° limits would read as metres
    if (spinning && patch.type === 'prismatic') patch = { min: 0, max: 0.1, servo: null, ...patch }
    // limits never cross: the bound being edited stops at the other one rather than inverting the range
    let min = patch.min ?? joint.min
    let max = patch.max ?? joint.max
    if (min > max) {
      if (patch.min !== undefined) min = max
      else max = min
    }
    controller?.setRigJoint(part.packageId, link.name, {
      type: patch.type ?? joint.type,
      axis: patch.axis ?? [joint.axis[0], joint.axis[1], joint.axis[2]],
      min,
      max,
      ...(patch.servo !== undefined ? { servo: patch.servo } : {}),
    })
  }
  const toRad = (deg: number): number => (deg * Math.PI) / 180
  const rpmToRad = (rpm: number): number => (rpm * TURN) / 60
  const radToRpm = (w: number): number => (w * 60) / TURN
  // on: 60 rpm, up to speed in 0.5 s. Off: back to a plain joint with the default quarter-turn limits.
  const setSpinning = (on: boolean): void =>
    on
      ? editJoint({ min: 0, max: TURN, servo: { maxVelocity: rpmToRad(60), maxAccel: rpmToRad(60) / 0.5, modulo: TURN } })
      : editJoint({ min: -Math.PI / 2, max: Math.PI / 2, servo: null })
  const spinServo = spinning ? joint!.servo! : null
  // Two positions: the panel writes the behavior (jointPlcControl.ts) and reads the mode back from it
  const plcConfig = readJointPlcConfig(ownPkg?.behavior ?? '')
  const plcMode = joint ? (plcConfig?.[joint.name] ?? null) : null
  const twoPositions = plcMode?.mode === 'twoPositions' ? plcMode : null
  const spinPlc = plcMode?.mode === 'spin'
  const setPlcControl = (mode: JointPlcMode | null): void => {
    if (joint) controller?.rig.setJointPlcControl(part.packageId, joint.name, mode, () => window.confirm(t(M.plcReplace)))
  }
  const setSpinSpeed = (rpm: number): void => {
    if (!spinServo) return
    const w = rpmToRad(Math.max(1, rpm))
    const rampS = spinServo.maxVelocity / spinServo.maxAccel
    editJoint({ servo: { ...spinServo, maxVelocity: w, maxAccel: w / rampS } })
  }
  const setSpinUp = (seconds: number): void => {
    if (!spinServo) return
    editJoint({ servo: { ...spinServo, maxAccel: spinServo.maxVelocity / Math.max(0.01, seconds) } })
  }

  // Test motion: sweep the joint Min -> Max -> Min twice through the view's idle-pose path (the one a stopped part's
  // settled pose uses), then put every joint back at rest. Nothing is written to the part.
  const view = controller?.view ?? null
  const testFrame = useRef<number | null>(null)
  const [testing, setTesting] = useState(false)
  // Position: the joint posed by hand from the panel (its own units: radians or metres), through the same idle-pose
  // path as Test motion. Panel-local, never written to the part; back to rest when the joint changes or the panel goes.
  const [posed, setPosed] = useState(0)
  const jointKey = joint ? `${joint.name}:${joint.type}:${joint.min}:${joint.max}` : ''
  const poseRange: [number, number] | null = joint ? (spinning ? [0, TURN] : [joint.min, joint.max]) : null
  const poseJoint = (v: number): void => {
    if (!joint || !view || !poseRange) return
    const at = Math.min(Math.max(v, poseRange[0]), poseRange[1])
    setPosed(at)
    view.applyIdlePose(part.id, { joints: { [joint.name]: at } })
  }
  const stopTest = (): void => {
    if (testFrame.current !== null) cancelAnimationFrame(testFrame.current)
    testFrame.current = null
    setTesting(false)
    setPosed(0)
    view?.applyIdlePose(part.id, { joints: {} })
  }
  const startTest = (): void => {
    if (!joint || !view) return
    const { name, min, max } = joint
    const periodMs = 3000
    const cycles = 2
    // a spinning joint turns at its speed for the same time instead of sweeping its limits
    const spinRate = spinning && joint.servo ? joint.servo.maxVelocity : null
    const t0 = performance.now()
    const tick = (now: number): void => {
      const t = (now - t0) / periodMs
      if (t >= cycles) return stopTest()
      // a sweep starts at Min, reaches Max at half a period, eases at both ends
      const v = spinRate !== null ? (spinRate * (now - t0) / 1000) % TURN : min + ((max - min) * (1 - Math.cos(2 * Math.PI * t))) / 2
      view.applyIdlePose(part.id, { joints: { [name]: v } })
      testFrame.current = requestAnimationFrame(tick)
    }
    setTesting(true)
    testFrame.current = requestAnimationFrame(tick)
  }
  // A test still running, or a joint posed by hand, goes back to rest when another node is selected (the Inspector
  // keeps this panel and swaps its props, so that is a change of link, not an unmount), when the joint's limits or
  // type change, when the sim starts, and when the panel goes. Only then: a rest pose on every open would undo a
  // behavior-settled one. The part and view are the ones this effect ran for: by cleanup time the props may name the
  // next part, and the posed one is the previous.
  const posedRef = useRef(posed)
  posedRef.current = posed
  useEffect(() => {
    const partId = part.id
    const v = view
    return () => {
      const wasPosed = testFrame.current !== null || posedRef.current !== 0
      if (testFrame.current !== null) cancelAnimationFrame(testFrame.current)
      testFrame.current = null
      if (!wasPosed) return
      setTesting(false)
      setPosed(0)
      v?.applyIdlePose(partId, { joints: {} })
    }
  }, [part.id, link.name, jointKey, running, view])

  // Parent: the nodes this one can move under while staying in place (rigSplit.reparentTargets)
  const parentOptions = rig ? reparentTargets(rig, link.name) : []
  // Merge back: a split piece goes back into the model node it came from
  const mergeSource = link.shape.kind === 'mesh' && link.shape.keepNode ? splitSource : null

  const s = link.shape
  return (
    <div className="inspector" data-testid="rig-node-panel">
      <InspectorHeader
        title={link.name}
        tooltip={t(M.nodeOf, { part: partDisplayName(part, [part]) })}
        actions={<PartActions part={part} focused={focused} />}
      />
      {/* the part's own state, as on the part's Inspector: the node is an edit of the same definition */}
      <PartStatus part={part} store={store} controller={controller} buildError={buildError} />
      <p className="inspector-hint">
        {placedCopies === 0
          ? t(M.rigNodeNoCopies, { part: partDisplayName(part, [part]) })
          : t(M.rigNodeCopies, { count: placedCopies, part: partDisplayName(part, [part]) })}
      </p>
      <Fold title={t(M.link)} path="Link" collapsed={folds} toggle={toggle}>
        {editable && parentOptions.length > 1 ? (
          <label className="field">
            <span className="field-label" title={t(M.parentTip)}>
              {t(M.parent)}
            </span>
            <span className="field-control">
              <select
                className="rig-select"
                data-testid="rig-parent"
                value={link.parent ?? ''}
                title={t(M.parentSelectTip)}
                onChange={(e) => controller?.rig.reparentRigLink(part.packageId, link.name, e.target.value === '' ? undefined : e.target.value)}
              >
                {parentOptions.map((p) => (
                  <option key={p ?? ''} value={p ?? ''}>
                    {p ?? t(M.rigRoot)}
                  </option>
                ))}
              </select>
            </span>
          </label>
        ) : (
          row(t(M.parent), link.parent ?? t(M.rigRoot), t(M.parentTip))
        )}

        {/* Same compact X/Y/Z transform row a scene part uses; the only real difference is that a
            rig link's transform is LOCAL (relative to its parent link), so the labels say so. */}
        <VectorRow label={t(M.offset, { unit: lengthUnit })} tooltip={t(M.offsetTip)}>
          {([0, 1, 2] as const).map((axis) => (
            <AxisInput
              key={axis}
              prefix={['X', 'Y', 'Z'][axis]!}
              value={link.offset[axis]!}
              decimals={3}
              step={lenStep}
              entryUnit="m"
              disabled={!editable || !!own?.offset[axis]}
              onCommit={(v) => setOffset(axis, v)}
            />
          ))}
        </VectorRow>
        {offsetOwned && (
          <p className="inspector-hint rig-owned" data-testid="node-owned-offset">
            {offsetOwned}
          </p>
        )}
        {ownerParams.length > 0 &&
          (definitionSession ? (
            // the copy on screen is a throwaway: its params go with it, so there is nothing real to change here
            <p className="inspector-hint rig-owned" data-testid="node-owner-placement">
              {t(M.setOnEachPlaced, { count: ownerParams.length, params: ownerParams.map(paramLabel).join(', '), part: partDisplayName(part, [part]) })}
            </p>
          ) : (
            <div className="rig-script-actions" data-testid="node-owner-buttons">
              {ownerParams.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="array-add"
                  disabled={!editable}
                  title={t(M.goToParamTip, { param: paramLabel(p) })}
                  onClick={() => controller?.store.requestParamFocus(part.id, p)}
                >
                  {t(M.changeParam, { param: paramLabel(p) })}
                </button>
              ))}
            </div>
          ))}
        <VectorRow label={t(M.rotation)} tooltip={t(M.rotationTip)}>
          {([0, 1, 2] as const).map((axis) => (
            <AxisInput
              key={axis}
              prefix={['X', 'Y', 'Z'][axis]!}
              value={(rot[axis]! * 180) / Math.PI}
              decimals={1}
              step={1}
              disabled={!editable || !!own?.rotation}
              onCommit={(v) => setRotation(axis, v)}
            />
          ))}
        </VectorRow>
        {own?.rotation && (
          <p className="inspector-hint rig-owned" data-testid="node-owned-rotation">
            {own.rotation.by === 'aim' ? t(M.rotationAimAt, { target: own.rotation.target }) : t(M.rotationAim)}
          </p>
        )}
        {own?.notes.map((n) => (
          <p key={n.kind} className="inspector-hint" data-testid={`node-note-${n.kind}`}>
            {noteText(n)}
          </p>
        ))}

        {/* The shape selector. Its value is always the link's real kind, so an appliance link (roller, chain,
            leg, a scripted deck) reads truthfully even though the panel can't build one; only the kinds
            `convertShape` can construct are selectable, and switching carries the dimensions across. */}
      </Fold>
      <Fold title={t(M.shape)} path="Shape" collapsed={folds} toggle={toggle}>
        <label className="field">
          <span className="field-label" title={t(M.kindTip)}>
            {t(M.kind)}
          </span>
          <span className="field-control">
            <select
              className="rig-select"
              value={s.kind}
              disabled={!editable}
              title={t(M.kindSelectTip)}
              onChange={(e) => {
                if (isAuthorableShapeKind(e.target.value)) setShape(convertShape(s, e.target.value, linkCollisionBox(link)))
              }}
            >
              {AUTHORABLE_SHAPE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
              {/* the kind alone: a mesh's node is the Mesh section's Asset row, and named here it ran off the field */}
              {!isAuthorableShapeKind(s.kind) && (
                <option value={s.kind} disabled>
                  {s.kind}
                </option>
              )}
            </select>
          </span>
        </label>
        {s.kind === 'box' && (
          <Fold title={t(M.boxSize, { unit: lengthUnit })} path="Shape/Box" depth={1} collapsed={folds} toggle={toggle}>
            {(['X', 'Y', 'Z'] as const).map((ax, i) => (
              <NumberField
                key={ax}
                label={ax}
                unit="m"
                tooltip={t(M.boxSizeTip, { ax })}
                value={s.size[i]!}
                decimals={3}
                step={lenStep}
                min={0.001}
                badge={ownerName(own?.boxSize?.[i])}
                disabled={!editable || !!own?.boxSize?.[i]}
                onCommit={(v) => {
                  const size: [number, number, number] = [s.size[0], s.size[1], s.size[2]]
                  size[i] = Math.max(0.001, v)
                  setShape({ ...s, size })
                }}
              />
            ))}
          </Fold>
        )}
        {s.kind === 'cylinder' && (
          <Fold title={t(M.cylinder, { unit: lengthUnit })} path="Shape/Cylinder" depth={1} collapsed={folds} toggle={toggle}>
            <NumberField label={t(M.radius)} unit="m" tooltip={t(M.cylinderRadiusTip)} value={s.radius} decimals={3} step={lenStep} min={0.001} badge={ownerName(own?.cylinder?.radius)} disabled={!editable || !!own?.cylinder?.radius} onCommit={(v) => setShape({ ...s, radius: Math.max(0.001, v) })} />
            <NumberField label={t(M.height)} unit="m" tooltip={t(M.cylinderHeightTip)} value={s.height} decimals={3} step={lenStep} min={0.001} badge={ownerName(own?.cylinder?.height)} disabled={!editable || !!own?.cylinder?.height} onCommit={(v) => setShape({ ...s, height: Math.max(0.001, v) })} />
          </Fold>
        )}
        {s.kind === 'cone' && (
          <Fold title={t(M.cone, { unit: lengthUnit })} path="Shape/Cone" depth={1} collapsed={folds} toggle={toggle}>
            <NumberField label={t(M.radius)} unit="m" tooltip={t(M.coneRadiusTip)} value={s.radius} decimals={3} step={lenStep} min={0.001} disabled={!editable} onCommit={(v) => setShape({ ...s, radius: Math.max(0.001, v) })} />
            <NumberField label={t(M.height)} unit="m" tooltip={t(M.coneHeightTip)} value={s.height} decimals={3} step={lenStep} min={0.001} disabled={!editable} onCommit={(v) => setShape({ ...s, height: Math.max(0.001, v) })} />
          </Fold>
        )}
        {s.kind === 'mesh' && (
          <Fold title={t(M.mesh)} path="Shape/Mesh" depth={1} collapsed={folds} toggle={toggle}>
            {row(
              t(M.asset),
              s.node ? `${s.asset} · ${s.node}` : s.keepNode ? `${s.asset} · ${s.keepNode}` : s.asset,
              t(M.assetTip),
            )}
            <NumberField label={t(M.scale)} unit="" tooltip={t(M.scaleTip)} value={s.scale ?? 1} decimals={3} step={0.01} min={0.001} disabled={!editable} onCommit={(v) => setShape({ ...s, scale: Math.max(0.001, v) })} />
            {glb && (glb.nodes.length > 0 || glb.materials.length > 0) && (
              <div className="glb-contents">
                {/* a carved link (a split piece, or a model with pieces split off) cannot also take `node`: the
                    validator refuses the mix, so its pieces are managed under Split into pieces instead */}
                {glb.nodes.length > 0 && !s.keepNode && !s.hideNodes?.length && !(rig && keptNodes(rig, s.asset).size > 0) && (
                  <>
                    <div className="glb-group-label">{t(M.glbNodes)}</div>
                    <div className="glb-chips">
                      <button type="button" className={`glb-chip${s.node ? '' : ' on'}`} disabled={!editable} title={t(M.wholeModelTip)} onClick={() => setShape({ ...s, node: undefined })}>
                        {t(M.wholeModel)}
                      </button>
                      {glb.nodes.map((n) => (
                        <button key={n} type="button" className={`glb-chip${s.node === n ? ' on' : ''}`} disabled={!editable} title={t(M.useNodeTip, { node: n })} onClick={() => setShape({ ...s, node: n })}>
                          {n}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {glb.materials.length > 0 && (
                  <>
                    <div className="glb-group-label">{t(M.glbMaterials)}</div>
                    <ul className="glb-mats">
                      {glb.materials.map((m) => {
                        // fully-metallic + untextured renders near-black (no scene envMap); a metalness texture decides for itself
                        const dark = m.metalness >= 0.5 && !m.textured && !m.metalnessTextured
                        return (
                          <li key={m.name} className={`glb-mat${dark ? ' warn' : ''}`} title={dark ? t(M.darkTip) : undefined}>
                            <span className="glb-mat-name">{m.name}</span>
                            <span className="glb-mat-meta">
                              {[t(M.metal, { value: m.metalness.toFixed(2) }), m.textured ? t(M.textured) : '', dark ? t(M.rendersDark) : ''].filter(Boolean).join(' · ')}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}
          </Fold>
        )}
        {s.kind !== 'box' && s.kind !== 'cylinder' && s.kind !== 'cone' && s.kind !== 'mesh' && (
          <p className="inspector-hint">
            {s.kind === 'frame'
              ? t(M.frameHint)
              : t(M.scriptedHint, { kind: shapeLabel(s) })}
          </p>
        )}

      </Fold>
      {splitSource && splitGlb && splitGlb.nodes.length > 0 && (
        <Fold title={t(M.split)} path="Split" collapsed={folds} toggle={toggle}>
          <p className="inspector-hint">{splitSource.name === link.name ? t(M.splitHereHint) : t(M.splitUnderHint, { source: splitSource.name })}</p>
          {mergeSource && link.shape.kind === 'mesh' && (
            <div className="rig-script-actions">
              <button
                type="button"
                className="array-add"
                data-testid="merge-piece"
                disabled={!editable}
                title={t(M.mergeBackTip, { node: link.shape.keepNode ?? '', source: mergeSource.name })}
                onClick={() => controller?.rig.mergeRigPiece(part.packageId, link.name)}
              >
                {t(M.mergeBack)}
              </button>
            </div>
          )}
          {splitCandidates.length > 0 ? (
            <div className="glb-chips" data-testid="split-pieces">
              {splitCandidates.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="glb-chip"
                  disabled={!editable}
                  title={t(M.splitPieceTip, { node: n })}
                  onClick={() => controller?.rig.splitRigMeshNode(part.packageId, splitSource.name, n, link.name)}
                >
                  {n}
                </button>
              ))}
            </div>
          ) : (
            <p className="inspector-hint">{t(M.splitNone)}</p>
          )}
        </Fold>
      )}
      <Fold title={t(M.joint)} path="Joint" collapsed={folds} toggle={toggle}>
        {joint ? (
          <>
            {/* renamed here only while the script never mentions it: a rename here does not rewrite the script
                (core/parts/partPackage.ts behaviorMentions says why), so a used name is changed in the script first */}
            {jointMentioned || !editable ? (
              <>
                {row(t(M.name), joint.name, t(M.jointNameTip, { name: joint.name }))}
                {jointMentioned && (
                  <p className="inspector-hint" data-testid="joint-name-fixed">
                    {t(plcMode ? M.jointNamePlc : M.jointNameFixed, { name: joint.name })}
                  </p>
                )}
              </>
            ) : (
              <TextField
                key={`${joint.name}:${jointNameRev}`}
                label={t(M.name)}
                value={joint.name}
                code
                disabled={!editable}
                tooltip={t(M.jointNameFreeTip, { name: joint.name })}
                onCommit={(v) => {
                  if (controller?.renameRigJoint(part.packageId, joint.name, v)) return setJointNameMsg(null)
                  // refused: say why, and put the field back to the stored name
                  const name = v.trim()
                  setJointNameMsg(name === '' ? t(M.jointNeedsName) : pkgGeometry?.kind === 'rig' && pkgGeometry.joints.some((j) => j.name === name) ? t(M.jointNameTaken, { name }) : null)
                  setJointNameRev((r) => r + 1)
                }}
              />
            )}
            {jointNameMsg && !jointMentioned && (
              <p className="inspector-hint rig-error" data-testid="joint-name-msg">
                {jointNameMsg}
              </p>
            )}
            <label className="field">
              <span className="field-label" title={t(M.typeTip)}>
                {t(M.type)}
              </span>
              <span className="field-control">
                <select className="rig-select" value={joint.type} disabled={!editable} onChange={(e) => editJoint({ type: e.target.value as 'revolute' | 'prismatic' })}>
                  {/* i18n-ok: the SDK's joint type names, as a manifest spells them */}
                  <option value="revolute">revolute</option>
                  {/* i18n-ok: the SDK's joint type names, as a manifest spells them */}
                  <option value="prismatic">prismatic</option>
                </select>
              </span>
            </label>
            {(['X', 'Y', 'Z'] as const).map((ax, i) => (
              <NumberField
                key={ax}
                label={t(M.axis, { ax })}
                unit=""
                tooltip={t(revolute ? M.axisTurnTip : M.axisSlideTip, { ax })}
                value={joint.axis[i]!}
                decimals={2}
                step={1}
                disabled={!editable}
                onCommit={(v) => {
                  const a: [number, number, number] = [joint.axis[0], joint.axis[1], joint.axis[2]]
                  a[i] = v
                  editJoint({ axis: a })
                }}
              />
            ))}
            {revolute ? (
              <>
                <BoolRow label={t(M.spin)} checked={spinning} disabled={!editable} tooltip={t(M.spinTip)} onChange={setSpinning} />
                {spinServo ? (
                  <>
                    <NumberField label={t(M.spinSpeed)} unit="rpm" tooltip={t(M.spinSpeedTip)} value={radToRpm(spinServo.maxVelocity)} decimals={0} step={10} min={1} disabled={!editable} onCommit={setSpinSpeed} />
                    <NumberField label={t(M.spinUp)} unit="s" tooltip={t(M.spinUpTip)} value={spinServo.maxVelocity / spinServo.maxAccel} decimals={2} step={0.1} min={0.01} disabled={!editable} onCommit={setSpinUp} />
                    {/* with Spin as its PLC control the panel writes these lines itself (jointPlcControl.ts) */}
                    {!spinPlc && (
                      <>
                        <p className="inspector-hint" data-testid="spin-hint">
                          {t(M.spinHint)}
                        </p>
                        {/* i18n-ok: behavior code, as the script spells it */}
                        <pre className="rig-code" data-testid="spin-code">{`servos: [${JSON.stringify(joint.name)}],\nstep(ctx) {\n  const on = true\n  const s = ctx.servos[${JSON.stringify(joint.name)}]\n  s.power(true)\n  s.moveVelocity(on ? ${Number(spinServo.maxVelocity.toFixed(3))} : 0) // rad/s\n},`}</pre>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <NumberField label={t(M.min)} unit="°" tooltip={t(M.minRotTip)} value={(joint.min * 180) / Math.PI} decimals={1} step={1} disabled={!editable} onCommit={(v) => editJoint({ min: toRad(v) })} />
                    <NumberField label={t(M.max)} unit="°" tooltip={t(M.maxRotTip)} value={(joint.max * 180) / Math.PI} decimals={1} step={1} disabled={!editable} onCommit={(v) => editJoint({ max: toRad(v) })} />
                  </>
                )}
                {pivot ? (
                  <>
                    <VectorRow label={t(M.pivot, { unit: lengthUnit })} tooltip={t(M.pivotTip)}>
                      {([0, 1, 2] as const).map((axis) => (
                        <AxisInput
                          key={axis}
                          prefix={['X', 'Y', 'Z'][axis]!}
                          value={pivot[axis]}
                          decimals={3}
                          step={lenStep}
                          entryUnit="m"
                          disabled={!editable}
                          onCommit={(v) => {
                            const p: [number, number, number] = [pivot[0], pivot[1], pivot[2]]
                            p[axis] = v
                            setPivot(p)
                          }}
                        />
                      ))}
                    </VectorRow>
                    <div className="rig-script-actions">
                      <button type="button" className="array-add" data-testid="pivot-centre" disabled={!editable} title={t(M.pivotCentreTip)} onClick={centrePivot}>
                        {t(M.pivotCentre)}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="inspector-hint">{t(M.pivotLocked)}</p>
                )}
              </>
            ) : (
              <>
                <NumberField label={t(M.min)} unit="m" tooltip={t(M.minTravelTip)} value={joint.min} decimals={3} step={lenStep} disabled={!editable} onCommit={(v) => editJoint({ min: v })} />
                <NumberField label={t(M.max)} unit="m" tooltip={t(M.maxTravelTip)} value={joint.max} decimals={3} step={lenStep} disabled={!editable} onCommit={(v) => editJoint({ max: v })} />
              </>
            )}
            {(plcMode || canTwoPositions(joint) || canSpin(joint)) && (
              <label className="field">
                <span className="field-label" title={t(M.plcControlTip)}>
                  {t(M.plcControl)}
                </span>
                <span className="field-control">
                  <select
                    className="rig-select"
                    data-testid="plc-control"
                    value={plcMode?.mode ?? 'none'}
                    disabled={!editable}
                    onChange={(e) => setPlcControl(e.target.value === 'twoPositions' ? { mode: 'twoPositions', time: DEFAULT_STROKE_TIME } : e.target.value === 'spin' ? { mode: 'spin' } : null)}
                  >
                    <option value="none">{t(M.plcNone)}</option>
                    {canSpin(joint) ? <option value="spin">{t(M.plcSpin)}</option> : <option value="twoPositions">{t(M.plcTwoPositions)}</option>}
                  </select>
                </span>
              </label>
            )}
            {twoPositions && (
              <>
                <NumberField label={t(M.strokeTime)} unit="s" tooltip={t(M.strokeTimeTip)} value={twoPositions.time} decimals={2} step={0.1} min={0.05} disabled={!editable} onCommit={(v) => setPlcControl({ mode: 'twoPositions', time: Math.max(0.05, v) })} />
                <p className="inspector-hint" data-testid="plc-hint">
                  {t(M.plcHint)}
                </p>
              </>
            )}
            {spinPlc && spinServo && (
              <p className="inspector-hint" data-testid="plc-spin-hint">
                {t(M.plcSpinHint, { rpm: Math.round(radToRpm(spinServo.maxVelocity)) })}
              </p>
            )}
            {poseRange &&
              (revolute ? (
                <NumberField label={t(M.position)} unit="°" tooltip={t(M.positionTip)} value={(posed * 180) / Math.PI} decimals={1} step={1} min={(poseRange[0] * 180) / Math.PI} max={(poseRange[1] * 180) / Math.PI} disabled={!view || testing || running} onCommit={(v) => poseJoint(toRad(v))} />
              ) : (
                <NumberField label={t(M.position)} unit="m" tooltip={t(M.positionTip)} value={posed} decimals={3} step={lenStep} min={poseRange[0]} max={poseRange[1]} disabled={!view || testing || running} onCommit={(v) => poseJoint(v)} />
              ))}
            <div className="rig-script-actions">
              <button type="button" className="array-add" data-testid="joint-test" disabled={!view || running} title={t(M.testMotionTip)} onClick={testing ? stopTest : startTest}>
                {t(testing ? M.stopTest : M.testMotion)}
              </button>
              <button type="button" className="array-add" disabled={!editable} onClick={removeJoint}>
                {t(M.removeJoint)}
              </button>
            </div>
          </>
        ) : (
          <div className="rig-script-actions">
            <button type="button" className="array-add" disabled={!editable} title={t(M.addJointTip)} onClick={addJoint}>
              {t(M.addJoint)}
            </button>
          </div>
        )}

      </Fold>
      <Fold title={t(M.node)} path="Node" collapsed={folds} toggle={toggle}>
        <label className="field">
          <span className="field-label" title={t(M.newNodeTip)}>
            {t(M.newNode)}
          </span>
          <span className="field-control">
            <select
              className="rig-select"
              value={addKind}
              disabled={!editable}
              title={t(M.newNodeSelectTip)}
              onChange={(e) => {
                if (isAuthorableShapeKind(e.target.value)) setAddKind(e.target.value)
              }}
            >
              {AUTHORABLE_SHAPE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </span>
        </label>
        <div className="rig-script-actions">
          <button type="button" className="array-add" disabled={!editable} title={t(M.addChildTip)} onClick={() => controller?.addRigNode(part.packageId, link.name, addKind)}>
            {t(M.addChild)}
          </button>
          <button
            type="button"
            className="array-add"
            disabled={!editable || onlyNode}
            title={t(onlyNode ? M.onlyNodeTip : M.deleteNodeTip)}
            onClick={() => controller?.deleteRigNode(part.packageId, link.name)}
          >
            {t(M.deleteNode)}
          </button>
        </div>
        <div className="rig-script-actions">
          <button
            type="button"
            className="array-add"
            disabled={!editable || converting}
            title={t(M.importTip)}
            onClick={() => fileRef.current?.click()}
          >
            {t(converting ? M.converting : M.importModel)}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".glb,.step,.stp,.usd,.usda,.usdc,.usdz,model/gltf-binary"
            style={{ display: 'none' }}
            onChange={onPickModel}
            data-testid="model-file-input"
          />
          {/* webkitdirectory is not in React's input attributes; every browser and Electron read it */}
          <input ref={folderRef} type="file" style={{ display: 'none' }} onChange={onPickFolder} data-testid="usd-folder-input" {...{ webkitdirectory: '' }} />
        </div>
        {usdPick && (
          <div data-testid="usd-import-options">
            <p className="inspector-hint">
              {usdPick.folder
                ? t(M.usdFolder, { name: usdPick.label, count: usdPick.files.size })
                : t(M.usdFile, { name: usdPick.label, size: fileSize(usdPick.bytes) })}
            </p>
            {usdPick.missing === null && (
              <p className="inspector-hint" data-testid="usd-checking">
                {t(M.usdChecking)}
              </p>
            )}
            {!!usdPick.missing && (
              <>
                <p className="inspector-hint" data-testid="usd-needs-folder">
                  {t(M.usdNeedsFolder, { count: usdPick.missing })}
                </p>
                <div className="rig-script-actions">
                  <button type="button" className="array-add" data-testid="usd-pick-folder" title={t(M.usdPickFolderTip)} onClick={() => folderRef.current?.click()}>
                    {t(M.usdPickFolder)}
                  </button>
                  <button type="button" className="array-add" onClick={() => setUsdPick(null)}>
                    {t(M.cancel)}
                  </button>
                </div>
              </>
            )}
            {usdPick.missing === 0 && (
              <>
                {usdPick.roots.length > 1 && (
                  <label className="field">
                    <span className="field-label" title={t(M.usdRootTip)}>
                      {t(M.usdRoot)}
                    </span>
                    <span className="field-control">
                      <select className="rig-select" data-testid="usd-root" value={usdPick.root} onChange={(e) => setUsdPick({ ...usdPick, root: e.target.value })}>
                        {usdPick.roots.map((r) => (
                          <option key={r} value={r}>
                            {r.split('/').pop()}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                )}
                <label className="field">
                  <span className="field-label" title={t(M.usdDetailTip)}>
                    {t(M.detail)}
                  </span>
                  <span className="field-control">
                    <select className="rig-select" data-testid="usd-detail" value={usdOptions.detail} onChange={(e) => setUsdOptions({ ...usdOptions, detail: e.target.value as UsdDetail })}>
                      <option value="full">{t(M.usdDetailFull)}</option>
                      <option value="reduced">{t(M.usdDetailReduced)}</option>
                    </select>
                  </span>
                </label>
                <label className="field">
                  <span className="field-label" title={t(M.usdTextureSizeTip)}>
                    {t(M.usdTextureSize)}
                  </span>
                  <span className="field-control">
                    <select
                      className="rig-select"
                      data-testid="usd-texture-size"
                      value={usdOptions.maxTextureSize}
                      onChange={(e) => setUsdOptions({ ...usdOptions, maxTextureSize: Number(e.target.value) })}
                    >
                      {USD_TEXTURE_SIZES.map((s) => (
                        // i18n-ok: units
                        <option key={s} value={s}>{`${s} px`}</option>
                      ))}
                    </select>
                  </span>
                </label>
                <div className="rig-script-actions">
                  <button type="button" className="array-add" data-testid="usd-convert" onClick={() => void convertUsdFile()}>
                    {t(M.convertAndImport)}
                  </button>
                  <button type="button" className="array-add" onClick={() => setUsdPick(null)}>
                    {t(M.cancel)}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {stepFile && (
          <div data-testid="step-import-options">
            <p className="inspector-hint">
              {t(M.stepFileSize, { name: stepFile.name, mb: (stepFile.size / 1e6).toFixed(1) })}
            </p>
            <label className="field">
              <span className="field-label" title={t(M.detailTip)}>
                {t(M.detail)}
              </span>
              <span className="field-control">
                <select className="rig-select" value={stepOptions.detail} onChange={(e) => setStepOptions({ ...stepOptions, detail: e.target.value as StepDetail })}>
                  <option value="normal">{t(M.detailNormal)}</option>
                  <option value="coarse">{t(M.detailCoarse)}</option>
                </select>
              </span>
            </label>
            <label className="field">
              <span
                className="field-label"
                title={t(M.upAxisTip)}
              >
                {t(M.upAxis)}
              </span>
              <span className="field-control">
                <select className="rig-select" data-testid="step-up-axis" value={stepOptions.upAxis} onChange={(e) => setStepOptions({ ...stepOptions, upAxis: e.target.value as StepUpAxis })}>
                  <option value="z">{t(M.zUp)}</option>
                  <option value="y">{t(M.yUp)}</option>
                </select>
              </span>
            </label>
            {stepGuess && (
              <p className="inspector-hint" data-testid="step-up-guess">
                {stepGuess.known
                  ? t(M.exportedFrom, { system: stepGuess.system ?? '', up: stepGuess.up.toUpperCase() })
                  : stepGuess.system
                    ? t(M.exportedThrough, { system: stepGuess.system })
                    : t(M.unknownSystem)}
              </p>
            )}
            <NumberField
              label={t(M.skipUnder)}
              unit="mm"
              value={stepOptions.minPartMm}
              decimals={0}
              min={0}
              max={500}
              step={1}
              disabled={false}
              tooltip={t(M.skipUnderTip)}
              onCommit={(v) => setStepOptions({ ...stepOptions, minPartMm: Math.max(0, v) })}
            />
            <BoolRow
              label={t(M.mergeByColour)}
              checked={stepOptions.mergeByColour}
              disabled={false}
              tooltip={t(M.mergeByColourTip)}
              onChange={(v) => setStepOptions({ ...stepOptions, mergeByColour: v })}
            />
            <div className="rig-script-actions">
              <button type="button" className="array-add" onClick={() => void convertStepFile()}>
                {t(M.convertAndImport)}
              </button>
              <button type="button" className="array-add" onClick={() => setStepFile(null)}>
                {t(M.cancel)}
              </button>
            </div>
          </div>
        )}

        {msg && <p className="inspector-hint">{msg}</p>}
      </Fold>
    </div>
  )
}
