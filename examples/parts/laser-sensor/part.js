// Laser Sensor — a measuring light barrier that reports the distance to cargo in its beam. Demonstrates the
// distance output of sensing: the host hands ctx.sense().distance the metres to the nearest cargo within
// range; the behavior writes it to a PLC REAL tag (the measured range, or maxRange when the beam is clear).
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).
//
// The housing is drawn in code as a generic housing of this kind. The height, the footprint, where the beam leaves
// the housing (the snap `at` and the lens link sit there) and the materials are the part's interface. Part-local
// metres: +Z is the front (the beam axis), y 0 the underside of the connector.

import { circle, rrect } from '../_shared/sensorOutlines.js'

const r8 = (n) => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8)) // derived constants at 8 decimals
const LASER = {
  halfX: 0.057, // 114 mm wide across the body
  panel: 0.0008, // the label panel standing proud of each flank: the footprint's outer width is 2 * (halfX + panel)
  back: -0.0735,
  capZ: 0.04, // where the dark front cap meets the body
  front: 0.074, // the window face: the beam origin and the guard contact
  bodyY0: 0.038, // the housing's underside; the M12 plug hangs below it
  bodyY1: 0.152,
  emitY: 0.095, // the window's centre
  led: [0, 0.156, 0.056], // the detection LED, sitting on the front cap's top
  height: 0.16, // the LED's top
}
// Read off the housing, never restated: these once mirrored the photo eye's SENSOR_* (EMIT_Z 0.037), which put the
// beam origin, the LED and the snap point 3.7 cm inside this bigger housing, so every measured distance read 3.7 cm
// long.
const EMIT_Y = LASER.emitY // the window's centre
const FRONT_Z = LASER.front // the window face = beam origin = guard contact
const LED_POS = LASER.led // on the front cap's top; the front face is all window
const MAX_RANGE = 10
const RED = [1, 0.1, 0.05] // detection LED
// housing materials: authored sRGB, stored linear (rig colours are linear)
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const lin = (rgb) => rgb.map((c) => r8(srgb2lin(c)))

definePart({
  manifest: {
    id: 'oip.laser-sensor',
    name: 'Laser Sensor',
    category: 'Devices',
    // Built entirely in code: no model asset.
    // Declarative snap: the host lands 'at' (the lens front face) on the nearer conveyor guard, pushes the body
    // out by outwardOffset, aims the beam (local +Z) inward across the belt, and fits maxRange to span it.
    snap: {
      // yOffset 0.02: seated 2 cm below the belt surface, so the housing (0.16 to the LED) tops out under the 0.15 m
      // guard's outward top return (see examples/parts/diffuse-sensor/part.js)
      mounts: [{ at: [0, 0, FRONT_Z], accepts: 'conveyorGuard', face: 'in', outwardOffset: 0.02, yOffset: 0.02, fitRangeParam: 'maxRange' }],
    },
    materials: [
      { id: 'orange', color: lin([0.92, 0.4, 0.0]), metalness: 0, roughness: 0.45 }, // the display
      { id: 'amber', color: lin([0.5, 0.35, 0.0]), metalness: 0, roughness: 0.55 }, // the body
      { id: 'dark', color: lin([0.03, 0.015, 0.015]), metalness: 0, roughness: 0.35 }, // front cap + panels
      { id: 'black', color: lin([0.03, 0.03, 0.03]), metalness: 0, roughness: 0.55 }, // plug + screws
      { id: 'gray', color: lin([0.736647, 0.736647, 0.736647]), metalness: 0, roughness: 0.55 }, // status LEDs
      { id: 'lilac', color: lin([0.736647, 0.736647, 0.929502]), metalness: 0, roughness: 0.55 }, // the window
    ],
  },
  lamps: ['led'],
  params: {
    maxRange: { type: 'number', default: 4, min: 0.1, max: 10, step: 0.05, label: 'Max range (m)', desc: 'How far down the beam a target is still measured. The beam is cast along local +Z, so aim the sensor by rotating it.' },
    showBeam: { type: 'boolean', default: true, label: 'Show beam', desc: 'Draw the beam line in the viewport. A viewing aid only - hiding it does not change what the sensor measures.' },
    distanceTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Distance tag', unit: 'm', group: 'Comms', desc: 'Where the measured distance to the target is published, in metres. With nothing in range it reads the max range rather than 0, so compare against that to detect an empty beam.' },
  },
  // The lens and the LED; the housing is geometry()'s.
  rig() {
    return {
      links: [
        { name: 'lens', shape: { kind: 'frame' }, offset: [0, EMIT_Y, FRONT_Z], beam: { range: MAX_RANGE, rangeParam: 'maxRange', showParam: 'showBeam' } },
        { name: 'led', shape: { kind: 'box', size: [0.014, 0.008, 0.012] }, offset: LED_POS, lamps: [{ emissive: RED }] },
      ],
      joints: [],
      bounds: { length: r8(2 * (LASER.halfX + LASER.panel)), width: r8(LASER.front - LASER.back), top: LASER.height },
    }
  },
  // The housing, drawn: a body with two mounting holes and a label panel on each flank, a dark front cap with
  // the window and four screws, a top panel with a display and two status LEDs, and an M12 plug underneath.
  // Part-local metres, front (+Z) = the beam. Materials: amber (body), dark (front cap, side and top panels),
  // black (plug, screws), orange (display), gray (status LEDs), lilac (window).
  geometry(g) {
    const X = LASER.halfX, PANEL = LASER.panel, BACK = LASER.back, CAPZ = LASER.capZ, FRONT = LASER.front, Y0 = LASER.bodyY0, Y1 = LASER.bodyY1
    const YC = (Y0 + Y1) / 2
    // the body: a block with two mounting holes through it near the back; its front edge butts the cap square
    const body = g.extrude([[Y0, BACK], [Y0, CAPZ], [Y1, CAPZ], [Y1, BACK]], -X, X, {
      axis: 'x', bevel: 0.002, square: [1],
      holes: [circle(Y0 + 0.02, BACK + 0.0155, 0.0033), circle(Y1 - 0.02, BACK + 0.0155, 0.0033)],
    })
    // the dark front cap, the window in it, and a screw in each corner
    const cap = g.bevelBox([2 * X, Y1 - Y0, FRONT - 0.002 - CAPZ], [0, YC, (CAPZ + FRONT - 0.002) / 2], 0.002, ['z-'])
    const win = g.extrude(rrect(-0.04, YC - 0.04, 0.04, YC + 0.04, 0.002), FRONT - 0.002, FRONT, { bevel: 0.0005 })
    const screws = []
    for (const sx of [-1, 1]) for (const sy of [-1, 1])
      screws.push(g.lathe([[0, 0], [0.0045, 0], [0.0045, 0.0006], [0.003, 0.0012], [0, 0.0012]], { axis: 'z', center: [sx * 0.0495, YC + sy * 0.0495, FRONT - 0.002], segments: 12 }))
    // a label panel on each flank, between the cap and the mounting holes
    const panels = [-1, 1].map((s) => g.extrude(rrect(Y0 + 0.012, BACK + 0.03, Y1 - 0.012, CAPZ - 0.008, 0.004), s * X, s * (X + PANEL), { axis: 'x' }))
    // the top: a dark panel carrying the display and two status LEDs
    const top = g.extrude(rrect(-0.044, BACK + 0.01, 0.044, CAPZ - 0.008, 0.004), Y1, Y1 + 0.001, { axis: 'y', bevel: 0.0003 })
    const display = g.extrude(rrect(-0.034, -0.012, 0.034, 0.022, 0.003), Y1 + 0.001, Y1 + 0.0016, { axis: 'y' })
    const leds = [-1, 1].map((s) => g.lathe([[0, 0], [0.004, 0], [0.004, 0.0008], [0, 0.0012]], { axis: 'y', center: [s * 0.013, Y1 + 0.001, -0.038], segments: 16 }))
    // the M12 plug under the body: a turned body and a hex coupling nut
    const PZ = -0.01
    const plug = g.lathe([[0, 0], [0.0078, 0], [0.0085, 0.0008], [0.0085, 0.01], [0.009, 0.02], [0.009, Y0], [0, Y0]], { axis: 'y', center: [0, 0, PZ], segments: 24 })
    const nut = g.lathe([[0, 0.01], [0.0115, 0.01], [0.0115, 0.021], [0, 0.021]], { axis: 'y', center: [0, 0, PZ], segments: 6, smooth: false })
    const both = { doubleSided: true }
    return [
      Object.assign({ desc: body, material: 'amber' }, both),
      Object.assign({ desc: g.merge(cap, top, ...panels), material: 'dark' }, both),
      Object.assign({ desc: win, material: 'lilac' }, both),
      Object.assign({ desc: g.merge(plug, nut, ...screws), material: 'black' }, both),
      Object.assign({ desc: display, material: 'orange' }, both),
      Object.assign({ desc: g.merge(...leds), material: 'gray' }, both),
    ]
  },
  react(ctx) {
    const s = ctx.sense('lens')
    const inRange = s.hit && s.distance <= ctx.params.maxRange
    const dist = inRange ? s.distance : ctx.params.maxRange
    ctx.lamps.led = inRange
    if (ctx.params.distanceTag) ctx.writeNumber(ctx.params.distanceTag, dist)
  },
})
