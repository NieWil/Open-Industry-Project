// What a storing part holds (PartPackage.holds): a magazine's pallets, a buffer's totes. The stored items are real
// cargo parts, authored at the holder's gripper positions and parented to it, so the stopped scene shows exactly
// what a run starts with and the behavior grips what it finds there. This module is where those positions are, which
// of them are filled, and the Fill / Empty edits the Inspector offers. Pure: scene in, scene out.

import type { HoldsDecl, PartPackage } from './parts/partPackage'
import { getPackage } from './parts/partRegistry'
import { arrayInstanceDeltas, parseCopyGripName, qApply, resolvedGrabZone, rigWorldPoses } from './rig/rigPose'
import type { Quat, RigParams, Vec3 } from './rig/rigPose'
import { resolvePartParams } from './parts/partScript'
import { createSdkPart, nextId } from './scene/scene'
import type { PartInstance, SceneJSON, SdkPart, SdkPartParams } from './types'

/** One position a part holds an item at: its gripper link, the item's centre in the world, and the zone it grips in. */
export interface HoldPosition {
  gripper: string
  centre: Vec3
  /** half extents of the gripper's zone, in the holder's frame: an item whose centre is inside is in this position */
  half: Vec3
}

const yawQuat = (rotationY: number): Quat => [0, Math.sin(rotationY / 2), 0, Math.cos(rotationY / 2)]

/** the holds declaration of a placed part, with its package, or null when the part holds nothing */
export function holdsOf(part: PartInstance | undefined): { pkg: PartPackage; holds: HoldsDecl } | null {
  if (!part || part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  return pkg?.holds && pkg.geometry.kind === 'rig' ? { pkg, holds: pkg.holds } : null
}

/** The positions in use (bottom first, capped by the limit param), where an item stands in each at the rest pose. */
export function holdPositions(part: SdkPart, pkg: PartPackage, holds: HoldsDecl): HoldPosition[] {
  if (pkg.geometry.kind !== 'rig') return []
  const params = part.params as Record<string, number | boolean | string>
  const scale = typeof params.scale === 'number' && params.scale > 0 ? params.scale : 1
  const limit = holds.limitParam !== undefined && typeof params[holds.limitParam] === 'number' ? Math.max(0, Math.round(params[holds.limitParam] as number)) : holds.positions.length
  const poses = rigWorldPoses(pkg.geometry, {}, undefined, scale, params)
  const q = yawQuat(part.rotationY)
  const out: HoldPosition[] = []
  for (const gripper of holds.positions.slice(0, limit)) {
    // a plain gripper link, or copy i of a posable gripper array (`link#i`), standing at its rest place in the row
    const copy = pkg.geometry.links.some((l) => l.name === gripper) ? null : parseCopyGripName(gripper)
    const name = copy ? copy.link : gripper
    const link = pkg.geometry.links.find((l) => l.name === name)
    const pose = poses.get(name)
    const zone = link ? resolvedGrabZone(link, params) : null
    if (!pose || !zone) continue
    let rest: Vec3 = [0, 0, 0]
    if (copy) {
      // counted with the defaults filled in, as the sim builds the row: a capacity left at its default is still 10
      const delta = link?.array?.posable ? arrayInstanceDeltas(link.array, resolvePartParams(pkg.params, params) as RigParams, undefined, link.showParam)[copy.index] : undefined
      if (!delta) continue
      rest = [delta[0] * scale, delta[1] * scale, delta[2] * scale]
    }
    // the zone centre in the part's frame (the link's pose carrying its zone offset), then into the world
    const off = qApply(pose.quat, [rest[0] + zone.offset[0] * scale, rest[1] + zone.offset[1] * scale, rest[2] + zone.offset[2] * scale])
    const local: Vec3 = [pose.pos[0] + off[0], pose.pos[1] + off[1], pose.pos[2] + off[2]]
    const w = qApply(q, local)
    out.push({ gripper, centre: [part.position[0] + w[0], part.position[1] + w[1], part.position[2] + w[2]], half: [zone.half[0] * scale, zone.half[1] * scale, zone.half[2] * scale] })
  }
  return out
}

/** is a world point inside a position's zone (in the holder's frame, which turns only about Y) */
function inPosition(p: readonly [number, number, number], pos: HoldPosition, rotationY: number): boolean {
  const d = qApply(yawQuat(-rotationY), [p[0] - pos.centre[0], p[1] - pos.centre[1], p[2] - pos.centre[2]])
  return Math.abs(d[0]) <= pos.half[0] && Math.abs(d[1]) <= pos.half[1] && Math.abs(d[2]) <= pos.half[2]
}

/** The items a part holds in the scene: its children of the held package (the ones Fill made, or the author parented). */
export function heldItems(scene: SceneJSON, part: SdkPart, holds: HoldsDecl): PartInstance[] {
  return scene.parts.filter((p) => p.parent === part.id && p.type === 'part' && p.packageId === holds.part)
}

/** How full a holder is: positions in use, and how many of them hold an item. */
export function holdCount(scene: SceneJSON, part: SdkPart): { filled: number; positions: number } | null {
  const h = holdsOf(part)
  if (!h) return null
  const positions = holdPositions(part, h.pkg, h.holds)
  const items = heldItems(scene, part, h.holds)
  const filled = positions.filter((pos) => items.some((it) => inPosition(it.position, pos, part.rotationY))).length
  return { filled, positions: positions.length }
}

/**
 * Fill every empty position in use with a new item of the held package, parented to the holder and turned with it.
 * Returns the new scene, or null when there is nothing to add (full, or the held package isn't loaded). The held
 * package is embedded in the scene's packages if it isn't yet, as placing it by hand would.
 */
export function fillHolds(scene: SceneJSON, partId: string): SceneJSON | null {
  const part = scene.parts.find((p) => p.id === partId)
  const h = holdsOf(part)
  if (!h || part?.type !== 'part') return null
  const cargo = getPackage(h.holds.part)
  if (!cargo) return null
  const items = heldItems(scene, part, h.holds)
  const empty = holdPositions(part, h.pkg, h.holds).filter((pos) => !items.some((it) => inPosition(it.position, pos, part.rotationY)))
  if (empty.length === 0) return null
  // the params the holder hands its items (holds.params): a magazine's pallet size, say
  const handed: SdkPartParams = {}
  for (const [itemParam, own] of Object.entries(h.holds.params ?? {})) {
    const v = part.params[own] ?? h.pkg.params[own]?.default
    if (v !== undefined) handed[itemParam] = v
  }
  let next: SceneJSON = { ...scene, parts: [...scene.parts] }
  for (const pos of empty) {
    const made = createSdkPart(cargo, nextId(next, 'part'), pos.centre, part.rotationY)
    const item: SdkPart = { ...made, params: { ...made.params, ...handed }, name: cargo.name, parent: part.id }
    next = { ...next, parts: [...next.parts, item] }
  }
  if (!(next.packages ?? []).some((p) => p.id === cargo.id)) next = { ...next, packages: [...(next.packages ?? []), cargo] }
  return next
}

/** Remove every item the part holds (its children of the held package). Null when it holds none. */
export function emptyHolds(scene: SceneJSON, partId: string): SceneJSON | null {
  const part = scene.parts.find((p) => p.id === partId)
  const h = holdsOf(part)
  if (!h || part?.type !== 'part') return null
  const gone = new Set(heldItems(scene, part, h.holds).map((p) => p.id))
  if (gone.size === 0) return null
  return { ...scene, parts: scene.parts.filter((p) => !gone.has(p.id)) }
}
