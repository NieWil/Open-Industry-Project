// A behavior's conveying command, folded into its deck's conveyor entries in place each tick (SimWorld
// tickBehaviors): the entries are the same objects the contact listener and the native facet sync read.
import type { BehaviorOutput } from './embeddedBehavior'
import type { BehaviorRecord } from './worldTypes'

/** drive every conveying deck of `b` from this tick's output; `sv` is `parsed.surfaceVelocity` */
export function driveDeckEntries(b: BehaviorRecord, parsed: BehaviorOutput, sv: BehaviorOutput['surfaceVelocity']): void {
  // a posable conveying array's copies: each runs only at the speed set for it this tick, along its own local +X
  if (b.copyDecks) {
    for (const cd of b.copyDecks) {
      const speeds = parsed.copySpeeds?.[cd.link]
      for (let i = 0; i < cd.entries.length; i++) {
        const m = cd.entries[i]!
        const s = speeds?.[i] ?? 0
        if (s === 0) {
          m.vx = 0
          m.vy = 0
          m.vz = 0
          continue
        }
        const q = cd.bodies[i]!.GetRotation()
        const qx = q.GetX(), qy = q.GetY(), qz = q.GetZ(), qw = q.GetW()
        m.vx = s * (1 - 2 * (qy * qy + qz * qz))
        m.vy = s * 2 * (qx * qy + qw * qz)
        m.vz = s * 2 * (qx * qz - qw * qy)
      }
    }
  }
  // C-convey: drive all of this part's conveying decks in place, with an arc field (curved conveyor) or a
  // linear velocity (belt/roller). Mutating each entry's kind+fields updates what the live contact
  // listener reads (the entry objects are the same references the conveyors map holds). Arc takes
  // precedence if both are set.
  if (b.conveyorEntries) {
    const ces = b.conveyorEntries
    for (let i = 0; i < ces.length; i++) {
      const m = ces[i] as { kind: 'linear' | 'arc'; vx?: number; vy?: number; vz?: number; cx?: number; cz?: number; omega?: number; tan?: { x: number; y: number } }
      const deck = b.deckBodies?.[i]
      if (!parsed.arc && parsed.deckSpeed !== undefined && deck) {
        // ctx.setSurfaceSpeed: along this deck's own local +X, read off its body now (a hinged section's
        // orientation is whatever its joints put it in this tick), so each section carries its own way
        const q = deck.GetRotation()
        const qx = q.GetX(), qy = q.GetY(), qz = q.GetZ(), qw = q.GetW()
        const s = typeof parsed.deckSpeed === 'number' ? parsed.deckSpeed : (parsed.deckSpeed[i] ?? 0)
        m.kind = 'linear'
        m.vx = s * (1 - 2 * (qy * qy + qz * qz))
        m.vy = s * 2 * (qx * qy + qw * qz)
        m.vz = s * 2 * (qx * qz - qw * qy)
      } else if (parsed.arc) {
        m.kind = 'arc'
        m.cx = parsed.arc.cx
        m.cz = parsed.arc.cz
        m.omega = parsed.arc.omega
      } else if (sv) {
        m.kind = 'linear'
        if (m.tan) {
          // per-segment belt facet: project the commanded surface velocity onto this run/prism's own
          // tangent (rotated by the part forward) so cargo is carried up/over the incline, not pushed flat.
          const s = sv[0] * b.fwd[0] + sv[2] * b.fwd[2] // belt speed = sv · forward (signed)
          m.vx = s * b.fwd[0] * m.tan.x
          m.vy = s * m.tan.y
          m.vz = s * b.fwd[2] * m.tan.x
        } else {
          m.vx = sv[0]
          m.vy = sv[1]
          m.vz = sv[2]
        }
      }
    }
  } else if (b.entry && (parsed.deckSpeed !== undefined || sv)) {
    // a plain deck part: a deck speed is along the part's forward, like any other surface velocity
    const ds = parsed.deckSpeed === undefined ? undefined : typeof parsed.deckSpeed === 'number' ? parsed.deckSpeed : (parsed.deckSpeed[0] ?? 0)
    const v = ds !== undefined ? [ds * b.fwd[0], 0, ds * b.fwd[2]] : sv!
    b.entry.vx = v[0]!
    b.entry.vy = v[1]!
    b.entry.vz = v[2]!
  }
}
