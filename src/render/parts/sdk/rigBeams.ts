// Sensor beam visuals for a rig (buildRig in rig.ts): a link with a `beam` draws the live beam line the built-in
// sensors draw, aimed and tinted per probe pass. Refresh resolves each beam's range and show params; dispose
// hands the beams back to the scene-level bank.

import { Group, Quaternion, Vector3 } from 'three'
import type { PartPackage } from '../../../core/parts/partPackage'
import { BEAM_GREEN, BEAM_RED } from '../sensor'
import type { BeamProbe } from '../sensor'
import { addSensorBeam } from '../../sensorBeamOverlay'
import type { SensorBeam } from '../../sensorBeamOverlay'

// reused per beam probe (single-threaded render loop, like sensor.ts's temps); never retained across frames
const _beamQ = new Quaternion()
const _beamOrigin = new Vector3()
const _beamDir = new Vector3()

export type BeamVisual = { name: string; group: Group; beam: SensorBeam; axis: Vector3; range: number; rangeParam?: string; showParam?: string; paramRange: number | null; shown: boolean; tintHit: boolean; lastDist: number }

export function createRigBeams(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, root: Group, linkGroups: ReadonlyMap<string, Group>): { beamVisuals: BeamVisual[]; probeTick: ((probe: BeamProbe) => boolean) | undefined } {
  // C-sensing beam visual: a link with a `beam` draws the same live beam line as the built-in sensors
  // (sensor.ts) and publishes the guard-hole segment each frame - probeTick, driven by view.ts's per-entry
  // probe loop. The line runs to the link's `beam.rangeParam` (default-resolved, the same length the sim senses
  // to; else its declared range) and hides when its `beam.showParam` is false; `beam.tint:'hit'` colours a
  // blocked beam with the detected cargo's tint instead of red (the colour sensor). `paramRange` / `shown` are
  // those two, resolved in refresh.
  const beamVisuals: BeamVisual[] = []
  for (const link of geo.links) {
    if (!link.beam) continue
    const g = linkGroups.get(link.name)!
    const axis = new Vector3(link.beam.axis?.[0] ?? 0, link.beam.axis?.[1] ?? 0, link.beam.axis?.[2] ?? 1).normalize()
    // Not a mesh under g: the beam renders in the overlay pass, so it must not sit inside the part's
    // rig (which is bundled under WebGPU, and bundles execute after every base draw, so they would paint
    // over it). Every beam in the scene is one instance of a shared bank instead: probeTick
    // writes its world aim + tint below, and `root` is passed so the bank can mirror the part's
    // visibility each frame. It stays collapsed/undrawn until that first probe, which keeps an
    // unprobed thumbnail rig out of the overlay gate. See sensorBeamOverlay.ts.
    beamVisuals.push({ name: link.name, group: g, beam: addSensorBeam(root), axis, range: link.beam.range, ...(link.beam.rangeParam !== undefined ? { rangeParam: link.beam.rangeParam } : {}), ...(link.beam.showParam !== undefined ? { showParam: link.beam.showParam } : {}), paramRange: null, shown: true, tintHit: link.beam.tint === 'hit', lastDist: -1 })
  }
  const probeTick = beamVisuals.length
    ? (probe: BeamProbe): boolean => {
        // hidden part: no beam (mirrors the built-in sensors). The guard holes a beam cuts are not drawn from here:
        // they are geometry, worked out from the scene (core/guards/guardHoles.ts), so hiding a sensor leaves them. The show flags are
        // left alone - syncSensorBeams ANDs them with root.visible every frame, so
        // the beams come back with the part without needing another probe seam (WebGPU's staged
        // compile hides parts outside any seam; see sensorBeamOverlay.ts).
        if (!root.visible) return false
        let mutated = false // whether a beam visual changed (stretch/tint) - the view's bundle activity mark
        for (const bv of beamVisuals) {
          bv.group.getWorldPosition(_beamOrigin)
          _beamDir.copy(bv.axis).applyQuaternion(bv.group.getWorldQuaternion(_beamQ))
          const range = bv.paramRange ?? bv.range
          if (!bv.shown) {
            bv.beam.setShow(false)
            continue
          }
          const hit = probe(_beamOrigin, _beamDir, range, bv.name)
          const dist = hit ? Math.min(hit.distance, range) : range
          // tint only on a real change, so a steady beam doesn't mark its part dirty every probe pass
          const tint = bv.tintHit ? (hit ? hit.color : BEAM_GREEN) : hit ? BEAM_RED : BEAM_GREEN
          if (bv.beam.tint(tint)) mutated = true
          bv.beam.setShow(true)
          // World aim, rewritten every probe: the beam is an instance of the scene-level bank, so it
          // inherits nothing from the part and must re-derive its placement whenever the part moves,
          // not only when the hit distance changes. The beam is outside the matrix-frozen rig and
          // outside the bundle, so these few vector ops need no poseRev bump and no per-frame re-bake.
          bv.beam.aim(_beamOrigin, _beamDir, dist)
          // still change-gated: `mutated` is the view's activity mark, not the transform write
          if (dist !== bv.lastDist) {
            bv.lastDist = dist
            mutated = true
          }
        }
        return mutated
      }
    : undefined
  return { beamVisuals, probeTick }
}
