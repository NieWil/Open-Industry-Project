// Photo Eye - a photoelectric presence sensor, diffuse or retro-reflective (the package id still says diffuse:
// stored scenes and rooms name it). Demonstrates sensing (ctx.sense), an emissive detection LED (ctx.lamps), and
// a PLC presence tag. The lens emits a beam along local +Z; the host casts it against cargo each tick and
// hands back the nearest hit. Both modes come down to that one cast: the first target in the beam before Max range.
//
// The housing is the shared photoeye (_shared/sensorPhotoeye.js), drawn by geometry().
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { PHOTOEYE, PHOTOEYE_BRACKET, photoeyeHex, photoeyeHousing, photoeyeSidePlate, photoeyeToe, photoeyeToeBolts } from '../_shared/sensorPhotoeye.js'

const r8 = (n) => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8)) // derived constants at 8 decimals
// the housing's; EMIT_Y/EMIT_Z mirror src/core/types SENSOR_EMIT_*
const EMIT_Y = PHOTOEYE.emitY // inside the lens window
const EMIT_Z = PHOTOEYE.front // the lens face
const MAX_RANGE = 10 // the beam's static range, used only if the `maxRange` param (its rangeParam) is not > 0
const ORANGE = [1, 0.35, 0] // detection LED
// housing materials: authored sRGB, stored linear (rig colours are linear)
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const lin = (rgb) => rgb.map((c) => r8(srgb2lin(c)))

definePart({
  manifest: {
    id: 'oip.diffuse-sensor',
    name: 'Photo Eye',
    category: 'Devices',
    // Built entirely in code: no model asset.
    // Declarative snap: the host lands 'at' (the lens front face) on the nearer conveyor guard, pushes the body
    // out by outwardOffset, aims the beam (local +Z) inward across the belt, and fits maxRange to span it.
    snap: {
      // yOffset 0.02: seated 2 cm below the belt surface, so the housing (0.16 to the pot) tops out under the 0.15 m
      // guard's outward top return instead of running into it, and the beam crosses the guard at 0.08 m through a
      // clean hole rather than a notch out of its top edge
      mounts: [{ at: [0, 0, EMIT_Z], accepts: 'conveyorGuard', face: 'in', outwardOffset: 0.02, yOffset: 0.02, fitRangeParam: 'maxRange' }],
    },
    materials: [
      { id: 'body', color: lin([0.81967, 0.498029, 0.196071]), metalness: 0.511, roughness: 0.361 }, // Body → orange
      { id: 'black', color: lin([0.03, 0.03, 0.03]), metalness: 0, roughness: 0.55 }, // Connector + Top → near-black
      { id: 'lens', color: lin([0.03, 0.015, 0.015]), metalness: 0, roughness: 0.35 }, // Diffuse lens → dark
      { id: 'pot', color: lin([0.55, 0.55, 0.55]), metalness: 0.3, roughness: 0.45 }, // the sensitivity pot
      { id: 'steel', color: lin([0.72, 0.74, 0.76]), metalness: 0.8, roughness: 0.38 }, // the mounting bracket → zinc-plated steel
      { id: 'reflector', color: lin([0.75, 0.04, 0.03]), metalness: 0.1, roughness: 0.25 }, // the retro-reflector's prism disc → red
    ],
  },
  lamps: ['led'],
  params: {
    maxRange: { type: 'number', default: 2, min: 0.1, max: 10, step: 0.05, label: 'Max range (m)', desc: 'How far down the beam a target still counts as present. The beam is cast along local +Z, so aim the sensor by rotating it; snapping it onto a conveyor guard fits this range across the lane for you.' },
    mode: {
      type: 'enum', default: 'diffuse', label: 'Sensing mode',
      desc: 'How the eye is installed. Diffuse: the target itself reflects the light back to the eye, so nothing stands opposite it. Retro-reflective: the eye looks at a reflector on the far side of the lane and a target breaking that beam is detected; the reflector is drawn at Max range, so snapping the eye onto a conveyor guard puts it on the far guard. In the sim both detect the same way: a target in the beam before Max range.',
      options: [
        { value: 'diffuse', label: 'Diffuse' },
        { value: 'retro', label: 'Retro-reflective' },
      ],
    },
    showBeam: { type: 'boolean', default: true, label: 'Show beam', desc: 'Draw the beam line in the viewport. A viewing aid only - hiding it does not change what the sensor detects.' },
    normallyClosed: { type: 'boolean', default: false, label: 'Normally closed (inverts the signal)', desc: 'Invert the output, so the tag reads true when NOTHING is detected. The beam colour still follows the real detection, not the inverted signal.' },
    mark: { type: 'string', suggest: 'marks', default: '', label: 'Only marked targets', desc: 'Count a target only if a machine upstream left this mark on it (wrapped, or a label a labeller wrote). Empty: anything in the beam counts. This is how a program checks a product, not just its presence - a load that was never wrapped reads as clear.' },
    tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Presence tag', group: 'Comms', desc: 'Where the photoeye publishes presence for the program to read. Whether true means blocked or clear is set by Normally closed above.' },
  },
  // The lens and the LED. Visual-only, no `collision`: a photoeye doesn't block cargo, and the editor picks it off
  // the rendered mesh.
  rig() {
    return {
      links: [
        // the lens emits the sensing beam along local +Z (the host casts it; ctx.sense('lens') reads the hit)
        { name: 'lens', shape: { kind: 'frame' }, offset: [0, EMIT_Y, EMIT_Z], beam: { range: MAX_RANGE, rangeParam: 'maxRange', showParam: 'showBeam' } },
        { name: 'led', shape: { kind: 'box', size: [0.014, 0.008, 0.012] }, offset: PHOTOEYE.led, lamps: [{ emissive: ORANGE }] },
      ],
      joints: [],
      bounds: { length: 2 * PHOTOEYE.halfX, width: PHOTOEYE.front - PHOTOEYE.back, top: PHOTOEYE.height },
    }
  },
  // The housing, drawn: a body with a chamfered lower back and two mounting holes, the lens window on the face,
  // a top cap with a sensitivity pot, and an M8 plug underneath. Part-local metres, front (+Z) = the beam.
  geometry(g, p) {
    const out = photoeyeHousing(g)
    // RETRO-REFLECTOR at the beam's far end, the eye's mirror image across the bed. A guard mount fits maxRange to
    // the bed's width plus the lens's 20 mm stand-off at BOTH edges, so the reflector's face lands 20 mm out from the
    // far bed edge, outside that guard as the eye is outside its own, and its bracket is the eye's, mirrored: the same
    // side plate round that rail's guard and lip, the same toe on its wall. Its own submeshes, so the housing's still
    // pool across every copy whatever their ranges.
    if (p.mode === 'retro') {
      const BT = PHOTOEYE_BRACKET.gauge, BW = PHOTOEYE_BRACKET.width
      const F = PHOTOEYE.front + (typeof p.maxRange === 'number' && p.maxRange > 0 ? p.maxRange : 2) // the face, at far u 0.02
      const FU2Z = (u) => F - 0.02 + u // far side: z grows with u
      const E = PHOTOEYE.emitY, RR = 0.025, RT = 0.008 // the beam height, the disc's radius and thickness
      const disc = g.lathe([[0, 0], [RR - 0.002, 0], [RR, 0.002], [RR, RT], [0, RT]], { axis: 'z', center: [0, E, F], segments: 24 })
      const rim = g.lathe([[RR, 0.001], [RR + 0.003, 0.001], [RR + 0.003, RT + 0.001], [RR, RT + 0.001]], { axis: 'z', center: [0, E, F], segments: 24 })
      // the plate behind the disc, and the side plate it is bent from at its +X edge
      const PX0 = -0.032, PX1 = 0.058, PH = 0.032, UP = 0.02 + RT // u of the plate's face
      const plate = g.box([PX1 - PX0, 2 * PH, BT], [(PX0 + PX1) / 2, E, FU2Z(UP + BT / 2)])
      const rbracket = g.merge(
        rim, plate, photoeyeSidePlate(g, PX1 - BT, E + PH, UP, FU2Z), photoeyeToe(g, PX1 - BW, FU2Z), ...photoeyeToeBolts(g, PX1 - BW * 0.62, FU2Z),
        photoeyeHex(g, 'z', [0, E, FU2Z(UP + BT)]),
      )
      const both = { doubleSided: true }
      out.push(Object.assign({ desc: disc, material: 'reflector' }, both))
      out.push(Object.assign({ desc: rbracket, material: 'steel' }, both))
    }
    return out
  },
  react(ctx) {
    // the host casts the beam out to the maxRange param (its rangeParam); the gate below keeps that explicit
    const s = ctx.sense('lens')
    const want = ctx.params.mark
    const present = s.hit && s.distance <= ctx.params.maxRange && (!want || (!!s.marks && !!s.marks[want]))
    // a PLC that drives this tag is watching a real eye (Watch only): the LED shows what that eye reports
    if (ctx.params.tag && ctx.tagDriven(ctx.params.tag)) {
      ctx.lamps.led = ctx.readTag(ctx.params.tag) !== !!ctx.params.normallyClosed
      return
    }
    ctx.lamps.led = present // raw presence, not the NC-inverted output
    let out = present
    if (ctx.params.normallyClosed) out = !out // NC: de-energized (no cargo) reads true
    if (ctx.params.tag) ctx.writeTag(ctx.params.tag, out)
  },
})
