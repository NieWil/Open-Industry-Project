// Turntable Conveyor — a rotating redirect table: rotate → align → convey. The deck is a kinematic disc on
// the 'rotate' revolute joint; the hidden `conveys` lane box on top of it is the cargo surface. While slewing,
// the lane's linear velocity is held at 0 and cargo is spun with the platter instead: an arc surface-velocity
// field about the pivot, the same rotational field the deck imparts by friction. Once settled, the lane
// conveys at `speed` along the deck's current forward — the conveys body is static and its surface velocity
// world-space, so the direction is recomputed from the deck angle every tick. By default the deck slews to the
// manual `deckAngleDeg` and holds there — an angled cross-feed you orient from the Inspector, not a
// self-runner. With an angle tag named, a PLC commands the target angle instead. Its enable tag is the safety
// stop: dropped mid-turn, the deck brakes to a standstill in SAFE_STOP_S still gripping its load, and finishes the
// turn when the tag comes back. A turn not yet begun waits for it.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

// ---- from examples/parts/_shared/rollerBed.js ----
/** the drive-band urethane (a warm amber, matte) as a package material: linear RGB of #d9772b */

// The roller's profile, [radius, z] from the axle out to the tube, in the template's native units (radius 0.12):
// the hub face, the chamfered bearing housing, the rim, and the tube.
const ROLLER_PROFILE = [[0, 0.938], [0.0689, 0.938], [0.0718, 0.9362], [0.0787, 0.9199], [0.1072, 0.9199], [0.1072, 0.9351], [0.1092, 0.9371], [0.118, 0.9371], [0.12, 0.9351]]
const ROLLER_TEMPLATE_R = 0.12, ROLLER_TEMPLATE_BODY = 2 * 0.9371 // tube radius, and the rim-to-rim length a body is fitted by
// a roller shorter than this is a sliver at a clipped corner: dropped rather than drawn
const ROLLER_SLIVER = 0.02
// Drive-band proportions as fractions of the ROLLER RADIUS, so every roller class keeps one look: on a 24 mm roller a
// 4.8 mm cord (the common 3/16" round band) in grooves 20 and 38 mm in from the bed edge.
const BAND_CORD_PER_R = 1 / 5, BAND_INSET_PER_R = 5 / 6, BAND_SPACING_PER_R = 3 / 4

// the tube: the profile walked from the -Z hub to the +Z hub, turned about Z. Axle = local Z, centred.
function rollerTemplate(g) {
  var walk = []
  for (var i = 0; i < ROLLER_PROFILE.length; i++) walk.push([ROLLER_PROFILE[i][0], -ROLLER_PROFILE[i][1]])
  for (var k = ROLLER_PROFILE.length - 1; k >= 0; k--) walk.push([ROLLER_PROFILE[k][0], ROLLER_PROFILE[k][1]])
  return g.lathe(walk, { axis: 'z', segments: 18, startAngle: Math.PI / 18 })
}
// an axle stub: a capped unit cylinder along Z, centred
function stubTemplate(g) {
  return g.lathe([[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]], { axis: 'z', segments: 16 })
}
// a drive band's half-ring: a torus of loop radius lr and cord radius t over the -X half of the XY plane (the side of
// a roller facing AWAY from the neighbour the band runs to). Axle = local Z.
function bandArcTemplate(g, lr, t) {
  var s = g.surface(), T = 10, N = 6, rows = []
  for (var i = 0; i <= T; i++) {
    var u = Math.PI * i / T, row = []
    for (var j = 0; j < N; j++) {
      var v = 2 * Math.PI * j / N, rr = lr + t * Math.cos(v)
      row.push(s.vertex(-rr * Math.sin(u), rr * Math.cos(u), t * Math.sin(v)))
    }
    rows.push(row)
  }
  for (var a = 0; a < T; a++) for (var b = 0; b < N; b++) s.quad(rows[a][b], rows[a + 1][b], rows[a + 1][(b + 1) % N], rows[a][(b + 1) % N])
  return s.build()
}
// a band's straight run: an open unit cylinder along X (its ends bury in the half-rings)
function bandStrandTemplate(g) {
  return g.lathe([[1, -0.5], [1, 0.5]], { axis: 'x', segments: 6 })
}
function yawQuat(yaw) { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] }

// Where the bands go, from the rollers in bed order ({x, z, yaw, length}). A groove sits on the line
// z = side * (zWall - inset) (or one spacing further in); pair k uses the first groove when k is even, the second when
// odd, as a two-groove roller does. The band runs in the plane across the axles, so its far end is the near groove
// point projected onto the next roller's axle. A pair is skipped when a groove point falls off its (clipped) roller,
// when the two rollers aren't parallel, or when the gap is a dropped roller wide (over 1.5x the tightest pair).
function layoutRollerBands(rollers, bands, fullAxle, radius) {
  var side = bands.side || 1
  var zWall = typeof bands.zWall === 'number' ? bands.zWall : fullAxle / 2
  var cord = typeof bands.cord === 'number' ? bands.cord : radius * BAND_CORD_PER_R
  var inset = typeof bands.inset === 'number' ? bands.inset : radius * BAND_INSET_PER_R
  var spacing = typeof bands.spacing === 'number' ? bands.spacing : radius * BAND_SPACING_PER_R
  var grooves = [side * (zWall - inset), side * (zWall - inset - spacing)]
  var out = [], minSpan = Infinity
  for (var k = 0; k + 1 < rollers.length; k++) {
    var a = rollers[k], b = rollers[k + 1]
    if (Math.abs(a.yaw - b.yaw) > 1e-4) continue
    var sin = Math.sin(a.yaw), cos = Math.cos(a.yaw)
    if (Math.abs(cos) < 1e-3) continue // an axle along the flow has no wall to measure a groove from
    var zg = grooves[k % 2]
    var ta = (zg - a.z) / cos
    if (Math.abs(ta) > a.length / 2 - cord) continue
    var px = a.x + ta * sin, pz = zg
    var d = (b.x - px) * cos - (b.z - pz) * sin // across to b's axle, along the axle normal (cos, -sin)
    if (Math.abs(d) < 1e-4) continue
    var qx = px + d * cos, qz = pz - d * sin
    var tb = (qx - b.x) * sin + (qz - b.z) * cos
    if (Math.abs(tb) > b.length / 2 - cord) continue
    minSpan = Math.min(minSpan, Math.abs(d))
    out.push({ px: px, pz: pz, qx: qx, qz: qz, span: Math.abs(d) })
  }
  return { cord: cord, bands: out.filter(function (b) { return b.span <= minSpan * 1.5 }) }
}

// A roller bed as MeshParts: the tubes (spinning), their axle stubs (spinning with them) and, on a powered bed, the
// drive bands (static - an even band looks the same moving or still, and a static bank merges across every bed).
//   rollers  [{x, z, yaw, length}] in bed order: part-local centre, yaw about +Y (axle = local +Z yawed), body length
//   o.radius the tube radius, which also sets the no-slip spin rate (speed / radius)
//   o.y      the axle height in the frame the parts are drawn in
//   o.link   the rig link to hang them on (optional)
//   o.stub   { radius, length, protrude }: two shafts per roller, centred protrude past each (clipped) end
//   o.bands  a band spec ({ zWall, inset, spacing, cord, side }, all optional) - omit for an unpowered bed
//   o.fullAxle the unclipped axle length the bands measure the bed edge from (default the first roller's length)
//   o.dropSlivers  skip rollers of length <= ROLLER_SLIVER
//   o.bandMaterial the package material id the bands are drawn in (default 'band')
//   o.speed  the reported value (ctx.report) that turns the rollers, m/s at the tube surface (default 'speed')
// A positive speed turns the tubes the way that carries cargo toward +X on a bed whose axles run along Z: about -Z.
function rollerBed(g, rollers, o) {
  var R = o.radius, y = o.y || 0
  var sxy = R / ROLLER_TEMPLATE_R
  var spin = { axis: [0, 0, -1], radius: R }
  if (o.speed) spin.speed = o.speed
  var bodies = [], stubs = [], drawn = []
  for (var i = 0; i < rollers.length; i++) {
    var r = rollers[i]
    if (o.dropSlivers && r.length <= ROLLER_SLIVER) continue
    drawn.push(r)
    var q = yawQuat(r.yaw)
    bodies.push({ position: [r.x, y, r.z], quaternion: q, scale: [sxy, sxy, Math.max(0.01, r.length) / ROLLER_TEMPLATE_BODY] })
    if (o.stub) {
      var ax = Math.sin(r.yaw), az = Math.cos(r.yaw), so = r.length / 2 + o.stub.protrude
      var ss = [o.stub.radius, o.stub.radius, o.stub.length]
      stubs.push({ position: [r.x + ax * so, y, r.z + az * so], quaternion: q, scale: ss })
      stubs.push({ position: [r.x - ax * so, y, r.z - az * so], quaternion: q, scale: ss })
    }
  }
  var out = [{ desc: rollerTemplate(g), finish: 'roller', instances: bodies, spin: spin }]
  if (o.stub) out.push({ desc: stubTemplate(g), finish: 'roller', instances: stubs, spin: spin, castShadow: false })
  if (o.bands) {
    var full = typeof o.fullAxle === 'number' ? o.fullAxle : (rollers.length ? rollers[0].length : 0)
    var laid = layoutRollerBands(drawn, o.bands, full, R)
    var cord = laid.cord, lr = R + cord * 0.4 // seated on the tube: the cord's inner edge just under the facet flats
    var arcs = [], strands = []
    for (var b = 0; b < laid.bands.length; b++) {
      var bd = laid.bands[b]
      var yaw = Math.atan2(-(bd.qz - bd.pz), bd.qx - bd.px) // band frame: local X toward q, local Z the axle
      arcs.push({ position: [bd.qx, y, bd.qz], quaternion: yawQuat(yaw + Math.PI) })
      arcs.push({ position: [bd.px, y, bd.pz], quaternion: yawQuat(yaw) })
      var mx = (bd.px + bd.qx) / 2, mz = (bd.pz + bd.qz) / 2, sc = [bd.span, cord / 2, cord / 2]
      strands.push({ position: [mx, y + lr, mz], quaternion: yawQuat(yaw), scale: sc })
      strands.push({ position: [mx, y - lr, mz], quaternion: yawQuat(yaw), scale: sc })
    }
    // finish 'mesh' says plainly what they are: a finish-less submesh of a CONVEYING function part is read as its belt
    // fabric, which would draw the bands in the belt weave
    var bm = o.bandMaterial || 'band'
    out.push({ desc: bandArcTemplate(g, lr, cord / 2), finish: 'mesh', material: bm, instances: arcs, castShadow: false })
    out.push({ desc: bandStrandTemplate(g), finish: 'mesh', material: bm, instances: strands, castShadow: false })
  }
  if (o.link) for (var m = 0; m < out.length; m++) out[m].link = o.link
  return out
}

// ---- from examples/parts/_shared/conveyorUnits.js ----
/** metres per second in one foot per minute */
const FPM_MS = 0.00508

/** `{ group }` to spread into a param, or nothing when there is no group */
const paramGroup = (group) => (group ? { group } : {})

/** Spread into the part's own m/s `speed` and `speedTag` params: shown only while the PLC speaks metres per second. */
const METRIC_ONLY = { visibleWhen: { param: 'fpmUnits', is: false } }

/** Params to stand BEFORE the part's own `speed`: the unit switch, and the speed in the other unit. */
function speedUnitParams(speedMs) {
  return {
    fpmUnits: { type: 'boolean', default: true, whenAbsent: false, imperialUnits: true, label: 'PLC speed in FPM', desc: 'The unit the PLC commands this conveyor in. On: feet per minute. Off: metres per second. The speed tag is a REAL either way, so switching changes what its value means and never how the program declares it. Set by the scene Units (Scene Properties), which switch every conveyor together, so the Inspector does not show it. A conveyor saved before this switch existed is in metres per second.' },
    speedFpm: { type: 'number', default: Math.round(speedMs / FPM_MS), min: -600, max: 600, step: 1, unit: 'FPM', label: 'Speed', visibleWhen: { param: 'fpmUnits', is: true }, desc: 'Surface speed in feet per minute. Negative runs it backwards. A program can command this through the FPM speed tag below.' },
  }
}

/** The param to stand right AFTER the part's own `speedTag`: the same setpoint, in FPM. */
function speedFpmTagParam(group) {
  return {
    speedFpmTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speedFpm', default: '', label: 'Speed tag', ...paramGroup(group), visibleWhen: { param: 'fpmUnits', is: true }, desc: 'The program commands surface speed here in feet per minute, replacing the Speed field above, which then shows the live value read-only. Once BOUND this takes over even if no program writes it, so an unwritten tag holds the conveyor at 0.' },
  }
}

/** In step(): the Inspector readout of whichever speed field is in use. `v` is the effective m/s. */
function reportSpeed(ctx, fpm, v) {
  if (fpm) ctx.report('speedFpm', Math.round(v / FPM_MS)); else ctx.report('speed', v)
}

const PLATE = 1.5 // TURNTABLE_PLATE_FACTOR - disc diameter = width * PLATE
const HEAVY = { radius: 0.04, pitch: 0.13 } // ROLLER_CLASSES.heavy

const D2R = Math.PI / 180

// wrap a degree angle/delta into (−180, 180] — the shortest-path wrap convention
const wrap180 = (a) => { let r = a % 360; if (r > 180) r -= 360; else if (r <= -180) r += 360; return r }

let angle = 0      // current deck angle (deg), kept wrapped in (−180, 180]
let seeded = false
// THE PLATTER CARRIES ITS LOAD — carry phase: 0 idle · 1 arming · 2 carrying · 3 arrived (still held).
// A real turntable holds its load in static contact: the acceleration it demands is an order of magnitude
// under the friction limit, so nothing slips, and the load reaches the outfeed at exactly the deck angle
// (which is the whole reason the machine exists — a few degrees out jams a wrapper or a truck pattern).
// Dragging cargo with the arc surface-velocity field cannot promise that: the field commands a RATE, so any
// slip is integrated into the final ANGLE and is never corrected. Measured before this: the same pallet came
// off 0.7° out one cycle and 4° the next, and on a bare plate it sometimes stopped tracking altogether while
// the deck spun under it. So the deck GRIPS what stands on it for the duration of the turn.
// The two extra phases exist for the two ENDS of the turn, each worth a step of skew if fumbled:
//   1 arming  — the grip closes while the deck stands STILL, so the host captures the load at the angle the
//               deck is actually at; closing and turning in the same tick bakes in one step of rotation.
//   3 arrived — the deck has landed and stays held for that tick, so its final pose is driven onto the load
//               before the release (a release tick drives nothing, it just lets go).
let carry = 0
// Drive RAMP. No real turntable steps to full speed in one tick — a VFD is given an acceleration time (this
// is literally a drive parameter), and the deck eases up to speed and back down onto the index. RAMP_S is
// that acceleration time: seconds from standstill to the commanded top speed, so the acceleration itself
// scales with whatever speed the author sets. `rate` is the current angular rate in °/s, ramped toward the
// commanded top speed and braked in time to land on the target without overshoot (a trapezoidal profile).
const RAMP_S = 0.5
// seconds from the top rate to a standstill on a dropped enable: under 3 degrees at the default 20 deg/s
const SAFE_STOP_S = 0.3
let rate = 0

definePart({
  joints: ['rotate'],
  grippers: ['deck'],
  params: {
    width: { type: 'number', default: 1.524, min: 0.3, step: 0.05, label: 'Lane width (m)', group: 'Size', desc: 'Width of the conveying lane across the deck. Size it to the conveyors it indexes between, since the lane is what actually carries product once the deck has settled.' },
    // deck height above the floor — drives the leg length. rest:'surfaceBelow' lets the host auto-fill it from
    // the surface beneath at drop/snap/translate, so raising the turntable regrows the legs to reach.
    standHeight: { type: 'number', default: 0.95, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the turntable, so raising it regrows the legs to reach.' },
    ...speedUnitParams(1),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 1, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'How fast the lane conveys once the deck has SETTLED at its target angle. While the deck is still slewing the lane carries nothing forward - product just rides round with the platter - so this only applies between moves. Negative runs the lane backwards.' },
    deckAngleDeg: { type: 'number', default: 0, min: -180, max: 180, step: 15, label: 'Deck angle (°)', desc: 'Target angle for the deck, which then slews to it and holds. This is the whole control surface with no tags named: an angled cross-feed you aim from the Inspector rather than a self-runner. A program commands it through the angle tag below instead.' },
    // TOP speed, reached through the ramp below. 20°/s is a 90° index in ~5 s including both ramps, which is
    // where real units sit (3-6 s); the old 45°/s default was about double industry practice, and combined
    // with an instant start it demanded more of the deck than any real drive delivers.
    rotationSpeedDeg: { type: 'number', unit: '°/s', default: 20, min: 1, max: 360, step: 5, label: 'Rotation speed', desc: 'TOP slew rate, reached through a fixed acceleration ramp rather than instantly. The default indexes 90 degrees in about 5 seconds including both ramps, which is where real units sit - winding it much higher asks more of the deck than a real drive delivers, and product slides.' },
    angleTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'deckAngleDeg', default: '', label: 'Target angle tag', group: 'Comms', desc: 'The program commands the deck angle here, replacing the Deck angle field above. On the first scan the part SEEDS the tag with the authored angle, so a program that has not written yet does not slam the deck to zero.' },
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands lane speed here, replacing the Speed field above. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0.' },
    ...speedFpmTagParam('Comms'),
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag (true once settled)', group: 'Comms', desc: 'Handshake back to the program: true once the deck has stopped at its target angle. Wait on this before commanding the lane to run, or product is pushed at a deck still turning under it.' },
    enableTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Enable tag', group: 'Comms', desc: 'The deck turns only while this is true. Drop it mid-turn and the deck brakes to a stop where it is, still holding its load; raise it and the turn finishes. Lane speed is not affected: command that through the speed tag. Until a program drives it, or with it empty, the deck is always enabled, so a merely-typed tag does not hold it.' },
  },
  // The round roller bed, drawn on the deck's 'roller' frame so it turns with the platter: rollers fanned across
  // the full plate diameter at the heavy pitch, each clipped to the plate circle (long across the lane, tapering
  // to the round rim), L end brackets on the tapered outer rollers the side rails don't reach, and a hex-bolt ring
  // rimming the plate. The rollers turn at the lane's conveying speed ('rollerSpeed', reported by step()).
  geometry(g, p) {
    var width = typeof p.width === 'number' && p.width > 0 ? p.width : 1.524
    var R = HEAVY.radius, PITCH = HEAVY.pitch
    var RIM = 0.06 //           rollers clip this far in from the plate rim
    var BRACKET = 0.06 //       length of one roller end-holder along the lane
    var WALL = 0.01 //          side-frame wall thickness
    var deckR = (width * PLATE) / 2, laneHalf = width / 2
    var rBed = Math.max(deckR - RIM, 0)
    var kMax = Math.floor(rBed / PITCH)
    var rollers = [], tapered = []
    for (var k = -kMax; k <= kMax; k++) {
      var s = k * PITCH
      var half = Math.min(laneHalf, Math.sqrt(Math.max(rBed * rBed - s * s, 0)))
      if (half <= 0.02) continue // a sliver at the very rim
      rollers.push({ x: s, z: 0, yaw: 0, length: half * 2 })
      if (half < laneHalf - 0.01) tapered.push({ s: s, half: half }) // shorter than the lane: past the side rails
    }
    var parts = rollerBed(g, rollers, { radius: R, y: -R, link: 'roller', speed: 'rollerSpeed' })
    // side-frame steel off the roller radius: from just below the plate top up to the frame top
    var plateTopY = -1.8 * R, baseY = plateTopY - 0.01, frameTopY = -0.3 * R
    var railH = Math.max(frameTopY - baseY, 0.02), railCY = baseY + railH / 2
    var boxes = []
    var railLen = 2 * Math.sqrt(Math.max(rBed * rBed - laneHalf * laneHalf, 0))
    if (railLen > 0.05) {
      var zc = laneHalf + WALL / 2
      boxes.push({ position: [0, railCY, zc], scale: [railLen, railH, WALL] }, { position: [0, railCY, -zc], scale: [railLen, railH, WALL] })
    }
    for (var t = 0; t < tapered.length; t++) {
      var z = tapered[t].half + WALL / 2
      boxes.push({ position: [tapered[t].s, railCY, z], scale: [BRACKET, railH, WALL] }, { position: [tapered[t].s, railCY, -z], scale: [BRACKET, railH, WALL] })
    }
    parts.push({ desc: g.box([1, 1, 1], [0, 0, 0]), finish: 'frame', link: 'roller', instances: boxes })
    // the perimeter bolt ring: hex studs seated on the plate rim, each pointing radially outward, one per ~0.25 m
    var count = Math.max(8, Math.round((2 * Math.PI * deckR) / 0.25))
    var boltY = plateTopY - 0.06, rBolt = deckR + 0.005
    var bolts = []
    for (var i = 0; i < count; i++) {
      var a = (2 * Math.PI * i) / count
      bolts.push({ position: [Math.cos(a) * rBolt, boltY, Math.sin(a) * rBolt], quaternion: yawQuat(Math.PI / 2 - a), scale: [0.012, 0.012, 0.01] })
    }
    var hex = g.lathe([[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]], { axis: 'z', segments: 6, startAngle: Math.PI / 2, smooth: false })
    parts.push({ desc: hex, finish: 'bolt', link: 'roller', instances: bolts, castShadow: false })
    return parts
  },
  step(ctx) {
    // Setpoint precedence: the angle tag replaces the authored deckAngleDeg only while a tag is named. An empty
    // name reads 0, so without this check the deck would slew to zero and ignore its authored angle.
    const enabled = !ctx.tagDriven(ctx.params.enableTag) || ctx.readTag(ctx.params.enableTag) === true
    const bound = ctx.params.angleTag
    let target
    if (bound) {
      // seed-write once from the deck's authored angle so the PLC sees a sensible initial target; after that
      // the tag is read-only here (the PLC owns it).
      if (!seeded) ctx.writeNumber(ctx.params.angleTag, ctx.params.deckAngleDeg)
      target = seeded ? ctx.readNumber(ctx.params.angleTag) : ctx.params.deckAngleDeg
    } else {
      target = ctx.params.deckAngleDeg
    }
    seeded = true
    // shortest-path slew: wrap the delta to (−180, 180] so 350° from 0 takes the −10° road
    const topRate = ctx.params.rotationSpeedDeg
    const accel = topRate / RAMP_S // °/s², so the ramp TIME is fixed and the rate scales with the setting
    const d = wrap180(target - angle)
    const pending = Math.abs(d) > 1e-6
    // advance the carry phase (see the note by `carry`), then move only while actually carrying
    if (carry === 3) { carry = 0; rate = 0 }
    else if (carry === 0 && pending && enabled) carry = 1
    else if (carry === 1) carry = 2
    if (carry === 2) {
      // trapezoidal profile: brake once the remaining travel is only just enough to stop in (v²/2a),
      // otherwise keep accelerating toward the top rate. Landing snaps the last sub-step so a decaying
      // rate can't crawl at the target forever. With the enable dropped it brakes hard and holds, still carrying.
      const remaining = Math.abs(d)
      const brakeIn = (rate * rate) / (2 * accel)
      if (!enabled) rate = Math.max(0, rate - (topRate / SAFE_STOP_S) * ctx.dt)
      else rate = remaining <= brakeIn ? Math.max(0, rate - accel * ctx.dt) : Math.min(topRate, rate + accel * ctx.dt)
      const stepNow = rate * ctx.dt
      if (remaining <= stepNow || remaining <= 1e-6) { angle = wrap180(angle + d); carry = 3; rate = 0 }
      else angle = wrap180(angle + Math.sign(d) * stepNow)
    }
    const settled = !pending || carry === 3
    ctx.grips.deck = carry !== 0
    ctx.joints.rotate = angle * D2R // continuous revolute — the wrap keeps the command inside ±π
    // once settled, convey along the deck's current forward — ctx.forward (the part's world +X) rotated by the
    // deck angle; while slewing, spin resting cargo with the platter via the arc field instead
    const fpm = ctx.params.fpmUnits === true
    const setpointTag = fpm ? ctx.params.speedFpmTag : ctx.params.speedTag
    const setpointMs = (setpointTag ? ctx.readNumber(setpointTag) : fpm ? ctx.params.speedFpm : ctx.params.speed) * (fpm ? FPM_MS : 1)
    const speed = setpointMs
    ctx.report('speed', speed) // the lane conveys on 'speed' (m/s) whichever unit the Inspector shows
    reportSpeed(ctx, fpm, speed)
    ctx.report('deckAngleDeg', target)
    ctx.report('rollerSpeed', settled ? speed : 0) // the rollers turn with the lane, not while the deck slews
    if (settled) {
      const c = Math.cos(angle * D2R)
      const s = Math.sin(angle * D2R)
      const f = ctx.forward
      ctx.setSurfaceVelocity({ x: (f.x * c + f.z * s) * speed, y: 0, z: (f.z * c - f.x * s) * speed })
    } else {
      // the RAMPED rate, not the top speed: this field is the fallback for anything the deck grip did not
      // take (cargo that arrived mid-turn), and it should describe what the plate is actually doing
      ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega: Math.sign(d) * rate * D2R })
    }
    if (ctx.params.doneTag) ctx.writeTag(ctx.params.doneTag, settled)
  },
})
