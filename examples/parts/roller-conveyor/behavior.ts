// Roller Conveyor — a powered roller bed. Demonstrates a conveying deck link: the behavior sets the surface
// velocity along the flow axis (+X) and the host carries any cargo on the bed. A negative speed reverses it;
// a PLC run tag can start/stop it. The rollers are decorative (the deck is the surface).
//
// The rig is a conveying deck under a world-phased pitch grid: the rollers are geometry() drawn on the grid's
// stations, render-only, so coplanar roller bodies can't fight the deck for the contact.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

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

// ---- from examples/parts/_shared/conveyorDrive.js ----
/** Params to stand right AFTER the part's own `speed`: the drive's ramp, in seconds from stopped to rated. */
function driveRampParams(accelTime, decelTime) {
  return {
    accelTime: { type: 'number', unit: 's', default: accelTime, min: 0, max: 30, step: 0.1, label: 'Accel time', desc: 'How long the drive takes to bring the conveyor from stopped up to its rated speed (the speed that reads 30, under Comms > Feedback), like the acceleration time set on a VFD. A smaller change takes proportionally less. 0 starts instantly.' },
    decelTime: { type: 'number', unit: 's', default: decelTime, min: 0, max: 30, step: 0.1, label: 'Decel time', desc: 'How long the drive takes to bring the conveyor from rated speed down to a stop. Cargo keeps travelling while it does, so a box stopped at a photo-eye ends up past it. 0 stops instantly.' },
  }
}

/** Params to stand after the part's `runningTag`: the velocity feedback, the pulse and the encoder, in a
 *  `Feedback` section under `group`. */
function driveFeedbackParams(speedMs, group) {
  const fpm = Math.round(speedMs / FPM_MS)
  const g = paramGroup(group ? `${group}/Feedback` : 'Feedback')
  return {
    speedAt30: { type: 'number', default: speedMs, min: 0.01, max: 10, step: 0.01, label: 'Speed that reads 30 (m/s)', ...g, visibleWhen: { param: 'fpmUnits', is: false }, desc: 'The surface speed this conveyor reaches when its drive turns at 30. It scales the velocity tag: running at exactly this speed reads 30.' },
    speedAt30Fpm: { type: 'number', default: fpm, min: 1, max: 2000, step: 1, label: 'Speed that reads 30 (FPM)', ...g, visibleWhen: { param: 'fpmUnits', is: true }, desc: 'The surface speed, in feet per minute, this conveyor reaches when its drive turns at 30. It scales the velocity tag: running at exactly this speed reads 30.' },
    velocityTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Velocity tag (30 at the speed above)', ...g, desc: 'Drive feedback the program reads: the effective speed as a share of the speed at 30 revolutions, times 30. Stopped reads 0, and a run tag holding the conveyor still counts as stopped.' },
    inchesPerPulse: { type: 'number', default: 1, min: 0.05, max: 100, step: 0.05, label: 'Travel per pulse (in)', ...g, desc: 'How far the surface travels between pulses on the pulse tag. A pulse cannot be finer than one simulation step, so a fast conveyor at a fine pitch needs a higher project simHz.' },
    pulseTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Pulse tag (one per pitch)', ...g, desc: 'An encoder for the program to count: TRUE for one simulation step each time the surface has travelled the inches above, in either direction, and FALSE otherwise.' },
    encoderTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Encoder tag (travel)', unit: 'm', ...g, desc: 'Odometer of surface travel in metres, integrated on sim time: it climbs while the conveyor runs forward and counts back while it reverses. Latch it when a photo-eye sees a box, then act once it has advanced a known distance - the standard way to track product without a sensor at every station.' },
  }
}

/** What a conveyor remembers between steps for its ramp, its pulse and its encoder. Make one at the top level. */
function conveyorDrive() {
  return {
    pulseTravel: 0, // surface travel since the last pulse (in)
    odo: 0, // encoder odometer: surface travel (m), signed with the direction of travel
    driven: 0, // what the drive is actually doing (m/s): the command, through the accel/decel ramp
    rampStarted: false, // past the first step, from which every change of command ramps
  }
}

/** In step(): the unit the conveyor is set up in and the commanded speed, `{ fpm, setpointTag, commanded }`.
 *  `commanded` is always m/s, so everything after this call is m/s. */
function commandedSpeed(ctx) {
  const fpm = ctx.params.fpmUnits === true
  const setpointTag = fpm ? ctx.params.speedFpmTag : ctx.params.speedTag
  const unit = fpm ? FPM_MS : 1
  const commanded = (setpointTag ? ctx.readNumber(setpointTag) : fpm ? ctx.params.speedFpm : ctx.params.speed) * unit
  return { fpm, setpointTag, commanded }
}

/** In step(), after commandedSpeed(): the speed the surface actually runs at (m/s), `target` (the command, gates
 *  applied) through the drive's ramp. Away from 0 it accelerates at rated / accelTime; toward 0 it decelerates at
 *  rated / decelTime; a reversal runs down to 0 before it turns round.
 *  THE FIRST STEP: a conveyor whose speed or run gate a program owns starts from rest, because the program is
 *  starting the line; one running on its authored speed is already running at it, since nothing started it. */
function rampedSpeed(ctx, drive, cmd, target) {
  // rates are rated speed over the accel / decel time
  const rated = cmd.fpm ? ctx.params.speedAt30Fpm * FPM_MS : ctx.params.speedAt30
  let want = target
  if (!drive.rampStarted) {
    drive.rampStarted = true
    // no program commands this conveyor: its authored speed is a belt that is running, not one being started
    if (!(cmd.setpointTag || (ctx.params.runTag && ctx.tagDriven(ctx.params.runTag)))) drive.driven = want
  }
  if (want * drive.driven < 0) { if (ctx.params.decelTime > 0) want = 0; else drive.driven = 0 } // reversing: stop first
  const rampTime = Math.abs(want) > Math.abs(drive.driven) ? ctx.params.accelTime : ctx.params.decelTime
  drive.driven = rampTime > 0 && rated > 0 ? ctx.approach(drive.driven, want, (rated / rampTime) * ctx.dt) : want
  return drive.driven
}

/** In step(): the velocity feedback, the pulse and the encoder, from the effective speed `v` (m/s). */
function publishDrive(ctx, drive, cmd, v) {
  // the velocity as a share of the speed at 30
  const at30 = cmd.fpm ? ctx.params.speedAt30Fpm * FPM_MS : ctx.params.speedAt30
  if (ctx.params.velocityTag) ctx.writeNumber(ctx.params.velocityTag, at30 > 0 ? (v / at30) * 30 : 0)
  // the encoder pulse
  const pitch = ctx.params.inchesPerPulse > 0 ? ctx.params.inchesPerPulse : 1
  drive.pulseTravel += (Math.abs(v) * ctx.dt) / 0.0254
  const pulse = drive.pulseTravel >= pitch - 1e-9 // (a hair of tolerance: twelve twelfths of an inch do not sum to exactly one)
  if (pulse) drive.pulseTravel = Math.max(0, drive.pulseTravel - pitch * Math.max(1, Math.floor(drive.pulseTravel / pitch + 1e-9)))
  if (ctx.params.pulseTag) ctx.writeTag(ctx.params.pulseTag, pulse)
  drive.odo += v * ctx.dt
  if (ctx.params.encoderTag) ctx.writeNumber(ctx.params.encoderTag, drive.odo)
}

/** In react(), last: ask for the next tick while the drive has work of its own. It has while it ramps toward
 *  `target` (the command, gates applied, as handed to rampedSpeed), and while it runs with a pulse or an encoder tag
 *  to count travel on. A conveyor at its commanded speed with neither waits for a tag to change, and its surface
 *  keeps the speed it was last given. */
function driveAgain(ctx, drive, target) {
  if (drive.driven !== target || (drive.driven !== 0 && (ctx.params.pulseTag || ctx.params.encoderTag))) ctx.again()
}

// ---- from examples/parts/_shared/conveyorFriction.js ----
/** The `friction` param, with the surface's default grip against a carton. */
function frictionParam(carton) {
  return {
    friction: { type: 'number', default: carton, min: 0, step: 0.01, label: 'Friction', desc: 'Grip between the running surface and a standard carton, the figure a belt datasheet quotes. A smooth PVC belt is about 0.4, a rough-top incline belt about 0.9 and a low-friction plastic modular belt about 0.2, made for product to slide while it accumulates. Bare steel rollers are about 0.4. Other cargo grips by its own friction against the same surface.' },
  }
}

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

// ---- from examples/parts/_shared/rollerFrame.js ----
/** The roller beds' `frameHeight` param: the side frame channel's height (deck-side top 5 mm under the
 *  conveying plane, as on every bed). Same meaning and default as the belt's `height`, whose frame wall is that deep,
 *  so a roller bed set to a belt's Frame height meets its frame flush. A geometry()-tier bed reads its frame bottom
 *  through frameBottom(); a rig bed tracks it with sizeParams / offsetParams / leg frameDepthParam.
 *  Same range as the belt's, so every Frame height has a roller bed that matches it; on a shallow frame the legs'
 *  mounting brackets shorten to stay under the deck (legPieces' frameDepth, _shared/legs.js). */
function frameHeightParam(group) {
  return {
    frameHeight: { type: 'number', default: 0.17, min: 0.1, max: 0.6, step: 0.01, label: 'Frame height (m)', ...(group ? { group } : {}), desc: 'Depth of the side frame channel below the rollers. Set it to the Frame height of the conveyor this bed butts against so the two frames line up at the joint. The legs shorten or lengthen to meet the frame bottom; the deck height does not move.' },
  }
}

/** The frame bottom's y (negative, below the deck) for a geometry()-tier bed.
 *  Rounded to the micrometre exactly as the belt's is, so at the default it is the literal -0.175 the pooled rail
 *  template is shared by value with (0.17 + 0.005 is 0.17500000000000002 in binary). */

var R = 0.024, PITCH = 0.075 // rendered roller radius (the roller template's 0.12 scaled down), roller pitch (the rig's grid spacing)
const STUB_R = R * 0.34 //   thin axle-shaft stubs poking through the frame

const drive = conveyorDrive() // the ramp, the pulse and the encoder, remembered between steps

// Each roller's placement, from the grid the host resolved (ctx.deltas: the world-phased pitch grid shared with
// butted beds). Straight: full-length rollers (yaw 0) at every grid line. Skewed: rotate each about +Y by `skew`,
// lengthen to axle/cos so it spans the bed, and clip to the frame corners. With no grid (a headless call), a
// centred one at the same pitch.
function layoutRollers(deltas, p) {
  var skewRad = (typeof p.skew === 'number' ? p.skew : 0) * Math.PI / 180
  var width = typeof p.width === 'number' ? p.width : 1.524
  var length = typeof p.length === 'number' ? p.length : 4
  var axle = width - 0.004 // the body recessed just behind the frame walls
  if (!deltas || deltas.length === 0) {
    deltas = []
    var n = Math.max(1, Math.floor((length - 2 * R) / PITCH) + 1)
    for (var d = 0; d < n; d++) deltas.push([(d - (n - 1) / 2) * PITCH, 0, 0])
  }
  var out = []
  var sin = Math.sin(skewRad)
  if (Math.abs(sin) < 1e-6) {
    for (var i = 0; i < deltas.length; i++) out.push({ x: deltas[i][0], z: 0, yaw: 0, length: axle })
    return out
  }
  // skewed: the rotated shaft is parameterised by t in [-full/2, full/2]; clip t to BOTH the shaft extent and the
  // frame ends X = +-halfLen (X = dx + t*sin). The visible segment's length + centre offset give the roller.
  var cos = Math.cos(skewRad)
  var full = axle / Math.abs(cos) // width/cos - spans wall-to-wall when rotated
  var halfShaft = full / 2
  var halfLen = length / 2 - R * Math.abs(cos) // effective half-length (inset a roller radius)
  for (var k = 0; k < deltas.length; k++) {
    var dx = deltas[k][0]
    var tPos = (halfLen - dx) / sin, tNeg = (-halfLen - dx) / sin
    var tMin, tMax
    if (sin > 0) { tMax = Math.min(halfShaft, tPos); tMin = Math.max(-halfShaft, tNeg) }
    else { tMax = Math.min(halfShaft, tNeg); tMin = Math.max(-halfShaft, tPos) }
    var clipLen = tMax - tMin
    if (clipLen <= 0.02) continue // a sliver at the very corner - drop it
    var offset = (tMax + tMin) / 2
    out.push({ x: dx + offset * sin, z: offset * cos, yaw: skewRad, length: clipLen })
  }
  return out
}

definePart({
  params: {
    // 'face' handles add viewport resize dots: a ±X dot drives length, ±Z drives width (clamped to the
    // param's min/max); the host reflows the rig live. length has no max — a roller bed can be any length.
    length: { type: 'number', default: 4, min: 0.5, step: 0.1, label: 'Length (m)', handle: { kind: 'face', axis: 'x' }, group: 'Size', desc: 'Bed length along travel. Drag the dot on either end face to resize in the viewport; there is no upper limit, so one bed can stand in for a long run.' },
    width: { type: 'number', default: 1.524, min: 0.2, step: 0.05, label: 'Width (m)', handle: { kind: 'face', axis: 'z' }, group: 'Size', desc: 'Bed width across travel. Drag the dot on either side face to resize in the viewport.' },
    ...frameHeightParam('Size'),
    ...speedUnitParams(1.0),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 1.0, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'Surface speed carried along the bed. Negative runs the rollers backwards, which is the ONLY way to reverse flow - rotating the part 180 degrees moves its ends instead. A program can command this through the speed tag below.' },
    ...driveRampParams(0.2, 0.2),
    ...frictionParam(0.42),
    // skew — angle the rollers for angled product movement: cargo tracks across the bed and squares against
    // a side guard. layoutRollers() rotates the rollers (lengthened to width/cos, clipped to the frame
    // corners) and step() angles the surface velocity to match; the guard collision does the squaring.
    skew: { type: 'number', unit: '°', default: 0, min: -60, max: 60, step: 1, label: 'Roller skew', desc: 'Angle the rollers so cargo drifts sideways as it travels and squares itself against a side guard - the standard way to align product before a merge or a labeller. The surface velocity follows the angle, and the guard does the squaring, so leave the guard on that side up.' },
    // incline — tilt the whole rigid bed about its centre, +X head up. Host-owned via the rig inclineParam
    // marker: geometry + collision tilt as one, the trestle legs regrow to the floor, and the deck's surface
    // velocity gets the tilted tangent — so step() needs no incline math. ±30°: rollers shed product on a
    // steeper grade, unlike belts which hold it.
    tiltDeg: { type: 'number', unit: '°', default: 0, min: -30, max: 30, step: 1, label: 'Incline', desc: 'Tilt the bed about its centre, positive lifting the head. Incline a roller bed this way, not by rotating the part, which tips its snap ends too; the legs regrow to the floor. Capped at 30 degrees: rollers shed product on a steeper grade, where a belt holds it.' },
    // guard toggles — a false showParam removes the wall's render AND its collision body (a real opening,
    // not just hidden), so cargo can be diverted off / loaded on. Left = −Z, right = +Z (belt convention).
    leftGuard: { type: 'boolean', default: true, label: 'Left guard', group: 'Guards', desc: 'Guard wall down the left side, looking along travel. This is a real barrier, so turning it off lets cargo leave the bed sideways.' },
    rightGuard: { type: 'boolean', default: true, label: 'Right guard', group: 'Guards', desc: 'Guard wall down the right side, looking along travel. This is a real barrier, so turning it off lets cargo leave the bed sideways.' },
    // side-guard openings as [start m, end m, side] rows — measured from the TAIL (upstream end), side −1 =
    // left, +1 = right, 0 = both. Same rows, same meaning as the belt conveyor's; press G with the bed
    // selected to drag them in the viewport. Cuts a gap in the guard wall's render AND collision (a sensor,
    // a hand transfer). The rig guard links are what get split, so the host consumes this param rather than
    // geometry() — declaring it is the opt-in (core/guardOpenings.ts addAuthoredOpenings).
    // Neighbour-auto openings (a guard opening itself where another conveyor butts) stay a host concern.
    guardOpenings: { type: 'numberList', columns: ['start m', 'end m', 'side ±1/0'], arity: 3, default: [], label: 'Guard openings', group: 'Guards', desc: 'Gaps cut in the guard wall, measured as distance ALONG the bed from the tail. Side -1 is left, +1 is right, 0 cuts both. Each gap opens the collision as well as the mesh, which is how a transfer or a diverter gets product off the lane. Press G with the bed selected to drag them in the viewport.' },
    // deck height above the floor — drives the leg length. rest:'surfaceBelow' lets the host auto-fill it
    // from the surface beneath at drop/snap, so the legs auto-adjust to reach the floor (or a platform).
    standHeight: { type: 'number', default: 2.0, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the conveyor, so the legs reach the floor - or a platform crossing underneath - without you measuring. Pin it by hand when you want a deliberate height.' },
    // Comms trio: speedTag = REAL setpoint in (replaces the speed param), runningTag = BOOL feedback out
    // (effective speed ≠ 0); runTag = BOOL run/stop gate (back-compat).
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands surface speed here, replacing the Speed field above, which then shows the live value read-only. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0 - so a half-wired conveyor sits still rather than running at its authored speed.' },
    ...speedFpmTagParam('Comms'),
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (rollers run while true)', group: 'Comms', desc: 'Start/stop gate: false forces the speed to 0 whatever the setpoint says. Unlike the speed tag, this only takes effect once a program actually DRIVES it, so binding it alone will not stop the bed.' },
    runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Running tag (true while moving)', group: 'Comms', desc: 'Feedback the conveyor publishes for the program to read: true whenever it is actually moving. This is the EFFECTIVE speed, gates included, so a run tag holding it at zero reads false here.' },
    ...driveFeedbackParams(1.0, 'Comms'),
  },
  // Geometry — the roller bed, and the skew transfer plates: the light-steel corner dead-plates that fill the
  // triangular gaps the angled rollers leave at the head/tail once skewed. Render-only, emitted on the 'roller'
  // rig link so they ride the incline.
  //
  // `ctx` is the host-resolved seam (GeometryContext): the world-phase roller grid this bed landed on, plus
  // which of its ends abut a collinear neighbour. The plate needs it because it REPLACES the rollers the skew
  // clipped away, so at a butt it has to finish where a roller would have. Ending it flush at the bed end
  // leaves up to (pitch - R) of bare deck at the transfer — the neighbour's first roller is on the shared
  // grid, wherever the pair happens to sit in world X — against the ONE roller gap an unskewed bed shows
  // there. See the lip below.
  geometry(g, p, ctx) {
    // the rollers: the kit's bed on the grid's stations (tubes + axle stubs + drive bands), drawn on the 'roller'
    // link at its axle datum (y 0 there). Stubs poke 9.5 mm past each (clipped) end and follow its yaw; the
    // bands chain each roller to the next at the +Z end, alternating two grooves in from the bed edge - the look of
    // a powered (MDR) bed. They turn at the effective speed step() reports.
    var axle = (typeof p.width === 'number' ? p.width : 1.524) - 0.004
    var bed = rollerBed(g, layoutRollers(ctx && ctx.deltas, p), { radius: R, y: 0, link: 'roller', stub: { radius: STUB_R, length: 0.045, protrude: 0.0095 }, bands: {}, fullAxle: axle, dropSlivers: true })
    return bed.concat(skewPlates())

    function skewPlates() {
      var skewRad = (typeof p.skew === 'number' ? p.skew : 0) * Math.PI / 180
      if (Math.abs(skewRad) < 1e-4) return []
      var width = typeof p.width === 'number' ? p.width : 1.524
      var length = typeof p.length === 'number' ? p.length : 4
      if (width <= 0 || length <= 0) return []
      // the 'roller' link group sits R below the deck; lift the plate top to roller-top level + a hair (no z-fight),
      // dropping a 2R skirt so it reads as a solid plate, not a paper-thin sheet.
      var yTop = R + 0.001, yBot = yTop - 2 * R
      var halfW = width / 2, headX = length / 2, tailX = -length / 2
      // X-extent of the triangular gap the angled rollers leave at each end (clamped to the length)
      var skewZone = Math.min(halfW * Math.abs(Math.tan(skewRad)), length)
      var headInset = headX - skewZone, tailInset = tailX + skewZone
      var zSign = skewRad > 0 ? 1 : skewRad < 0 ? -1 : 1 // which diagonal each plate leans along (the union is the same either way)
      var s = g.surface()
      function tri(ax, ay, az, bx, by, bz, cx, cy, cz) { s.triangle(s.vertex(ax, ay, az), s.vertex(bx, by, bz), s.vertex(cx, cy, cz)) }
      // one triangular dead-plate: top face v1-v3-v2 + a skirt down the v1-v3 (diagonal) and v2-v3 (end) edges (the
      // v1-v2 edge sits against the frame wall, no skirt). doubleSided, so winding is cosmetic.
      function plate(x1, z1, x2, z2, x3, z3) {
        tri(x1, yTop, z1, x3, yTop, z3, x2, yTop, z2)
        tri(x1, yTop, z1, x1, yBot, z1, x3, yBot, z3); tri(x3, yBot, z3, x3, yTop, z3, x1, yTop, z1)
        tri(x2, yTop, z2, x2, yBot, z2, x3, yBot, z3); tri(x3, yBot, z3, x3, yTop, z3, x2, yTop, z2)
      }
      plate(headInset, zSign * halfW, headX, zSign * halfW, headX, 0)
      plate(headInset, -zSign * halfW, headX, -zSign * halfW, headX, 0)
      plate(tailInset, -zSign * halfW, tailX, -zSign * halfW, tailX, 0)
      plate(tailInset, zSign * halfW, tailX, zSign * halfW, tailX, 0)
      // TRANSFER LIP — the full-width strip that carries the plate across a butt seam to the neighbour's first
      // roller. Two beds butted end to end share ONE world pitch grid, so that roller sits on the next grid line
      // past this end: lap out to its face (grid line -/+ R) and the transfer is continuous at every phase.
      // Bounded by R, the most a roller of our own would ever poke past the frame, which is also what stops the
      // lip from cutting THROUGH the neighbour's roller when that roller lands right at the seam. Gated on
      // `butt`: at a free end there is nothing to meet, so the plate stays flush with the frame as before.
      // Both fall back to 0 without a ctx (headless / parity call) — the placement-free plate.
      var c = ctx || {}
      var deltas = c.deltas, pitch = typeof c.pitch === 'number' ? c.pitch : 0
      var butt = c.butt || { head: false, tail: false }
      var gridded = !!deltas && deltas.length > 0 && pitch > 0
      // bare deck between our end and the neighbour's first roller face, clamped to [0, R]
      function lapTo(on, edge, line) {
        if (!on || !gridded) return 0
        return Math.max(0, Math.min(R, Math.abs(line - edge) - R))
      }
      var lapHead = lapTo(butt.head, headX, gridded ? deltas[deltas.length - 1][0] + pitch : 0)
      var lapTail = lapTo(butt.tail, tailX, gridded ? deltas[0][0] - pitch : 0)
      // one end lip: the top strip from the bed end out to x2, plus the same 2R skirt the plates carry on its
      // outer edge so it still reads as steel rather than a paper sheet. doubleSided, so winding is cosmetic.
      function lip(x1, x2) {
        if (Math.abs(x2 - x1) < 1e-5) return
        tri(x1, yTop, -halfW, x2, yTop, -halfW, x2, yTop, halfW)
        tri(x1, yTop, -halfW, x2, yTop, halfW, x1, yTop, halfW)
        tri(x2, yTop, -halfW, x2, yBot, -halfW, x2, yBot, halfW)
        tri(x2, yBot, halfW, x2, yTop, halfW, x2, yTop, -halfW)
      }
      lip(headX, headX + lapHead)
      lip(tailX, tailX - lapTail)
      return [{ desc: s.build(), finish: 'gapfill', link: 'roller', castShadow: false, doubleSided: true }]
    }
  },
  react(ctx) {
    // Tag precedence: speedTag (REAL in) replaces the speed param as the commanded speed; runTag (BOOL)
    // gates it to 0, but ONLY while a controller actually drives the tag (ctx.tagDriven, output ownership) —
    // undriven, the authored speed rules; runningTag (BOOL out) = effective speed ≠ 0, written on every call.
    // the unit the conveyor is set up in: everything below this line is m/s
    const cmd = commandedSpeed(ctx)
    const fpm = cmd.fpm
    const running = ctx.tagDriven(ctx.params.runTag) ? ctx.readTag(ctx.params.runTag) : true
    const s = rampedSpeed(ctx, drive, cmd, running ? cmd.commanded : 0)
    // the readout the Inspector shows for 'speed' while a setpoint tag owns it: the EFFECTIVE value,
    // gates and all, not the raw setpoint (a runTag holding this at 0 must not read as the commanded rate)
    reportSpeed(ctx, fpm, s)
    if (fpm) ctx.report('speed', s) // the rollers turn on 'speed' (m/s); the fpm readout above doesn't report it
    if (ctx.params.runningTag) ctx.writeTag(ctx.params.runningTag, s !== 0)
    // drive feedback: the velocity as a share of the speed at 30, an encoder pulse and the odometer
    publishDrive(ctx, drive, cmd, s)
    // skew: the rollers are angled about vertical, so drive along the roller normal — forward rotated by
    // skew (right-handed about +Y) at magnitude s/cos(skew), so the forward throughput stays s and the
    // lateral s·tan(skew) squares cargo against the guard.
    const skewRad = (ctx.params.skew || 0) * Math.PI / 180
    const c = Math.cos(skewRad), sn = Math.sin(skewRad)
    const mag = Math.abs(c) > 1e-3 ? s / c : s
    const fx = ctx.forward.x, fz = ctx.forward.z
    ctx.setSurfaceVelocity({ x: (fx * c + fz * sn) * mag, y: 0, z: (-fx * sn + fz * c) * mag })
    // the next tick is needed only while the drive ramps or counts travel (conveyorDrive.js)
    driveAgain(ctx, drive, running ? cmd.commanded : 0)
  },
})
