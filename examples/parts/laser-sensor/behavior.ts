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

// ---- from examples/parts/_shared/sensorOutlines.js ----
// a rounded-corner rectangle, for windows and panels
function rrect(x0, y0, x1, y1, r) {
  const pts = []
  for (const [cx, cy, a0] of [[x1 - r, y0 + r, -Math.PI / 2], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2], [x0 + r, y0 + r, Math.PI]])
    for (let k = 0; k <= 3; k++) { const a = a0 + (k * Math.PI) / 6; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]) }
  return pts
}

// a 16-sided circle, for mounting holes
function circle(cy, cz, r) {
  const pts = []
  for (let k = 0; k < 16; k++) { const a = (k * Math.PI) / 8; pts.push([cy + r * Math.cos(a), cz + r * Math.sin(a)]) }
  return pts
}

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

definePart({
  lamps: ['led'],
  params: {
    maxRange: { type: 'number', default: 4, min: 0.1, max: 10, step: 0.05, label: 'Max range (m)', desc: 'How far down the beam a target is still measured. The beam is cast along local +Z, so aim the sensor by rotating it.' },
    showBeam: { type: 'boolean', default: true, label: 'Show beam', desc: 'Draw the beam line in the viewport. A viewing aid only - hiding it does not change what the sensor measures.' },
    distanceTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Distance tag', unit: 'm', group: 'Comms', desc: 'Where the measured distance to the target is published, in metres. With nothing in range it reads the max range rather than 0, so compare against that to detect an empty beam.' },
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
