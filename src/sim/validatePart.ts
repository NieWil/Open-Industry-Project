// One structured entry that validates a custom part end-to-end and returns located, typed diagnostics
// instead of throwing on the first failure. It is the machine-readable verify half of the authoring loop:
// an author's IDE, the import flow and an AI codegen tool all want "give me every problem with this part,
// with kinds and line numbers", not a single thrown string. buildPackage is the throwing wrapper over it,
// so the build path and the validator can never drift.
//
// It folds together the four failure classes a part can have:
//   - determinism  : nondeterministic / sandbox-escaping primitives (core/determinism.ts) - located
//   - load         : doesn't call definePart, or is a syntax/eval error (embeddedBehavior.create)
//   - rig          : a declared joint/gripper that isn't in the manifest's rig geometry
//   - package      : structural problems in the resulting PartPackage (core/parts/partValidate.ts validatePartPackage)

import { cargoCentreOffset, cargoPieces, cargoPiecesBounds } from '../core/cargoBody'
import type { RigParams } from '../core/rig/rigPose'
import { posableArraysJson } from '../core/rig/rigPose'
import { checkDeterminism } from '../core/determinism'
import type { ParamSchema } from '../core/parts/partApi'
import type { PartPackage } from '../core/parts/partPackage'
import { checkGeometryRefs, checkParamSpecs, undeclaredParamReads } from '../core/parts/partAuthoringChecks'
import { evalPartGeometry, geometryLampNames, resolvePartParams } from '../core/geometry/geometryEval'
import { PACKAGE_FORMAT, rigLampNames, rigJointsJson } from '../core/parts/partPackage'
import { ROBOT_PARAMS } from '../core/robot/robotController'
import { validatePartPackage, validateSnapParamRefs } from '../core/parts/partValidate'
import { canonicalOrigin, canonicalSnap } from '../core/parts/partUpgrade'
import type { PackageManifest } from '../core/parts/partPackage'
import { stampSdk } from '../core/parts/partSdk'
import { pinShippedAsset } from '../core/shippedAssets'
import { create, declarations, destroy, error, meta, step } from './embeddedBehavior'

export type PartDiagnosticKind = 'determinism' | 'load' | 'rig' | 'package'

export interface PartDiagnostic {
  kind: PartDiagnosticKind
  message: string
  /** 1-based source line, when the problem maps to a location in the behavior script */
  line?: number
  /** 1-based source column */
  column?: number
}

export interface ValidatePartResult {
  ok: boolean
  diagnostics: PartDiagnostic[]
  /** the built, validated package - present only when ok */
  package?: PartPackage
}

/**
 * Validate a custom part (manifest + behavior source) and collect all problems as typed diagnostics.
 * Never throws on invalid input. On success, `package` holds the built PartPackage.
 */
export function validatePart(manifest: PackageManifest, behaviorSource: string): ValidatePartResult {
  const diagnostics: PartDiagnostic[] = []

  // 1) Determinism - located, and we report every violation (create() would stop at "won't load").
  const violations = checkDeterminism(behaviorSource)
  for (const v of violations) {
    diagnostics.push({ kind: 'determinism', message: `${v.name} - ${v.reason}`, line: v.line, column: v.column })
  }

  // 2) Load - run the script once through the single eval chokepoint to bake the schema + read decls.
  const handle = create(behaviorSource, '{}', rigJointsJson(manifest.geometry), posableArraysJson(manifest.geometry))
  if (handle <= 0) {
    const e = error() // also clears the runtime's error buffer
    // When determinism already explained the failure, don't duplicate it as an opaque load error.
    if (violations.length === 0) diagnostics.push({ kind: 'load', message: e || 'part failed to load' })
    return { ok: false, diagnostics }
  }
  const params = JSON.parse(meta(handle)) as ParamSchema
  const decl = declarations(handle)
  // One first tick at default params, with neutral inputs (no tags, no cargo): init() runs there
  // (embeddedBehavior defers it out of create()), and a step() that throws on its first tick (reading a
  // field of something undefined, the commonest generated-code slip) would otherwise surface only once placed and run.
  if (decl.hasStep && step(handle, JSON.stringify({ simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: {} }), 1 / 60) === '{}') {
    const e = error()
    if (e) diagnostics.push({ kind: 'load', message: `${decl.hasInit ? 'init() or step()' : 'step()'} threw on the first tick at default params: ${e}` })
  }
  destroy(handle)
  error() // a dispose() that threw is reported by destroy(); validation has nothing to add, so drop it

  // 3) Rig cross-check - the typed-bag promise ("a misspelled joint/gripper is an error") made true:
  // every declared joint must be a rig joint, every declared gripper a rig link.
  const geo = manifest.geometry
  const jointNames = geo.kind === 'rig' ? new Set(geo.joints.map((j) => j.name)) : new Set<string>()
  const linkNames = geo.kind === 'rig' ? new Set(geo.links.map((l) => l.name)) : new Set<string>()
  const lampNames = rigLampNames(geo, geometryLampNames(behaviorSource, params))
  for (const j of decl.joints) {
    if (!jointNames.has(j)) diagnostics.push({ kind: 'rig', message: `declared joint "${j}" is not a rig joint` })
  }
  for (const g of decl.grippers) {
    if (!linkNames.has(g)) diagnostics.push({ kind: 'rig', message: `declared gripper "${g}" is not a rig link` })
  }
  const servoNames = geo.kind === 'rig' ? new Set(geo.joints.filter((j) => j.servo).map((j) => j.name)) : new Set<string>()
  for (const sv of decl.servos) {
    if (!servoNames.has(sv)) diagnostics.push({ kind: 'rig', message: jointNames.has(sv) ? `declared servo "${sv}" is a rig joint without \`servo\`: give the joint a servo in the manifest, or command it through ctx.joints` : `declared servo "${sv}" is not a rig joint` })
  }
  for (const j of decl.joints) {
    if (servoNames.has(j)) diagnostics.push({ kind: 'rig', message: `joint "${j}" is a servo: drive it through ctx.servos.${j}, not ctx.joints (a servo poses its own joint, and a direct write is ignored)` })
  }
  for (const l of decl.lamps) {
    if (!lampNames.has(l)) diagnostics.push({ kind: 'rig', message: `declared lamp "${l}" is not a rig lamp (an entry of a link's \`lamps\`, named or taking the link's name, or of a drawn submesh's \`lamps\`)` })
  }

  // a robot's gripper, tool link, lamp, grip joint and own hand name parts of the rig, and the params its controller reads have
  // the types it reads them as (its joint names are checked at load: createRobot refuses one the rig lacks)
  if (decl.robot) {
    const r = decl.robot
    if (r.gripper !== undefined && !linkNames.has(r.gripper)) diagnostics.push({ kind: 'rig', message: `robot.gripper "${r.gripper}" is not a rig link` })
    if (r.tool !== undefined && !linkNames.has(r.tool)) diagnostics.push({ kind: 'rig', message: `robot.tool "${r.tool}" is not a rig link, so the tool is drawn on nothing` })
    if (r.lamp !== undefined && !lampNames.has(r.lamp)) diagnostics.push({ kind: 'rig', message: `robot.lamp "${r.lamp}" is not a rig lamp` })
    if (r.gripJoint !== undefined && !jointNames.has(r.gripJoint.name)) diagnostics.push({ kind: 'rig', message: `robot.gripJoint "${r.gripJoint.name}" is not a rig joint` })
    if (r.hand !== undefined) {
      if (!linkNames.has(r.hand.gripper)) diagnostics.push({ kind: 'rig', message: `robot.hand.gripper "${r.hand.gripper}" is not a rig link` })
      if (!jointNames.has(r.hand.gripJoint.name)) diagnostics.push({ kind: 'rig', message: `robot.hand.gripJoint "${r.hand.gripJoint.name}" is not a rig joint` })
      const tool = params.tool
      if (tool?.type !== 'enum' || !(tool.options ?? []).some((o) => o.value === 'hand'))
        diagnostics.push({ kind: 'package', message: "robot.hand: the robot grips with its own hand while its `tool` param is 'hand', but it has no enum `tool` param offering 'hand'" })
    }
    for (const [name, type] of Object.entries(ROBOT_PARAMS)) {
      const spec = params[name]
      if (spec && spec.type !== type) diagnostics.push({ kind: 'package', message: `robot: the controller reads param "${name}" as a ${type}, but it is declared as a ${spec.type}` })
    }
  }

  // 4) Package - structural validation of the assembled artifact.
  const pkg: PartPackage = {
    format: PACKAGE_FORMAT,
    id: manifest.id,
    name: manifest.name,
    params,
    behavior: behaviorSource,
    geometry: manifest.geometry,
  }
  if (manifest.category !== undefined) pkg.category = manifest.category
  if (decl.interactive) pkg.interactive = true // C-interaction: the behavior reads ctx.used()
  // hand-state param (useParam): the boolean param that is the device's hand state, the state a run starts
  // from, set in the Inspector (Use operates the device and never writes it). Validated here so the editor can
  // trust it blindly: it must be on an interactive part, name a declared boolean param (the latch the script
  // adopts), and be reported. The param is only the starting value, so what the device is actually in (after
  // hand presses, or under a program) has to come from step() itself, the same contract setpointFor makes.
  if (decl.useParam !== undefined) {
    if (!decl.interactive) diagnostics.push({ kind: 'package', message: 'useParam: requires interactive: true' })
    else if (typeof decl.useParam !== 'string' || params[decl.useParam]?.type !== 'boolean')
      diagnostics.push({ kind: 'package', message: `useParam: must name a boolean param (got ${JSON.stringify(decl.useParam)})` })
    else if (!reportsParam(behaviorSource, decl.useParam))
      diagnostics.push({
        kind: 'package',
        message: `useParam: names "${decl.useParam}" as the hand state, so step() must also call ctx.report('${decl.useParam}', <the state the device is in>)`,
      })
    else pkg.useParam = decl.useParam
  }
  // `setpointFor` promises the Inspector that a tag replaces a param, and the readout it drives is only as
  // truthful as the value behind it. The tag read is a fallback that replays the comms convention from the
  // outside and can drift from what `step` actually computed (a runTag gating to 0, a `reverse` flip, a
  // ramp); `ctx.report` is the value straight from the expression the part acted on. So a part making the
  // promise must also report, checked on the source (like checkDeterminism), since the one first tick above can't show it.
  for (const [key, spec] of Object.entries(params)) {
    const target = spec?.type === 'tag' ? spec.setpointFor : undefined
    if (typeof target !== 'string' || !target) continue
    if (!reportsParam(behaviorSource, target)) {
      diagnostics.push({
        kind: 'package',
        message: `params.${key}.setpointFor: declares it replaces "${target}", so step() must also call ctx.report('${target}', <effective value>)`,
      })
    }
  }
  if (decl.unit) pkg.unit = decl.unit // a unit-load product type (validated with the package, validateUnit)
  // declarative snap features (a device's mount onto a host surface): the manifest's. Behavior code written before
  // format 4 declared them in definePart, and stored code cannot be rewritten, so a script's snap is still read when
  // the manifest has none (in the current spelling, partUpgrade.ts canonicalSnap). Both, and different: refused.
  if (manifest.snap !== undefined) {
    pkg.snap = canonicalSnap(manifest.snap)
    if (decl.snap !== undefined && JSON.stringify(canonicalSnap(decl.snap)) !== JSON.stringify(pkg.snap)) {
      diagnostics.push({ kind: 'package', message: 'snap is declared in the manifest AND differently in definePart: it belongs in the manifest (package format 4); remove it from definePart' })
    }
  } else if (decl.snap) pkg.snap = canonicalSnap(decl.snap)
  // a first-party model or texture names the bytes the app ships for it, by hash (core/shippedAssets.ts)
  if (manifest.assets !== undefined) pkg.assets = manifest.assets.map(pinShippedAsset)
  if (manifest.materials !== undefined) pkg.materials = manifest.materials
  if (manifest.thumbnail !== undefined) pkg.thumbnail = manifest.thumbnail
  // `exposes` (a scoped cell's public tags) retired with PLC tag scoping: refused here with the reason, where
  // an author can act on it; a stored package just loses it (core/parts/partUpgrade.ts dropRetiredExposes)
  if ((manifest as { exposes?: unknown }).exposes !== undefined) {
    diagnostics.push({ kind: 'package', message: "exposes: retired with PLC tag scoping; a part's PLC interface is its 'tag' params, wired by name. Remove it" })
  }
  if (manifest.conveyor !== undefined) pkg.conveyor = manifest.conveyor // what kind of conveyor it is (declared, not inferred)
  if (manifest.commsParam !== undefined) pkg.commsParam = manifest.commsParam // the param that switches its PLC link
  if (manifest.holds !== undefined) pkg.holds = manifest.holds // the cargo it stores on its grippers
  // cargo with its own body (core/cargoBody.ts): checked at default params, where the author can act on it. A stored
  // part is never dropped for these, so they are here and not in validatePartPackage.
  if (manifest.cargo !== undefined) {
    pkg.cargo = manifest.cargo
    if (geo.kind === 'rig') {
      const resolved = resolvePartParams(params, {}) as Record<string, unknown>
      const bounds = cargoPiecesBounds(cargoPieces(geo, resolved as RigParams, resolved))
      if (!bounds) diagnostics.push({ kind: 'package', message: 'cargo: the rig has no colliding link, so the cargo would have no body (a box or cylinder link without `collision: none`)' })
      else if (cargoCentreOffset(bounds) > 0.002) {
        const c = bounds.min.map((v, k) => ((v + bounds.max[k]!) / 2).toFixed(3)).join(', ')
        diagnostics.push({ kind: 'package', message: `cargo: its links' bounds are centred at (${c}), not on the part's origin. Cargo is centre-origin, like a box: move the links so their bounds are centred on (0, 0, 0)` })
      }
    }
  }
  // where a project's copy came from (a built-in, the shelf); a folder written before package format 6 spells it
  // basedOn / fromShelf, with no format number to upgrade by
  const origin = canonicalOrigin(manifest).origin
  if (origin !== undefined) pkg.origin = origin
  // who made a library copy (core/parts/partPackage.ts PartCredit), as the app wrote it; validatePartPackage checks its shape
  if (manifest.credit !== undefined) pkg.credit = manifest.credit
  for (const p of validatePartPackage(pkg)) {
    diagnostics.push({ kind: 'package', message: `${p.field}: ${p.message}` })
  }
  // Snap param references are reported here and not by validatePartPackage: a package problem
  // drops the package on load, so a typo'd param name would delete a saved part rather than just stop it
  // snapping (see validateSnapParamRefs). An author gets it at the point they can fix it.
  for (const p of validateSnapParamRefs(pkg)) {
    diagnostics.push({ kind: 'package', message: `${p.field}: ${p.message}` })
  }
  // The rest of the author-time data checks, same reasoning (core/parts/partAuthoringChecks.ts): a param spec that
  // contradicts itself, and every param / link name the geometry or a spec uses, resolved.
  for (const p of [...checkParamSpecs(params), ...checkGeometryRefs(manifest.geometry, params)]) {
    diagnostics.push({ kind: 'package', message: `${p.field}: ${p.message}` })
  }
  // A param the script reads but the part does not declare reads undefined with no error. Located, so the editor and
  // an agent land on the line; the TypeScript types catch it only when the script is type-checked.
  for (const r of undeclaredParamReads(behaviorSource, params)) {
    const declared = Object.keys(params)
    diagnostics.push({
      kind: 'package',
      message: `ctx.params.${r.name} is not a param of this part, so it reads undefined${r.near ? ` (did you mean "${r.near}"?)` : declared.length > 0 ? ` (its params: ${declared.join(', ')})` : ' (it declares none)'}`,
      line: r.line,
      column: r.column,
    })
  }
  // What geometry() draws, at default params: problems the package can't show, because they only exist in the
  // script's output. A submesh naming a material the manifest doesn't declare still draws, in the host's neutral
  // grey, which reads as a rendering bug rather than a typo. A spinning instanced bank turns its grain about each
  // instance's local Z (the only axis the host can turn a bank about); any other axis would silently hold still.
  const matIds = new Set((manifest.materials ?? []).map((m) => m.id))
  const drawn = evalPartGeometry(behaviorSource, resolvePartParams(params, {})) ?? []
  for (const id of new Set(drawn.flatMap((p) => (p.material ? [p.material] : [])))) {
    if (!matIds.has(id)) diagnostics.push({ kind: 'package', message: `geometry(): a submesh names material "${id}", which the manifest's \`materials\` do not declare (it would draw in the host's neutral grey)` })
  }
  // A scroll or spin that names no speed turns with the conveyor's declared speed param; on a part that is no
  // conveyor there is nothing to turn with, and it would sit frozen while the sim runs.
  const unnamed = pkg.conveyor?.speedParam === undefined && drawn.some((p) => (p.spin && p.spin.speed === undefined) || (p.scroll && p.scroll.speed === undefined))
  if (unnamed) diagnostics.push({ kind: 'package', message: "geometry(): a submesh's spin or scroll names no speed, and this part declares no conveyor speed param to turn with; name the param that drives it (spin: { ..., speed: 'fanSpeed' })" })
  // A bank turns its material's grain, not its geometry: one with no grain to turn would hold still.
  const objectGrain = new Set((manifest.materials ?? []).filter((m) => m.triplanar?.space === 'object').map((m) => m.id))
  for (const p of drawn) {
    if (!p.spin || !p.instances) continue
    const [x, y, z] = p.spin.axis
    const len = Math.hypot(x, y, z)
    if (!(len > 0) || Math.abs(z / len) < 1 - 1e-6) {
      diagnostics.push({ kind: 'package', message: `geometry(): a spinning instanced bank turns each instance about its own local Z, so its spin.axis must be [0, 0, 1] or [0, 0, -1] (got ${JSON.stringify(p.spin.axis)}); lay the template's axle along Z` })
    }
    if (p.material ? !objectGrain.has(p.material) : p.finish !== 'roller') {
      diagnostics.push({
        kind: 'package',
        message: `geometry(): a spinning instanced bank turns its material's grain, not its geometry, and ${p.material ? `material "${p.material}" has no object-space triplanar grain` : `finish ${JSON.stringify(p.finish ?? 'mesh')} has no grain`} to turn, so it holds still. Give it finish 'roller' or a material with triplanar: { space: 'object' }, or draw each one as its own submesh, which turns its mesh (a toothed sprocket)`,
      })
    }
  }
  // A surface friction only means something on a solid, and a guard has none; either would be ignored without a word.
  for (const p of drawn) {
    const f = (p as { friction?: unknown }).friction
    if (f === undefined) continue
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f > 2) diagnostics.push({ kind: 'package', message: `geometry(): a submesh's friction must be a number from 0 to 2, the scale a conveyor frictionParam uses (got ${JSON.stringify(f)})` })
    else if (p.collision === undefined) diagnostics.push({ kind: 'package', message: "geometry(): a submesh has a friction but no collision, so nothing collides with it; give it collision: 'hull' or 'box'" })
    else if (p.sideGuard !== undefined) diagnostics.push({ kind: 'package', message: 'geometry(): a side guard has no friction (cargo slides along it); drop friction or the sideGuard' })
    else if (manifest.geometry.kind === 'rig') diagnostics.push({ kind: 'package', message: "geometry(): on a rig, geometry() is render-only, so a submesh's friction does nothing; set friction on the link" })
  }
  // A squash compresses along a rig link off one of the rig's lamps; anything else would sit still with no word why.
  for (const p of drawn) {
    const s = p.squash
    if (!s) continue
    if (!(typeof s.amount === 'number' && s.amount > 0 && s.amount <= 1)) diagnostics.push({ kind: 'package', message: `geometry(): squash.amount must be a number in (0, 1] (got ${JSON.stringify(s.amount)})` })
    if (!lampNames.has(s.lamp)) diagnostics.push({ kind: 'package', message: `geometry(): squash.lamp "${String(s.lamp)}" is not a lamp in this rig, so the squash never fires` })
    if (manifest.geometry.kind !== 'rig') diagnostics.push({ kind: 'package', message: 'geometry(): squash compresses a submesh along its rig link, and this part is not a rig' })
    if (p.spin) diagnostics.push({ kind: 'package', message: 'geometry(): a submesh cannot both spin and squash' })
  }
  // A behavior with no step() loads (definePart accepts it) and then crashes the host's first tick.
  if (!decl.hasStep) diagnostics.push({ kind: 'load', message: 'definePart({...}) has no step(ctx) - every part needs one, even an empty `step() {}` for passive cargo' })
  if (decl.hasBoth) diagnostics.push({ kind: 'load', message: 'definePart({...}) has both step(ctx) and react(ctx) - a part runs every tick (step) or when its inputs change (react), not both' })

  const ok = diagnostics.length === 0
  // the level this part was last changed under: kept from the manifest while the part is unchanged (core/parts/partSdk.ts)
  if (manifest.sdk !== undefined) pkg.sdk = manifest.sdk
  return ok ? { ok, diagnostics, package: stampSdk(pkg) } : { ok, diagnostics }
}

/**
 * Does this behavior source report `param` through `ctx.report`? A source-level check, in the same spirit as
 * checkDeterminism: validation loads the script but never steps it, so there is no runtime answer to ask for.
 * Lenient about the receiver (`ctx.report` / a destructured `report`) and quote style, and it
 * only looks for a literal param name: a part that reports through a computed key can't be checked this way
 * and should name the param literally at least once (a `report('speed', v)` line the check can see).
 */
function reportsParam(source: string, param: string): boolean {
  return new RegExp(String.raw`\breport\s*\(\s*['"\`]${param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]\s*,`).test(source)
}

/** One-line summary of diagnostics for a thrown error / log line; '' when clean. */
export function formatPartDiagnostics(diagnostics: PartDiagnostic[]): string {
  return diagnostics
    .map((d) => {
      const at = d.line !== undefined ? ` (line ${d.line}:${d.column ?? 1})` : ''
      return `[${d.kind}] ${d.message}${at}`
    })
    .join('; ')
}
