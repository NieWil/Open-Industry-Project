// Blade Stop — a pop-up blade that rises through the belt to stop cargo. The blade sections (middle +
// corners) ride a prismatic 'raise' joint; the housing and the pneumatic cylinders stay static, so the corner
// guide rods sit sheathed inside the cylinders and slide up through them on raise. 'airPressureHeight' is the
// mount height of the whole moving assembly above the housing, so the blade rest top sits at
// airPressureHeight + HOUSING_TOP (−0.05 at the 0.07 default). 'raiseHeight' is an absolute top height, so
// the joint commands raiseHeight − restTop; its 0.04 default is a real stop's rise. The guide rods are authored
// for a 0.06 raise (0.108 m of travel), and a longer stroke lengthens the rods and cylinders to match (geometry()).
// Driven by an authored 'active' toggle, or by a PLC bool tag while a program drives it.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, without
// `manifest` and `rig()`) and rig.json (the manifest, with the rig compiled from rig()).
//
// The shapes are kept in native units. geometry() scales them by S and maps a native z in two bands: |z| ≤ 1 (the
// middle sections) stretches to ±cornerZ, and beyond that (the corner nodes) keeps its size and slides out with it.

const r8 = (n) => Math.round(n * 1e8) / 1e8 // derived constants at 8 decimals, so 0.07 stays 0.07
const S = 0.45 // native → metres
const NATIVE_TOP = 0.2494 // blade/base top in native units
const NATIVE_BLADE_X = 0.1036 // blade centreline in native units
const LOWERED_TOP = -0.05 // blade-top rest height (below the belt surface)
const HOUSING_TOP = -0.12 // housing top pinned under the surface (clears every roller class)
const RAISE_MAX = 0.5 // raiseHeight's max
// The corner guide rods sink about 0.119 m into the static cylinders when both share the blade's rest frame.
// Their length is authored for a 0.06 raiseHeight (0.108 m of travel from the rest top); a longer raise
// lengthens the rods and cylinders.
const RODS_RAISE = 0.06
const RAISE_DEFAULT = 0.04 // a typical blade stop's rise: 20 mm to 1-7/8 in above the roller top
// Mount height of the whole moving assembly above the housing. The blade rest top = airPressureHeight + HOUSING_TOP.
const AIR_DEFAULT = r8(LOWERED_TOP - HOUSING_TOP)
const X0 = r8(-NATIVE_BLADE_X * S) // shifts the blade centreline to x = 0
const BLADE_Y = r8(LOWERED_TOP - S * NATIVE_TOP) // the blade's native origin at rest, in bladeRoot's frame
const BASE_Y = r8(HOUSING_TOP - S * NATIVE_TOP) // the housing's native origin
// Track-snapping onto a bed fits `width` to the host's usable width; this default is a free-standing drop's,
// the full 1.524 m belt width.
const WIDTH_DEFAULT = 1.524
// cornerZ = width/2 − S·0.2, floored at S·0.01
const CORNER_REACH = r8(S * 0.2)
const CORNER_MIN = r8(S * 0.01)
const ROD_TRAVEL = r8(RODS_RAISE - LOWERED_TOP) // the travel the rods are authored for

const RAISE_SECONDS = 0.15 // travel time lowered↔raised
let raised = null // 0 lowered .. 1 raised; seeded from 'active' on the first step, then chases
let active = false // runtime state — follows the 'active' param and a Use/click (pilot mode)
let lastActive // adopt the Inspector 'active' toggle whenever it changes

definePart({
  interactive: true, // a Use/click raises/lowers the blade
  useParam: 'active', // the hand state is the param: the state a run starts from. The Inspector sets it; Use never writes it
  joints: ['raise'],
  params: {
    width: { type: 'number', default: WIDTH_DEFAULT, min: 0.1, max: 2, step: 0.05, label: 'Width (m)', desc: 'Blade width across the lane. Size it to span the conveying surface, or cargo rides past the end of the blade.' },
    active: { type: 'boolean', default: false, label: 'Active', group: 'Start state', desc: 'Raise the blade to stop cargo. This is the state it starts in; Use cycles it by hand. While a program drives the tag below, that program owns it instead.' },
    raiseHeight: { type: 'number', default: RAISE_DEFAULT, min: 0.02, max: RAISE_MAX, step: 0.01, label: 'Raise height (m)', desc: 'How far the blade top stands above the conveying surface once raised - the height of the stop cargo meets. At rest the top parks just below the surface, so raising this lengthens the stroke.' },
    airPressureHeight: { type: 'number', default: AIR_DEFAULT, min: 0, max: 0.12, step: 0.005, label: 'Air pressure height (m)', desc: 'Mount height of the whole moving assembly - pistons, blade and rods together - above the housing. Trim it to sit the mechanism correctly against a particular deck; it shifts the REST position, not the stroke.' },
    // autoWhenDriven: this tag COMMANDS the blade (the step's auto gate reads it), so a program driving it
    // owns the device — the pilot prompt shows "In auto - PLC controlled" instead of a dead "Use".
    tag: { type: 'tag', dir: 'in', stType: 'BOOL', autoWhenDriven: true, default: '', label: 'Raise tag (true raises the blade)', group: 'Comms', desc: 'Raise the blade from the program. While a program drives this tag it OWNS the blade stop, so a hand Use in pilot mode is refused with "In auto - PLC controlled".' },
  },
  // Everything visible. Shapes are in native units and mapped to metres here: x·S + X0, y·S + the piece's
  // mount, and z by mz() — |z| ≤ 1 is the middle, stretched to ±cornerZ; past 1 is corner hardware, rigid,
  // sliding out with cornerZ. Every box has the model's 0.002 bevel. Housing + cylinders sit on the part root
  // (static); the blade and its hardware ride 'bladeRoot'.
  geometry(g, p) {
    var B = 0.002
    var width = typeof p.width === 'number' ? p.width : WIDTH_DEFAULT
    var apH = typeof p.airPressureHeight === 'number' ? p.airPressureHeight : AIR_DEFAULT
    var cz = Math.max(width / 2 - CORNER_REACH, CORNER_MIN)
    // Cylinders are sized to the stroke. The model's cylinder + guide rods are authored for a ROD_TRAVEL
    // (rest top to raiseHeight); a longer one would pull the rods clean out of the cylinders and leave the blade
    // floating. So the extra travel lengthens the rods and the cylinder body DOWNWARD by the same amount (same
    // sheath at full raise as the default), stopping 1 cm above the housing's floor slab.
    var raise = typeof p.raiseHeight === 'number' ? p.raiseHeight : RAISE_DEFAULT
    var travel = raise - (apH + HOUSING_TOP)
    var room = apH + (0.6124 - 0.3385) * S - 0.01
    var ext = Math.max(0, Math.min(travel - ROD_TRAVEL, room)) / S // native units
    var mz = function (z) { var a = Math.abs(z); return a <= 1 ? z * cz : (z < 0 ? -1 : 1) * (cz + (a - 1) * S) }
    var X = function (x) { return x * S + X0 }
    var D2R = Math.PI / 180
    // a chamfered box from native extents at a mount height (x, y scaled; z through mz: every box ends in the rigid
    // corner region, so its chamfer is B·S all round)
    var box = function (list, yOff, x0, x1, y0, y1, z0, z1, square) {
      var a = [X(x0), y0 * S + yOff, mz(z0)], b = [X(x1), y1 * S + yOff, mz(z1)]
      list.push(g.bevelBox([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], B * S, square))
    }
    // a round rod along y about native (x, z): profile [r, y] in native units, 8 facets, smooth
    var rodY = function (list, yOff, x, z, prof) {
      list.push(g.lathe(prof.map(function (q) { return [q[0] * S, q[1] * S] }), { axis: 'y', center: [X(x), yOff, mz(z)], segments: 8 }))
    }
    // a hex bolt along z at native (x, y): profile [r, z] for the +z side; the −z side is its mirror, walked the
    // other way so the outside stays on the right
    var hexZ = function (list, yOff, x, y, prof, deg, side) {
      var mapped = prof.map(function (q) { return [q[0] * S, mz(side * q[1])] })
      if (side < 0) mapped.reverse()
      list.push(g.lathe(mapped, { axis: 'z', center: [X(x), y * S + yOff, 0], segments: 6, startAngle: deg * D2R, smooth: false }))
    }
    // a 45° flare strip where a panel meets the slab or rail, the full run long, facing away from corner c
    var flare = function (list, yOff, p, q, c) {
      var s = g.surface(), z0 = mz(-1.15), z1 = mz(1.15)
      var P = [X(p[0]), p[1] * S + yOff], Q = [X(q[0]), q[1] * S + yOff], C = [X(c[0]), c[1] * S + yOff]
      var a = s.vertex(P[0], P[1], z0), b = s.vertex(Q[0], Q[1], z0), cc = s.vertex(Q[0], Q[1], z1), d = s.vertex(P[0], P[1], z1)
      // a→b→cc→d faces the right-hand side of P→Q; keep that if it points away from c, else wind it the other way
      var away = (P[0] - C[0]) * (Q[1] - P[1]) - (P[1] - C[1]) * (Q[0] - P[0]) > 0
      if (away) s.quad(a, b, cc, d)
      else s.quad(a, d, cc, b)
      list.push(s.build())
    }

    var steel = [], plate = [], belt = []
    // housing: bottom slab, the core wall (light panel faces both sides), the top rail on the +x side, the black
    // strip on top, and an end plate closing each end; faces meeting a neighbour flush stay square
    box(steel, BASE_Y, 0, 0.4, -0.6606, -0.6124, -1.15, 1.15)
    box(steel, BASE_Y, 0.2682, 0.4, 0.2083, 0.2293, -1.15, 1.15, ['x-', 'y+'])
    box(plate, BASE_Y, 0.2, 0.2662, -0.6124, 0.2293, -1.15, 1.15, ['y-', 'y+'])
    box(belt, BASE_Y, 0.2, 0.4, 0.2293, 0.2494, -1.152, 1.152, ['y-'])
    flare(plate, BASE_Y, [0.2662, -0.6104], [0.2682, -0.6124], [0.2662, -0.6124])
    flare(plate, BASE_Y, [0.2, -0.6104], [0.198, -0.6124], [0.2, -0.6124])
    flare(plate, BASE_Y, [0.2662, 0.2063], [0.2682, 0.2083], [0.2662, 0.2083])
    box(steel, BASE_Y, 0, 0.4, -0.6606, 0.2494, 1.15, 1.2)
    box(steel, BASE_Y, 0, 0.4, -0.6606, 0.2494, -1.2, -1.15)
    // pneumatic cylinders: two black blocks, the round body between them, a cap on top (the bottom block and the
    // body reach down by ext for a long stroke)
    var airY = BASE_Y + apH
    for (var side = -1; side <= 1; side += 2) {
      var zlo = side > 0 ? 1.0463 : -1.1527, zhi = side > 0 ? 1.1527 : -1.0463
      box(belt, airY, 0.0506, 0.1569, -0.1177, -0.0761, zlo, zhi)
      box(belt, airY, 0.0506, 0.1569, -0.3385 - ext, -0.2969 - ext, zlo, zhi)
      rodY(plate, airY, 0.10375, side * 1.0995, [[0, -0.3042 - ext], [0.0431, -0.3042 - ext], [0.0431, -0.1104], [0, -0.1104]])
      rodY(steel, airY, 0.10375, side * 1.09945, [[0, -0.083], [0.02615, -0.083], [0.02615, -0.0652], [0.02405, -0.0632], [0, -0.0632]])
    }

    var bBlade = [], bSteel = [], bPlate = []
    box(bBlade, BLADE_Y, 0.0786, 0.1288, 0, 0.2461, -1.0843, 1.0843)
    for (var sd = -1; sd <= 1; sd += 2) {
      var zl = function (z0, z1) { return sd > 0 ? z0 : -z1 }, zh = function (z0, z1) { return sd > 0 ? z1 : -z0 }
      // the end post the blade is bolted to, and the clamp at its foot
      box(bSteel, BLADE_Y, 0.0786, 0.1288, -0.0437, 0.2462, zl(1.0877, 1.1113), zh(1.0877, 1.1113))
      box(bSteel, BLADE_Y, 0.086, 0.1214, -0.0561, -0.0111, zl(1.0758, 1.1232), zh(1.0758, 1.1232))
      // the guide rod down into the cylinder
      rodY(bPlate, BLADE_Y, 0.10375, sd * 1.09945, [[0, -0.3271 - ext], [0.01445, -0.3271 - ext], [0.01445, -0.0556], [0, -0.0556]])
      // the hex bolt through the clamp, and the two bolt heads on the post's outer face
      hexZ(bPlate, BLADE_Y, 0.10293, -0.03405, [[0, 1.0701], [0.00989, 1.0701], [0.01212, 1.0721], [0.01212, 1.1255], [0.00989, 1.1275], [0, 1.1275]], 49.8, sd)
      hexZ(bPlate, BLADE_Y, 0.10367, 0.21218, [[0, 1.1091], [0.01056, 1.1091], [0.01056, 1.1145], [0.00832, 1.1165], [0, 1.1165]], 10.8, sd)
      hexZ(bPlate, BLADE_Y, 0.10367, 0.02902, [[0, 1.1091], [0.01061, 1.1091], [0.01061, 1.1145], [0.00824, 1.1165], [0, 1.1165]], 32, sd)
    }

    var both = { doubleSided: true }
    var m = function (list) { return g.merge.apply(g, list) }
    return [
      Object.assign({ desc: m(steel), material: 'steel' }, both),
      Object.assign({ desc: m(plate), material: 'plate' }, both),
      Object.assign({ desc: m(belt), material: 'belt' }, both),
      Object.assign({ desc: m(bBlade), material: 'blade', link: 'bladeRoot' }, both),
      Object.assign({ desc: m(bSteel), material: 'steel', link: 'bladeRoot' }, both),
      Object.assign({ desc: m(bPlate), material: 'plate', link: 'bladeRoot' }, both),
    ]
  },
  step(ctx) {
    // Signal handoff: the tag commands the blade only while a controller actually drives it (the tag is an
    // attached program's output, ctx.tagDriven). Any other time the manual signal rules: the
    // 'active' param (adopted when toggled in the Inspector) or a pilot Use/click.
    if (ctx.params.active !== lastActive) { active = ctx.params.active; lastActive = ctx.params.active }
    if (ctx.used()) active = !active
    // auto wins by overwriting the hand latch (bumpless transfer): a press while owned is undone the same
    // tick, and when ownership releases the blade holds its last commanded state.
    if (ctx.tagDriven(ctx.params.tag)) active = ctx.readTag(ctx.params.tag)
    // the hand latch AFTER the auto gate — what the device is really doing, for the Inspector readout
    ctx.report('active', active)
    const want = active ? 1 : 0
    if (raised === null) raised = want
    raised = ctx.approach(raised, want, ctx.dt / RAISE_SECONDS)
    const restTop = ctx.params.airPressureHeight + HOUSING_TOP // −0.05 at the default mount
    ctx.joints.raise = (ctx.params.raiseHeight - restTop) * raised // blade top lands exactly at raiseHeight
  },
})
