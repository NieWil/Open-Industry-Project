// Color Sensor — a photoeye that tells which of a list of colours the cargo crossing its beam is. Demonstrates the
// colour output of sensing: the host hands ctx.sense().color the detected tint; the behavior matches it against the
// `colors` param and publishes a code an ST program reads as an INT: 1 for the first colour in the list, 2 for the
// second, and so on, 0 for nothing in range or no listed colour within the tolerance.
//
// It shares the Photo Eye's housing (_shared/sensorPhotoeye.js), in its own colours (teal body, red lens).
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { PHOTOEYE, photoeyeHousing } from '../_shared/sensorPhotoeye.js'

const r8 = (n) => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8)) // derived constants at 8 decimals
// the housing's; EMIT_Y/EMIT_Z mirror src/core/types SENSOR_EMIT_*
const EMIT_Y = PHOTOEYE.emitY
const EMIT_Z = PHOTOEYE.front
const MAX_RANGE = 10
const CYAN = [0.1, 0.85, 1] // detection LED - cyan sets it apart from the photo eye's orange
// housing materials: authored sRGB, stored linear (rig colours are linear)
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const lin = (rgb) => rgb.map((c) => r8(srgb2lin(c)))

// The `colors` param ('#rrggbb' joined by commas) as sRGB 0..255 triples, the same space ctx.sense().color is in.
// Parsed again only when the param changes.
let listText
let list = []
function colorList(csv) {
  if (csv === listText) return list
  listText = csv
  list = (csv || '').split(',').map((c) => c.trim().replace(/^#/, '')).filter((c) => /^[0-9a-f]{6}$/i.test(c)).map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)))
  return list
}

// The code of the listed colour nearest the tint: each channel within `tolerance` steps of 255, the closest by its
// worst channel, the earlier entry on a tie. 0 when none is close enough.
function classify(c, colors, tolerance) {
  let code = 0
  let best = Infinity
  for (let i = 0; i < colors.length; i++) {
    const k = colors[i]
    const d = Math.max(Math.abs(c[0] * 255 - k[0]), Math.abs(c[1] * 255 - k[1]), Math.abs(c[2] * 255 - k[2]))
    if (d <= tolerance && d < best) {
      best = d
      code = i + 1
    }
  }
  return code
}

definePart({
  manifest: {
    id: 'oip.color-sensor',
    name: 'Color Sensor',
    category: 'Devices',
    // Declarative snap: the host lands 'at' (the lens front face) on the nearer conveyor guard, pushes the body
    // out by outwardOffset, aims the beam (local +Z) inward across the belt, and fits maxRange to span it.
    snap: {
      // yOffset 0.02: seated 2 cm below the belt surface, so the housing tops out under the 0.15 m guard's outward top
      // return (see examples/parts/diffuse-sensor/part.js)
      mounts: [{ at: [0, 0, EMIT_Z], accepts: 'conveyorGuard', face: 'in', outwardOffset: 0.02, yOffset: 0.02, fitRangeParam: 'maxRange' }],
    },
    materials: [
      { id: 'body', color: lin([0, 0.4, 0.5]), metalness: 0, roughness: 0.55 }, // housing → teal
      { id: 'black', color: lin([0.03, 0.03, 0.03]), metalness: 0, roughness: 0.55 }, // plug + top cap → near-black
      { id: 'lens', color: lin([0.45, 0, 0]), metalness: 0, roughness: 0.55 }, // lens window → red
      { id: 'pot', color: lin([0.55, 0.55, 0.55]), metalness: 0.3, roughness: 0.45 }, // the sensitivity pot
      { id: 'steel', color: lin([0.72, 0.74, 0.76]), metalness: 0.8, roughness: 0.38 }, // the mounting bracket → zinc-plated steel
    ],
  },
  lamps: ['led'],
  params: {
    maxRange: { type: 'number', default: 2, min: 0.1, max: 10, step: 0.05, label: 'Max range (m)', desc: 'How far down the beam a target is still read. The beam is cast along local +Z, so aim the sensor by rotating it.' },
    showBeam: { type: 'boolean', default: true, label: 'Show beam', desc: 'Draw the beam line in the viewport. A viewing aid only - hiding it does not change what the sensor reads.' },
    colors: { type: 'color', list: true, default: '#ff0000,#00ff00,#0000ff', label: 'Colors', desc: 'The colours this sensor tells apart. The colour code is the position in this list: 1 for the first, 2 for the second, and so on.' },
    tolerance: { type: 'number', default: 80, min: 0, max: 255, step: 1, label: 'Match tolerance', desc: 'How far a tint may be from a listed colour and still match, in steps of 0 to 255 on each of red, green and blue. 0 matches only the exact colour. When two listed colours are within range, the closer one wins.' },
    colorTag: { type: 'tag', values: [{ value: 0, label: 'none' }], dir: 'out', stType: 'INT', default: '', label: 'Color code tag', group: 'Comms', desc: 'Where the detected colour code is published: the position of the matched colour in Colors (1 = the first), or 0. It reads 0 both when nothing is in range and when no listed colour matches, so pair it with a presence sensor if the difference matters.' },
  },
  // The lens and the LED; the housing is geometry()'s.
  rig() {
    return {
      links: [
        { name: 'lens', shape: { kind: 'frame' }, offset: [0, EMIT_Y, EMIT_Z], beam: { range: MAX_RANGE, rangeParam: 'maxRange', showParam: 'showBeam', tint: 'hit' } },
        { name: 'led', shape: { kind: 'box', size: [0.014, 0.008, 0.012] }, offset: PHOTOEYE.led, lamps: [{ emissive: CYAN }] },
      ],
      joints: [],
      bounds: { length: 2 * PHOTOEYE.halfX, width: PHOTOEYE.front - PHOTOEYE.back, top: PHOTOEYE.height },
    }
  },
  // The Photo Eye's housing, drawn: body, lens window, top cap + pot, M8 plug, and the mounting bracket.
  geometry(g) {
    return photoeyeHousing(g)
  },
  react(ctx) {
    const s = ctx.sense('lens')
    const present = s.hit && s.distance <= ctx.params.maxRange
    const code = present ? classify(s.color, colorList(ctx.params.colors), ctx.params.tolerance) : 0
    ctx.lamps.led = present
    if (ctx.params.colorTag) ctx.writeNumber(ctx.params.colorTag, code)
  },
})
