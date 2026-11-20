import { Quaternion, Vector3 } from 'three'
import type { Group, Object3D } from 'three'
import { clamp } from '../../../core/math'
import { dampedStep } from '../../../core/robot/robotIk'
import type { ParamValue } from '../../../core/parts/partApi'
import type { PartPackage, RigJoint, Vec3Tuple } from '../../../core/parts/partPackage'
import type { RobotGizmoApi, RobotGizmoJoint, RobotGizmoLayout } from '../../api'

// ---- rig editor gizmo (a robot's joint rings + IK handle, generalized to any rig) -------------
// Reads the joint chain from the rig geometry and poses its own visual (the custom rig has no j1..j6
// params): a drag updates a held pose map applied via the shared FK (applyJoints), so the arm stays put at
// idle. Up to 8 joints get rings (J1-J8), the tool's chain first; the EE handle drags the tool link (`tool`, else the
// last posable joint's link) by damped least squares over the joints between the root and that link, keeping the
// tool's orientation unless the drag asks to be free.
// It draws nothing itself: `layout()` reports where the rings and handles go in world space, and the view's
// RigGizmoOverlay draws them in the always-on-top overlay pass at a constant size on screen, the way the
// transform gizmo and resize dots are drawn. Hung inside the part, they would be in its render bundle, scale
// with the world (unpickable from a distance) and draw as 1 px lines.
// a 7-joint arm and its gripper
const GIZMO_MAX = 8

/** the author-posable joints; cosmetic (self-driven) and mimic (following) joints are invisible to the gizmo + the idle
 *  `pose` row */
export function posableJoints(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>): RigJoint[] {
  return geo.joints.filter((j) => !j.cosmetic && !j.mimic)
}
/** damped least squares steps per pointer move */
const IK_ITERATIONS = 60
/** done when the tool is this close (m), and turned less than ORIENT_TOLERANCE when its orientation is held */
const IK_TOLERANCE = 0.001
const ORIENT_TOLERANCE = 1e-3 // rad
/** metres one radian of orientation error weighs against position error: about a tool's reach */
const ORIENT_WEIGHT = 0.25
/** the damping (m): a pose near a singularity takes a short, smooth step instead of a huge one */
const IK_DAMPING = 0.02
/** the largest change one step makes to a joint (rad, or m for a prismatic joint) */
const IK_MAX_STEP = 0.2
/** a chain this long, three of it revolute, can turn the tool to any orientation, so a drag holds it */
const ORIENT_DOF = 6
/** a joint pivot this close to the part origin (part-local metres) shares its spot with the transform gizmo */
const ORIGIN_SHARED = 0.05
const _q = new Quaternion()
const _s = new Vector3()

export interface RigGizmo {
  api: RobotGizmoApi
  /** apply the authored idle pose at rest (until dragged, the pose IS the idle pose); re-applied on update */
  applyIdle(idle: Record<string, number>): void
  /** track the rigSize handles + tool outline at the (default-resolved) param values; absent when the
   *  package declares no rigSize handles */
  setSizes?(params: Record<string, ParamValue>): void
  /** drag the end-effector by this link from now on (a robot's grip point, which follows the tool it carries); a
   *  link the rig lacks is ignored */
  setEnd(link: string): void
}

/** a unit vector perpendicular to `a` (the ring's angle-0 reference in the link's frame) */
function perpendicular(a: Vector3): Vector3 {
  const ref = Math.abs(a.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
  return new Vector3().crossVectors(a, ref).normalize()
}

export function buildRigGizmo(
  geo: Extract<PartPackage['geometry'], { kind: 'rig' }>,
  root: Object3D,
  linkGroups: Map<string, Group>,
  applyJoints: (joints: Record<string, number>) => void,
  paramSpecs: PartPackage['params'],
  /** the link the end-effector handle drags: a robot's grip point (core robotKinematics `end`). Else the rig's `tool`,
   *  else the last posable joint's link */
  end?: string,
): RigGizmo | null {
  // opt-in: the in-scene teach-by-pose gizmo shows only for rigs that declare `posable` (manipulators you hand-
  // teach - robot / gantry / AGV lift). A rig whose joints are sim/PLC-driven (safety gate, diverter, blade-stop,
  // turntable) leaves it off, so selecting the placed part doesn't draw an interactive joint/IK gizmo it can't use.
  if (geo.posable !== true) return null
  // cosmetic joints (self-driven dressing - wheels, ratio pistons) are not author-posable: no ring, never the EE
  const posable = posableJoints(geo)
  if (posable.length === 0) return null
  const firstEnd = (end !== undefined ? linkGroups.get(end) : undefined) ?? (geo.tool !== undefined ? linkGroups.get(geo.tool) : undefined) ?? linkGroups.get(posable[posable.length - 1]!.link)
  if (!firstEnd) return null
  let eeGroup: Group = firstEnd
  // The joints the IK moves: those whose link is the tool's or one above it, root first. A gripper's fingers branch
  // off beside the tool and keep their place. A tool under none of them (a misplaced `tool`) moves them all.
  const depth = (o: Object3D): number => { let d = 0; for (let p = o.parent; p && p !== root; p = p.parent) d++; return d }
  const above = new Set<Object3D>()
  for (let o: Object3D | null = eeGroup; o && o !== root; o = o.parent) above.add(o)
  const onPath = posable.filter((j) => { const g = linkGroups.get(j.link); return g !== undefined && above.has(g) })
  const ik = (onPath.length ? onPath : posable).slice().sort((a, b) => depth(linkGroups.get(a.link)!) - depth(linkGroups.get(b.link)!))
  const shown = [...ik, ...posable.filter((j) => !ik.includes(j))].slice(0, GIZMO_MAX)
  // An end-effector drag keeps the tool's orientation when the chain can turn it every way: six joints, three of them
  // revolute (a six-axis robot, a 7-joint arm). Anything less (a gantry, an AGV lift) drags the tool point alone.
  const holdsOrientation = ik.length >= ORIENT_DOF && ik.filter((j) => j.type === 'revolute').length >= 3
  // Recompose the rig's world matrices from TRS before a read. Posable rigs are matrix-frozen
  // (matrixAutoUpdate=false subtree, viewMatrices.ts syncMatrixFreeze), so a plain updateMatrixWorld(true)
  // would multiply stale local matrices after applyJoints moved a link's TRS; updateMatrix() must
  // run explicitly first. applyJoints bumps poseRev, so the view re-bakes for rendering. This
  // helper only serves the synchronous reads inside the IK/layout handlers below.
  // Only the part's own subtree: a rebuild runs with the part already in the scene, where walking up to
  // the top parent would reach the whole scene ~160 times per IK drag move, and would reset objects whose
  // matrix is set by hand (the dock leveler) to their TRS.
  const refreshWorld = (): void => {
    root.traverse((o) => o.updateMatrix())
    root.updateWorldMatrix(true, true)
  }

  const pose: Record<string, number> = {} // jointName -> radians; the held authoring pose

  const worldAxis = (g: Object3D, axis: Vec3Tuple): Vector3 =>
    new Vector3(axis[0], axis[1], axis[2]).applyQuaternion(g.getWorldQuaternion(_q)).normalize()
  // each shown joint's angle-0 direction in its own link frame (the handle rides it round the ring)
  const localPerp = shown.map((j) => perpendicular(new Vector3(j.axis[0], j.axis[1], j.axis[2]).normalize()))

  // tool-size handles (rigSize param handles - the six-axis EOAT resize dots): one per declared axis, in the
  // named link's frame so it rides the posed arm, at local `value/2` along the axis. Links with any handle also
  // get the tool's outline rectangle at the current x/z sizes.
  const sizeHandles: { key: string; link: string; axis: 'x' | 'z'; frameY: number; value: number }[] = []
  const sizeRects: { link: string; frameY: number; x: number; z: number }[] = []
  for (const [key, spec] of Object.entries(paramSpecs)) {
    const h = spec.handle
    if (h?.kind !== 'rigSize' || !linkGroups.has(h.link)) continue
    const frameY = h.frameY ?? 0
    sizeHandles.push({ key, link: h.link, axis: h.axis, frameY, value: 0 })
    if (!sizeRects.some((r) => r.link === h.link)) sizeRects.push({ link: h.link, frameY, x: 0, z: 0 })
  }
  const setSizes = sizeHandles.length
    ? (params: Record<string, ParamValue>): void => {
        const val = (key: string | undefined): number | null => {
          const v = key !== undefined ? params[key] : undefined
          return typeof v === 'number' && Number.isFinite(v) ? v : null
        }
        for (const sh of sizeHandles) sh.value = val(sh.key) ?? 0
        for (const r of sizeRects) {
          // each axis extent from its own handle's param; a single-axis tool draws a square of that size
          const vx = val(sizeHandles.find((s) => s.link === r.link && s.axis === 'x')?.key)
          const vz = val(sizeHandles.find((s) => s.link === r.link && s.axis === 'z')?.key)
          r.x = vx ?? vz ?? 0
          r.z = vz ?? vx ?? 0
        }
      }
    : undefined

  let dragged = false // once the gizmo poses the rig, the authored idle pose no longer reseeds it...
  let idleKey: string | null = null // ...until that idle pose changes
  let idlePose: Record<string, number> = {} // the authored idle pose last applied: what Reset returns to

  const setJointAngle = (i: number, deg: number): void => {
    const j = shown[i]
    if (!j) return
    dragged = true
    pose[j.name] = clamp((deg * Math.PI) / 180, j.min, j.max)
    applyJoints(pose)
  }

  // The links IK reads: every joint link and the tool, with their ancestors up to the part, in parent-first order. An
  // IK step reads only these, so it recomposes these alone (a few matrices) instead of the whole model (refreshWorld),
  // which matters at sixty steps per pointer move.
  const chain: Object3D[] = (() => {
    const set = new Set<Object3D>()
    const ends = [eeGroup, ...shown.map((j) => linkGroups.get(j.link))].filter((g): g is Group => g !== undefined)
    for (const end of ends) for (let o: Object3D | null = end; o && o !== root; o = o.parent) set.add(o)
    return [...set].sort((a, b) => depth(a) - depth(b))
  })()
  const refreshChain = (): void => {
    root.updateMatrix()
    root.updateWorldMatrix(true, false)
    for (const o of chain) {
      o.updateMatrix()
      o.matrixWorld.multiplyMatrices(o.parent!.matrixWorld, o.matrix)
    }
  }

  // The tool orientation an end-effector drag holds, taken when it starts
  let held: Quaternion | null = null
  const beginIK = (): void => {
    refreshChain()
    held = holdsOrientation ? eeGroup.getWorldQuaternion(new Quaternion()) : null
  }

  // IK toward a world target for the tool, by damped least squares over the chain: each step solves
  // dq = Jᵀ (J Jᵀ + λ² I)⁻¹ e for the joint change that best closes the error e, with J each joint's effect on the tool
  // (a revolute joint moves the tool by axis × (tool - pivot) and turns it about the axis; a prismatic one slides it
  // along the axis). It makes no assumption about the arm's shape, so an offset wrist (a UR arm) or a seventh joint
  // works as a six-axis arm does. By default the tool keeps the orientation it had when the drag began; `free` (or a
  // chain that cannot turn the tool every way) moves the tool point alone.
  const solveIK = (target: Vector3, free = false): number[] => {
    dragged = true
    const hold = !free && held !== null
    const rows = hold ? 6 : 3
    const n = ik.length
    const J = new Float64Array(rows * n)
    const e = new Float64Array(rows)
    const tool = new Vector3()
    const err = new Quaternion()
    for (let iter = 0; iter < IK_ITERATIONS; iter++) {
      refreshChain()
      eeGroup.getWorldPosition(tool)
      e[0] = target.x - tool.x
      e[1] = target.y - tool.y
      e[2] = target.z - tool.z
      let turn = 0
      if (hold) {
        // the rotation still to make, as an axis × angle, weighed in metres
        err.copy(held!).multiply(eeGroup.getWorldQuaternion(_q).invert())
        if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w)
        turn = 2 * Math.acos(Math.min(1, err.w))
        const s = Math.sqrt(Math.max(0, 1 - err.w * err.w))
        const k = s > 1e-9 ? (turn / s) * ORIENT_WEIGHT : 2 * ORIENT_WEIGHT
        e[3] = err.x * k
        e[4] = err.y * k
        e[5] = err.z * k
      }
      if (Math.hypot(e[0]!, e[1]!, e[2]!) < IK_TOLERANCE && turn < ORIENT_TOLERANCE) break
      for (let c = 0; c < n; c++) {
        const j = ik[c]!
        const g = linkGroups.get(j.link)!
        const axis = worldAxis(g, j.axis)
        if (j.type === 'revolute') {
          const r = tool.clone().sub(g.getWorldPosition(new Vector3()))
          const v = axis.clone().cross(r)
          J[c] = v.x
          J[n + c] = v.y
          J[2 * n + c] = v.z
          if (hold) {
            J[3 * n + c] = axis.x * ORIENT_WEIGHT
            J[4 * n + c] = axis.y * ORIENT_WEIGHT
            J[5 * n + c] = axis.z * ORIENT_WEIGHT
          }
        } else {
          // a slide of d in the joint's units moves the tool d times the part's scale in the world
          const k = g.getWorldScale(_s).x
          J[c] = axis.x * k
          J[n + c] = axis.y * k
          J[2 * n + c] = axis.z * k
          if (hold) J[3 * n + c] = J[4 * n + c] = J[5 * n + c] = 0
        }
      }
      const dq = dampedStep(J, e, rows, n, IK_DAMPING)
      let big = 0
      for (let c = 0; c < n; c++) big = Math.max(big, Math.abs(dq[c]!))
      const scale = big > IK_MAX_STEP ? IK_MAX_STEP / big : 1
      for (let c = 0; c < n; c++) {
        const j = ik[c]!
        pose[j.name] = clamp((pose[j.name] ?? 0) + dq[c]! * scale, j.min, j.max)
      }
      applyJoints(pose)
    }
    return shown.map((j) => ((pose[j.name] ?? 0) * 180) / Math.PI)
  }

  const layout = (): RobotGizmoLayout => {
    refreshWorld()
    const origin = root.getWorldPosition(new Vector3())
    const scale = root.getWorldScale(new Vector3()).x
    const ee = eeGroup.getWorldPosition(new Vector3())
    const joints: RobotGizmoJoint[] = []
    shown.forEach((j, i) => {
      const g = linkGroups.get(j.link)
      if (!g) return
      const pivot = g.getWorldPosition(new Vector3())
      const axis = worldAxis(g, j.axis)
      const handleDir = localPerp[i]!.clone().applyQuaternion(g.getWorldQuaternion(_q)).normalize()
      const revolute = j.type === 'revolute'
      const angle = pose[j.name] ?? 0
      const zeroDir = revolute ? handleDir.clone().applyAxisAngle(axis, -angle) : handleDir.clone()
      // A ring on a pivot at the part origin (a robot's J1) would sit inside the transform gizmo, which is drawn
      // there, and a press on its handle would look like a press on the transform gizmo. Slide it along its own
      // axis to the next joint's level: still a ring about the same axis, where the joint's turn shows.
      const center = pivot.clone()
      if (pivot.distanceTo(origin) < ORIGIN_SHARED * scale) {
        const next = shown[i + 1] ? linkGroups.get(shown[i + 1]!.link)?.getWorldPosition(new Vector3()) : ee
        if (next) center.addScaledVector(axis, next.clone().sub(pivot).dot(axis))
      }
      joints.push({ label: `J${i + 1}`, center, axis, handleDir, zeroDir, angle, min: j.min, max: j.max, revolute })
    })
    const sizes = sizeHandles.map((sh) => ({
      handle: `size:${sh.key}` as const,
      pos: new Vector3(sh.axis === 'x' ? sh.value / 2 : 0, sh.frameY, sh.axis === 'z' ? sh.value / 2 : 0).applyMatrix4(linkGroups.get(sh.link)!.matrixWorld),
    }))
    const toolOutlines = sizeRects
      .filter((r) => r.x > 0 && r.z > 0)
      .map((r) => {
        const m = linkGroups.get(r.link)!.matrixWorld
        return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => new Vector3((sx! * r.x) / 2, r.frameY, (sz! * r.z) / 2).applyMatrix4(m))
      })
    return { joints, ee, sizes, toolOutlines }
  }

  const api: RobotGizmoApi = {
    rig: true,
    layout,
    // a `size:<param>` handle's drag line: the tool frame origin + world axis dir, and the world length of
    // one link-local unit (a scaled rig's drag distance converts back to local metres)
    sizeInfo(param: string): { origin: Vector3; dir: Vector3; unit: number } | null {
      const sh = sizeHandles.find((s) => s.key === param)
      const g = sh && linkGroups.get(sh.link)
      if (!sh || !g) return null
      refreshWorld()
      const origin = new Vector3(0, sh.frameY, 0).applyMatrix4(g.matrixWorld)
      const dir = new Vector3(sh.axis === 'x' ? 1 : 0, sh.frameY, sh.axis === 'z' ? 1 : 0).applyMatrix4(g.matrixWorld).sub(origin)
      const unit = dir.length()
      if (unit < 1e-6) return null
      return { origin, dir: dir.multiplyScalar(1 / unit), unit }
    },
    beginIK,
    solveIK,
    setJointAngle,
    jointAngle: (i: number) => {
      const j = shown[i]
      return j ? ((pose[j.name] ?? 0) * 180) / Math.PI : 0
    },
    // the full held pose (name → radians/metres) - the Inspector's "Capture Pose" waypoint-teach source
    rigPose: () => ({ ...pose }),
    // jogged: the arm is held somewhere the saved idle pose does not put it (a drag, a waypoint shown)
    jogged: () => dragged && posable.some((j) => Math.abs((pose[j.name] ?? 0) - (idlePose[j.name] ?? 0)) > 1e-6),
    // ...and back: the saved idle pose again
    resetJog: () => {
      dragged = false
      for (const k of Object.keys(pose)) delete pose[k]
      Object.assign(pose, idlePose)
      for (const j of posable) pose[j.name] ??= 0 // a joint the idle pose leaves out rests at 0
      applyJoints(pose)
    },
    // ...and its inverse: hold a whole pose at once (the Inspector showing a waypoint), every posable joint named
    setRigPose: (next: Record<string, number>) => {
      for (const j of posable) {
        const v = next[j.name]
        if (typeof v === 'number' && Number.isFinite(v)) pose[j.name] = clamp(v, j.min, j.max)
      }
      dragged = true
      applyJoints(pose)
    },
  }
  return {
    api,
    ...(setSizes ? { setSizes } : {}),
    // A robot's grip point moves when its tool changes (an arm's own hand or a tool in its place). The IK chain stays
    // the one found above: both grip points hang from the same arm joints.
    setEnd: (link: string) => {
      const g = linkGroups.get(link)
      if (g) eeGroup = g
    },
    // Apply the authored idle pose at rest. Until the gizmo is dragged, the pose is the idle pose (so the rig
    // shows e.g. the robot's home configuration, not the zero pose). After a drag, the dragged pose persists
    // and re-applies here until the idle pose itself changes; the running sim overrides it each frame via
    // applyBoxFrame.
    applyIdle: (idle: Record<string, number>) => {
      // a changed idle pose (an Inspector edit, undo, a collab peer) replaces an earlier drag; the same one
      // re-applied by an unrelated param change keeps the dragged pose
      idlePose = { ...idle }
      const key = JSON.stringify(idle)
      if (key !== idleKey) {
        idleKey = key
        dragged = false
      }
      if (!dragged) {
        for (const k of Object.keys(pose)) delete pose[k]
        Object.assign(pose, idle)
      }
      if (Object.keys(pose).length > 0) applyJoints(pose)
    },
  }
}
