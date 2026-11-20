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

// The `colors` param ('#rrggbb' joined by commas) as sRGB 0..255 triples, the same space ctx.sense().color is in.
// Parsed again only when the param changes.

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

// ---- from examples/parts/_shared/sensorPhotoeye.js ----
const PHOTOEYE = {
  halfX: 0.0225, // 45 mm wide
  back: -0.036,
  front: 0.037, // the lens face: SENSOR_EMIT_Z, the beam origin and the guard contact
  bodyY0: 0.036, // the housing's underside; the M8 plug hangs below it
  bodyY1: 0.15,
  height: 0.16, // SENSOR_HEIGHT: the pot on the top cap reaches it
  emitY: 0.1, // SENSOR_EMIT_Y, inside the lens window
  led: [0, 0.124, 0.034], // the detection LED, on the face above the window
}

// The photoeye's MOUNTING BRACKET, which bolts it to a conveyor's SIDE FRAME - with a guard or without one, and
// touching neither anywhere but where it is bolted.
//
// The guard mount seats the eye with its origin 20 mm below the deck and its lens face 20 mm out from the bed edge,
// over the frame's L-rail (examples/parts/belt-conveyor's rail template; the roller bed's is the same): a WALL whose
// face is 10 mm out from the bed edge, running down from 5 mm under the deck, a 5 mm top LIP reaching out to 30 mm at
// deck height, and - where the bed has one - a GUARD sheet standing on the rail 10..15 mm out (GUARD_THICKNESS).
// Measured outward from the bed edge (u, which is FRONT + 0.02 - z in part-local z), the bracket is:
//   - a SIDE PLATE on the housing's +X flank, bolted through its two holes. Its profile steps round the steel: from
//     the housing down to 3 mm over the lip it stays out past u 23 mm (clear of a guard's 15), past the lip it stays
//     out past the lip's 30 mm tip, and only well under the lip - below the axle heads studding the wall just under
//     it - does it step in to the wall;
//   - a TOE there, square across the beam, flat on the wall face (u 10..13 mm) and bolted to it.
// A floor stand bolts to the toe's face the same way (src/editor/demoScenes.ts EYE_STAND_*), so its numbers are
// transcribed there.
//
// A STOPGAP, and a deliberate copy: the rail's numbers above belong to the conveyor, and are repeated here only
// because a host cannot yet say what steel it offers. Retire this (and EYE_STAND_*) when conveyors publish their
// rail profile on their snap surface and the SDK's bracket helper draws from the seat a mount stores.
const PHOTOEYE_BRACKET = {
  gauge: 0.003, // the sheet
  width: 0.052, // the toe across the beam, from the plate: clear of the lens window by 7.5 mm
  wall: 0.01, // u of the wall's face, which the toe's back lies on
  clearGuard: 0.023, // u the plate keeps out past above the lip (the guard's face 0.015, the lens face 0.02)
  clearLip: 0.033, // ...and past at the lip (its tip 0.03)
  lipY: [0.015, 0.02], // the lip's underside and top, in part-local y (the deck is at 0.02)
  toeTop: -0.025, // where the plate steps in to the toe: clear below the axle heads (part-local y)
  bottom: -0.07, // the toe's foot
  bolts: [-0.06, -0.035], // its two bolts into the wall
  back: 0.046, // u of the plate's back edge, behind the housing's holes (0.031)
}

// The bracket's pieces. Each takes u2z, which maps u (outward from the bed edge) to part-local z on the side the
// piece is drawn on, so a reflector across the bed can draw the same bracket mirrored.

// a hex bolt head along `axis`
function photoeyeHex(g, axis, center) {
  return g.lathe([[0, 0], [0.0065, 0], [0.0065, 0.004], [0, 0.004]], { axis, center, segments: 6, smooth: false })
}

// the side plate in the x plane [x0, x0 + gauge], from yTop down; its face nearest the bed at uIn above the lip
function photoeyeSidePlate(g, x0, yTop, uIn, u2z) {
  const B = PHOTOEYE_BRACKET
  return g.extrude([
    [yTop, uIn], [yTop, B.back], [B.bottom, B.back], [B.bottom, B.wall + B.gauge], [B.toeTop, B.wall + B.gauge], [B.toeTop, B.clearLip],
    [B.lipY[1] + 0.003, B.clearLip], [B.lipY[1] + 0.003, uIn],
  ].map(([y, u]) => [y, u2z(u)]), x0, x0 + B.gauge, { axis: 'x' })
}

// the toe across [x0, x0 + width], its back on the wall
function photoeyeToe(g, x0, u2z) {
  const B = PHOTOEYE_BRACKET
  return g.box([B.width, B.toeTop - B.bottom, B.gauge], [x0 + B.width / 2, (B.bottom + B.toeTop) / 2, (u2z(B.wall) + u2z(B.wall + B.gauge)) / 2])
}

// the toe's two bolts into the wall, at x
function photoeyeToeBolts(g, x, u2z) {
  const B = PHOTOEYE_BRACKET
  return B.bolts.map((y) => g.lathe([[0, 0], [0.0065, 0], [0.0065, 0.004], [0, 0.004]], {
    axis: 'z', center: [x, y, Math.min(u2z(B.wall + B.gauge), u2z(B.wall + B.gauge + 0.004))], segments: 6, smooth: false,
  }))
}

// The housing and its bracket, as geometry() returns them. Materials: body, black (plug, cap), lens (window),
// pot, steel (the bracket).
function photoeyeHousing(g) {
  const X = PHOTOEYE.halfX, BACK = PHOTOEYE.back, FRONT = PHOTOEYE.front, Y0 = PHOTOEYE.bodyY0, Y1 = PHOTOEYE.bodyY1
  const CH = 0.024 // the chamfer across the lower back corner
  // the housing: its side profile (y, z) run across the width, with two mounting holes through it
  const body = g.extrude(
    [[Y0, BACK + CH], [Y0, FRONT], [Y1, FRONT], [Y1, BACK], [Y0 + CH, BACK]],
    -X, X,
    { axis: 'x', bevel: 0.0015, holes: [circle(Y0 + 0.012, FRONT - 0.011, 0.0042), circle(Y1 - 0.012, FRONT - 0.011, 0.0042)] },
  )
  // the lens window on the face, the beam height inside it
  const lens = g.extrude(rrect(-0.017, 0.062, 0.017, 0.114, 0.004), FRONT, FRONT + 0.0008, { bevel: 0.0003 })
  // the top cap, stopping short of the face, and the sensitivity pot in it
  const cap = g.bevelBox([2 * X, 0.005, FRONT - 0.004 - BACK], [0, Y1 + 0.0025, (BACK + FRONT - 0.004) / 2], 0.001, ['y-'])
  const pot = g.lathe([[0, 0], [0.0055, 0], [0.0055, 0.0038], [0.0047, 0.0045], [0, 0.0045]], { axis: 'y', center: [0, Y1 + 0.005, -0.012], segments: 20 })
  const slot = g.box([0.008, 0.0008, 0.0012], [0, Y1 + 0.0096, -0.012])
  // the M8 plug under the housing: a turned body and a hex coupling nut
  const PZ = (BACK + CH + FRONT) / 2
  const plug = g.lathe([[0, 0], [0.0048, 0], [0.0052, 0.0005], [0.0052, 0.009], [0.0056, 0.009], [0.0056, 0.019], [0.0068, 0.022], [0.0068, Y0], [0, Y0]], { axis: 'y', center: [0, 0, PZ], segments: 20 })
  const nut = g.lathe([[0, 0.009], [0.0072, 0.009], [0.0072, 0.018], [0, 0.018]], { axis: 'y', center: [0, 0, PZ], segments: 6, smooth: false })
  // the bracket (PHOTOEYE_BRACKET): a side plate profiled round the rail's guard and lip, a toe bolted to its wall,
  // and a hex bolt head through each of the housing's holes
  const BT = PHOTOEYE_BRACKET.gauge, BW = PHOTOEYE_BRACKET.width
  const U2Z = (u) => FRONT + 0.02 - u // this side: z falls as u grows
  const HZ = FRONT - 0.011 // the housing's holes
  const bracket = g.merge(
    photoeyeSidePlate(g, X, Y1 - 0.002, PHOTOEYE_BRACKET.clearGuard, U2Z), photoeyeToe(g, X, U2Z), ...photoeyeToeBolts(g, X + BW * 0.62, U2Z),
    photoeyeHex(g, 'x', [X + BT, Y0 + 0.012, HZ]), photoeyeHex(g, 'x', [X + BT, Y1 - 0.012, HZ]),
  )
  const both = { doubleSided: true }
  return [
    Object.assign({ desc: body, material: 'body' }, both),
    Object.assign({ desc: lens, material: 'lens' }, both),
    Object.assign({ desc: g.merge(cap, slot, plug, nut), material: 'black' }, both),
    Object.assign({ desc: pot, material: 'pot' }, both),
    Object.assign({ desc: bracket, material: 'steel' }, both),
  ]
}

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
  lamps: ['led'],
  params: {
    maxRange: { type: 'number', default: 2, min: 0.1, max: 10, step: 0.05, label: 'Max range (m)', desc: 'How far down the beam a target is still read. The beam is cast along local +Z, so aim the sensor by rotating it.' },
    showBeam: { type: 'boolean', default: true, label: 'Show beam', desc: 'Draw the beam line in the viewport. A viewing aid only - hiding it does not change what the sensor reads.' },
    colors: { type: 'color', list: true, default: '#ff0000,#00ff00,#0000ff', label: 'Colors', desc: 'The colours this sensor tells apart. The colour code is the position in this list: 1 for the first, 2 for the second, and so on.' },
    tolerance: { type: 'number', default: 80, min: 0, max: 255, step: 1, label: 'Match tolerance', desc: 'How far a tint may be from a listed colour and still match, in steps of 0 to 255 on each of red, green and blue. 0 matches only the exact colour. When two listed colours are within range, the closer one wins.' },
    colorTag: { type: 'tag', values: [{ value: 0, label: 'none' }], dir: 'out', stType: 'INT', default: '', label: 'Color code tag', group: 'Comms', desc: 'Where the detected colour code is published: the position of the matched colour in Colors (1 = the first), or 0. It reads 0 both when nothing is in range and when no listed colour matches, so pair it with a presence sensor if the difference matters.' },
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
