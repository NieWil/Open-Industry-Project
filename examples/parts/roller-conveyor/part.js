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

import { commandedSpeed, conveyorDrive, driveAgain, driveFeedbackParams, driveRampParams, publishDrive, rampedSpeed } from '../_shared/conveyorDrive.js'
import { frictionParam } from '../_shared/conveyorFriction.js'
import { METRIC_ONLY, reportSpeed, speedFpmTagParam, speedUnitParams } from '../_shared/conveyorUnits.js'
import { rollerBandMaterial, rollerBed } from '../_shared/rollerBed.js'
import { frameHeightParam } from '../_shared/rollerFrame.js'

var R = 0.024, PITCH = 0.075 // rendered roller radius (the roller template's 0.12 scaled down), roller pitch (the rig's grid spacing)
const STUB_R = R * 0.34 //   thin axle-shaft stubs poking through the frame
const WALL = 0.01 //         frame wall thickness
const FLW = 0.02 //          frame flange width
const FLT = 0.005 //         frame flange thickness
const RAIL_TOP = -0.005 //   rail top just under the belt-surface plane y=0
const GUARD_H = 0.15 //      guard height above the rollers (core GUARD_HEIGHT)
const GUARD_T = 0.005 //     guard thickness
const LIP_W = 0.02 //        guard top return: how far it turns OUTWARD from the sheet
const LIP_T = 0.005 //       ...and its thickness (same sheet)
const DARK = [0.1, 0.1, 0.11] // hidden conveying deck (reads as the shadow gap between the rollers)

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
  manifest: {
    id: 'oip.roller-conveyor',
    name: 'Roller Conveyor',
    category: 'Equipment',
    conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed', frictionParam: 'friction' },
    // the drive bands' urethane; everything else takes the shared conveyor materials through its links' finishes
    materials: [rollerBandMaterial('band')],
  },
  rig(p) {
    // a side part at ±width/2, plus an outward inset
    const zAt = (side, inset) => side * (p.width / 2 + inset)
    // the frameHeight param: the wall's height, its centre (hung from RAIL_TOP), and the legs' frame depth all track
    // it, so a bed butted to a belt of a different Frame height can match its frame
    const wallY = RAIL_TOP - p.frameHeight / 2
    return {
      // `inclineParam` marks this a whole-bed incline conveyor: `tiltDeg` tilts the rigid bed about its centre
      // (±maxInclineDeg) - the host tilts render + collision, regrows the legs, and carries cargo up the slope.
      inclineParam: 'tiltDeg',
      maxInclineDeg: 30,
      links: [
        // the real cargo surface: a thin `conveys` deck whose top sits at the part origin (y 0), level with the
        // roller tops. hidden - a roller bed shows no deck slab; the sim builds the conveying body from it anyway.
        { name: 'deck', shape: { kind: 'box', size: [p.length, 0.04, p.width] }, offset: [0, -0.02, 0], conveys: true, hidden: true, color: DARK },
        // the roller bed's frame: R below the deck (the roller axles), carrying the pitch GRID. The rollers themselves
        // are the behavior's geometry() (_shared/rollerBed.js), drawn onto this link so they ride the incline; the
        // link only declares where they go. Its array is world-phased, so the host resolves one grid across butted beds
        // and hands it to geometry() as ctx.deltas - the grid spans parts, which no part can compute alone. A `frame`
        // draws and collides nothing, so the array places nothing by itself. Render-only: the `conveys` deck is the
        // real surface. worldPhase locks the copies to the world pitch grid (maxSpacing = exact pitch) so two butted
        // roller beds share grid lines.
        { name: 'roller', shape: { kind: 'frame' }, offset: [0, -R, 0], array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: PITCH, worldPhase: true } } },
        // side frames - an L-rail: a vertical wall (frameHeight, 0.17 m by default) + an outward top flange lip, at ±width/2.
        { name: 'wallL', shape: { kind: 'box', size: [p.length, p.frameHeight, WALL] }, offset: [0, wallY, zAt(-1, WALL / 2)], finish: 'frame', sideRail: 'left', bed: true },
        { name: 'wallR', shape: { kind: 'box', size: [p.length, p.frameHeight, WALL] }, offset: [0, wallY, zAt(1, WALL / 2)], finish: 'frame', sideRail: 'right', bed: true },
        // collision: 'none': the flange top sits flush with the conveying plane, so a colliding flange is a phantom curb
        // that wedge-stops cargo squared sideways (skew / merges). The wall body below (top 5 mm under the plane)
        // still frames the bed side; the rim is render-only.
        { name: 'flangeL', shape: { kind: 'box', size: [p.length, FLT, FLW] }, offset: [0, RAIL_TOP + FLT / 2, zAt(-1, WALL + FLW / 2)], finish: 'frame', sideRail: 'left', bed: true, collision: 'none' },
        { name: 'flangeR', shape: { kind: 'box', size: [p.length, FLT, FLW] }, offset: [0, RAIL_TOP + FLT / 2, zAt(1, WALL + FLW / 2)], finish: 'frame', sideRail: 'right', bed: true, collision: 'none' },
        // side guards - thin light-steel walls rising from just below the rail top to GUARD_H, just outside the wall.
        // A boolean showParam drops the wall's render AND collision (a real opening), so cargo can be diverted off / loaded on.
        { name: 'guardL', shape: { kind: 'box', size: [p.length, GUARD_H + FLT, GUARD_T] }, offset: [0, (GUARD_H - FLT) / 2, zAt(-1, WALL + GUARD_T / 2)], finish: 'guard', sideGuard: 'left', showParam: 'leftGuard' },
        { name: 'guardR', shape: { kind: 'box', size: [p.length, GUARD_H + FLT, GUARD_T] }, offset: [0, (GUARD_H - FLT) / 2, zAt(1, WALL + GUARD_T / 2)], finish: 'guard', sideGuard: 'right', showParam: 'rightGuard' },
        // the guard's formed top: a short outward return along its top edge, so the sheet reads as folded steel
        // rather than card. sideGuard so it splits around openings and follows snap extents with its guard;
        // collision: 'none' because the guard wall is the barrier, and a collider here would change the one guard
        // cross-section every family shares (the one butted guards merge on - core/guardRuns.ts).
        { name: 'lipL', shape: { kind: 'box', size: [p.length, LIP_T, LIP_W] }, offset: [0, GUARD_H - LIP_T / 2, zAt(-1, WALL + GUARD_T + LIP_W / 2)], finish: 'guard', sideGuard: 'left', showParam: 'leftGuard', collision: 'none' },
        { name: 'lipR', shape: { kind: 'box', size: [p.length, LIP_T, LIP_W] }, offset: [0, GUARD_H - LIP_T / 2, zAt(1, WALL + GUARD_T + LIP_W / 2)], finish: 'guard', sideGuard: 'right', showParam: 'rightGuard', collision: 'none' },
        // support legs - a dual-post steel trestle (kind:'leg'): one link becomes a row auto-spaced along the
        // length. Height = standHeight (deck→floor) − the frame depth; the link's offset y tracks −standHeight so
        // the feet stay on the floor as the deck is raised/lowered.
        { name: 'legs', shape: { kind: 'leg', spanParam: 'length', widthParam: 'width', standParam: 'standHeight', frameDepth: p.frameHeight - RAIL_TOP }, offset: [0, -p.standHeight, 0] },
      ],
      joints: [],
      bounds: { length: 4, width: 1.6, top: 2.3 },
    }
  },
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
