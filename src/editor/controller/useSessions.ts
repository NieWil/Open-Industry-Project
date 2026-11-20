// The stopped-scene idle actuation preview and Use sessions of the EditorController
// (../controller.ts). Session state, never the document. The sessions and the idle-pose memo are this area's
// own state (UseSessions, held by the controller); the store, view and view scene come in as dependencies.

import type { BoxFrame } from '../../core/frame'
import { memoizeAuthoredCargoFrame } from '../../core/frame'
import { authoredZoneCounts } from '../../core/zoneCounts'
import { getPackage } from '../../core/parts/partRegistry'
import { rigJointsJson } from '../../core/parts/partPackage'
import { posableArraysJson } from '../../core/rig/rigPose'
import type { PartPackage } from '../../core/parts/partPackage'
import { IdleUseSession, idleKey, settleIdlePose, withJointRests } from '../../sim/idlePose'
import type { SdkPart, SceneJSON } from '../../core/types'
import type { EditorStore } from '../store/store'
import type { EditorController } from '../controller'

/** The devices a stopped-scene Use is operating, and the idle actuation preview's memo. */
export class UseSessions {
  // Devices a stopped-scene Use is operating (C in the editor, E walking - one model, pilot.ts idleUsePart): each
  // a live instance of the device's behavior (sim/idlePose IdleUseSession) that takes the presses and is stepped
  // every frame while it moves, so a press leaves the device where a press leaves it. `key` is the (behavior +
  // params + held cargo) it was opened on: a change to it means the design changed under it, and the design wins.
  // Session state, never the document: dropped when the device is back at its authored state, on Play, on Reset
  // (the Inspector), or when its params change. It owns the rig's idle pose while it lives (refreshIdlePoses skips
  // it). Mirrored to the store as `usedIds` for the Inspector.
  readonly sessions = new Map<string, { session: IdleUseSession; key: string }>()
  // the `usedIds` array this controller last published, so a change it did not make (loadScene clearing it) reads
  // as "drop the sessions it no longer lists"
  publishedUsedIds: readonly string[] = []
  // static idle actuation preview (refreshIdlePoses): partId → the (behavior + params + held cargo) key its rig
  // was last posed for while stopped, so a re-sync only re-settles a device whose source/params actually
  // changed (a move-drag or selection keeps the same key). Cleared on the run→stop edge so Stop re-poses fresh.
  readonly idlePoseKeys = new Map<string, string>()
  // the authored cargo the storing parts preview holding, reused while no cargo changed (a drag of anything else)
  readonly cargoFrame = memoizeAuthoredCargoFrame()
  // each part's idleKey, by part object: the key carries the whole behavior source, so rebuilding it for every rig on
  // every scene change would make an edit of one part cost every rig's source
  readonly idleKeys = new WeakMap<SdkPart, { pkg: PartPackage; zones: string; key: string }>()
  // Posable rigs the pose gizmo holds away from their saved idle pose (a drag, a waypoint shown): jogging, the
  // manipulator's Use. The view's gizmo holds the pose; this holds which rigs, mirrored to the store as `joggedIds`
  // for the Inspector. Session state like the sessions above: dropped on Reset, on Play, and when the saved idle
  // pose changes under it (the gizmo yields to it).
  readonly jogged = new Set<string>()
  // the `joggedIds` array last published, so a change this did not make (loadScene clearing it) reads as a drop
  publishedJoggedIds: readonly string[] = []
}

/** what the idle preview and the sessions read and write: the run flag + `usedIds` mirror, the rigs, the shown scene */
export type UseSessionDeps = Pick<EditorController, 'store' | 'view' | 'editTargetViewScene'>

/** {@link idleKey} for a part, rebuilt only when the part, its package or what its zones hold changed */
function idleKeyOf(u: UseSessions, part: SdkPart, pkg: PartPackage, zones: Record<string, number> | undefined): string {
  const z = zones ? JSON.stringify(zones) : ''
  const hit = u.idleKeys.get(part)
  if (hit && hit.pkg === pkg && hit.zones === z) return hit.key
  const key = idleKey(pkg.behavior, part.params ?? {}, zones)
  u.idleKeys.set(part, { pkg, zones: z, key })
  return key
}

export function refreshIdlePoses(u: UseSessions, ec: UseSessionDeps, scene: SceneJSON): void {
  if (ec.store.getState().running) return // applyBoxFrame owns the rig while running
  const live = new Set<string>()
  // what a storing part's zones hold (PartPackage.holds, a dispenser's magazine), so it previews holding its authored
  // stock. Only for parts that declare `holds`: that is the declaration that their state is what they hold, and a
  // part that merely senses in a zone (a scanner, a wrapper's station) stays on neutral input. The cargo is built
  // once per pass, only when needed; the counts are in the memo key, so Fill / Empty re-settle the part
  let cargo: BoxFrame | null = null
  const zonesOf = (part: SdkPart, pkg: PartPackage): Record<string, number> | undefined => {
    if (!pkg.holds || pkg.geometry.kind !== 'rig') return undefined
    return authoredZoneCounts(part, pkg, (cargo ??= u.cargoFrame(scene.parts)))
  }
  let dropped = false
  for (const part of scene.parts) {
    if (part.type !== 'part') continue
    const pkg = getPackage((part as SdkPart).packageId)
    // sim-driven rigs only; a posable manipulator poses itself. Zero-joint rigs stay in: a push button
    // actuates via subPose + lamp, no joints at all. A rig that commands nothing settles in a few dozen
    // cheap script steps and returns null, so static rigs (fence, rack) cost ~nothing here.
    if (!pkg || pkg.geometry.kind !== 'rig' || pkg.geometry.posable === true) continue
    live.add(part.id)
    const zones = zonesOf(part as SdkPart, pkg)
    const key = idleKeyOf(u, part as SdkPart, pkg, zones)
    // a device a stopped Use is operating owns its pose - unless its design changed under it (an Inspector
    // edit, an undo, a peer's change), which ends the session: the design wins, and it is posed from it below
    const used = u.sessions.get(part.id)
    if (used && used.key === key) continue
    if (used) {
      dropUseSession(u, part.id)
      dropped = true
    }
    if (u.idlePoseKeys.get(part.id) === key) continue // source + params + held cargo unchanged → rig already posed
    u.idlePoseKeys.set(part.id, key)
    const params = (part as SdkPart).params ?? {}
    const pose = withJointRests(settleIdlePose(pkg.behavior, params, 0, zones, rigJointsJson(pkg.geometry), posableArraysJson(pkg.geometry)), pkg.geometry.joints, params)
    if (pose) ec.view.applyIdlePose(part.id, pose) // null (nothing to actuate) → the rig stays at rest
  }
  for (const id of [...u.idlePoseKeys.keys()]) if (!live.has(id)) u.idlePoseKeys.delete(id)
  for (const id of [...u.sessions.keys()]) {
    if (live.has(id)) continue
    dropUseSession(u, id)
    dropped = true
  }
  if (dropped) syncUsedIds(u, ec.store)
}

export function pressIdle(u: UseSessions, ec: UseSessionDeps, partId: string, key: string, open: () => IdleUseSession | null): void {
  const existing = u.sessions.get(partId)
  if (existing && existing.key !== key) dropUseSession(u, partId)
  let entry = u.sessions.get(partId)
  if (!entry) {
    const session = open()
    if (!session) return
    entry = { session, key }
    u.sessions.set(partId, entry)
    syncUsedIds(u, ec.store)
  }
  entry.session.press()
}

export function resetUse(u: UseSessions, ec: UseSessionDeps, partId: string): void {
  if (!u.sessions.has(partId)) return
  dropUseSession(u, partId)
  syncUsedIds(u, ec.store)
  refreshIdlePoses(u, ec, ec.editTargetViewScene(ec.store.getState()))
}

/** end one session; its idle memo is forgotten so the next refresh re-poses it from the design */
export function dropUseSession(u: UseSessions, partId: string): void {
  const entry = u.sessions.get(partId)
  if (!entry) return
  entry.session.dispose()
  u.sessions.delete(partId)
  u.idlePoseKeys.delete(partId)
}

export function dropUseSessions(u: UseSessions, store: EditorStore): void {
  if (u.sessions.size === 0) return
  for (const id of [...u.sessions.keys()]) dropUseSession(u, id)
  syncUsedIds(u, store)
}

/** mirror the operated devices to the store (`usedIds`) when the set changed - UI state, never an edit */
export function syncUsedIds(u: UseSessions, store: EditorStore): void {
  const ids = [...u.sessions.keys()]
  const cur = store.getState().usedIds
  if (cur === u.publishedUsedIds && ids.length === cur.length && ids.every((id, i) => cur[i] === id)) return
  u.publishedUsedIds = ids
  store.setState({ usedIds: ids })
}

/** a rig gizmo gesture may have jogged this rig: track it, and publish */
export function noteJog(u: UseSessions, ec: UseSessionDeps, partId: string): void {
  u.jogged.add(partId)
  syncJoggedIds(u, ec)
}

/** forget rigs no longer jogged (a Capture into their idle pose, an undo, a rebuild), then mirror the rest to the
 *  store (`joggedIds`) when the set changed - UI state, never an edit */
export function syncJoggedIds(u: UseSessions, ec: UseSessionDeps): void {
  for (const id of [...u.jogged]) if (!ec.view.rigJogged(id)) u.jogged.delete(id)
  const ids = [...u.jogged]
  const cur = ec.store.getState().joggedIds
  if (cur === u.publishedJoggedIds && ids.length === cur.length && ids.every((id, i) => cur[i] === id)) return
  u.publishedJoggedIds = ids
  ec.store.setState({ joggedIds: ids })
}

/** put one jogged rig back at its saved idle pose (the Inspector's Reset) */
export function resetJog(u: UseSessions, ec: UseSessionDeps, partId: string): void {
  ec.view.resetRigJog(partId)
  syncJoggedIds(u, ec)
}

/** put every jogged rig back (a run starts from the design, and a replaced scene drops them) */
export function dropJogs(u: UseSessions, ec: UseSessionDeps): void {
  for (const id of u.jogged) ec.view.resetRigJog(id)
  u.jogged.clear()
  syncJoggedIds(u, ec)
}

/** Step every device a stopped Use is operating by one rendered frame, re-posing the ones that moved. A device
 *  back where its design puts it has nothing left to hold, so its session ends there. */
export function tickUseSessions(u: UseSessions, ec: UseSessionDeps, dt: number): void {
  if (u.sessions.size === 0 || ec.store.getState().running) return
  let ended = false
  for (const [id, { session }] of [...u.sessions]) {
    if (session.advance(dt)) ec.view.applyIdlePose(id, session.pose)
    if (session.atRest) {
      dropUseSession(u, id)
      ended = true
    }
  }
  if (ended) {
    syncUsedIds(u, ec.store)
    refreshIdlePoses(u, ec, ec.editTargetViewScene(ec.store.getState()))
  }
}
