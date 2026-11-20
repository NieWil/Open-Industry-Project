// What each cargo body is touching, by name: the scene parts, other cargo and the floor its shape is within a few
// millimetres of. For a test run's cargo snapshots (test-project --cargo, run_test's `cargo`), where an author tuning
// a pusher or a transfer needs to know what a launched or tipped box was pressed against.
//
// Run only when a snapshot is taken, never per step: each body's own shape is collided, where it stands, against the
// world (the narrow phase). Jolt's contact record (WereBodiesInContact) is not used: a sleeping or pinned body keeps
// no contacts, so a box lying on the floor would read as touching nothing.

import type Jolt from 'jolt-physics'
import type { JoltModule, LiveBox, PartGroup } from './worldTypes'

/** how far apart two shapes may be and still count as touching, m: resting contact sits within the collision margin */
const TOUCH_GAP = 0.005

export interface ContactSources {
  system: Jolt.PhysicsSystem
  boxes: readonly LiveBox[]
  groups: ReadonlyMap<string, PartGroup>
  ground: readonly Jolt.Body[]
}

/** By cargo frame id: what that body touches, as part ids, `cargo <id>` and `floor`, sorted. A body touching nothing
 *  has an empty list. */
export function cargoContacts(J: JoltModule, src: ContactSources): Map<number, string[]> {
  // every body's owner by its BodyID bits. Cargo is named by its frame id, as the snapshot rows are, even when an
  // authored cargo part files its body; a joined unit load's pieces share one body, named by its first piece
  const owner = new Map<number, string>()
  for (const [partId, g] of src.groups) for (const b of g.bodies) owner.set(b.GetID().GetIndexAndSequenceNumber(), partId)
  for (const b of src.ground) owner.set(b.GetID().GetIndexAndSequenceNumber(), 'floor')
  const named = new Set<number>()
  for (const box of src.boxes) {
    if (named.has(box.key)) continue
    named.add(box.key)
    owner.set(box.key, `cargo ${box.id}`)
  }

  const settings = new J.CollideShapeSettings()
  settings.mMaxSeparationDistance = TOUCH_GAP
  const scale = new J.Vec3(1, 1, 1)
  const offset = new J.RVec3(0, 0, 0)
  const anyBroadPhase = new J.BroadPhaseLayerFilter()
  const anyObject = new J.ObjectLayerFilter()
  const anyShape = new J.ShapeFilter()
  const query = src.system.GetNarrowPhaseQuery()
  const out = new Map<number, string[]>()
  try {
    for (const box of src.boxes) {
      const collector = new J.CollideShapeAllHitCollisionCollector()
      const notSelf = new J.IgnoreSingleBodyFilter(box.body.GetID())
      query.CollideShape(box.body.GetShape(), scale, box.body.GetCenterOfMassTransform(), settings, offset, collector, anyBroadPhase, anyObject, notSelf, anyShape)
      const touching = new Set<string>()
      const hits = collector.mHits
      for (let i = 0; i < hits.size(); i++) touching.add(owner.get(hits.at(i).mBodyID2.GetIndexAndSequenceNumber()) ?? 'an unnamed body')
      J.destroy(notSelf)
      J.destroy(collector)
      out.set(box.id, [...touching].sort())
    }
  } finally {
    J.destroy(settings)
    J.destroy(scale)
    J.destroy(offset)
    J.destroy(anyBroadPhase)
    J.destroy(anyObject)
    J.destroy(anyShape)
  }
  return out
}
