// Curved Roller Conveyor — a quarter-turn powered roller bed (geometry-function tier). geometry(g, p) lofts
// the steel frame + side guards along a horizontal arc, lays a bank of spinning rollers (+ axle stubs) around
// it, and yaws trestle legs to the sweep; step(ctx) hands the host the arc centre (the part origin) + omega =
// speed / centreline-radius, so cargo is carried round the curve. A negative speed reverses; a PLC run tag
// start/stops it.
//
// The rollers are the part's own code (_shared/rollerBed.js): the roller tube drawn once and instanced around the
// arc, each copy yawed so its axle points radially and spun about that axle by the bank's `spin` - one roller for
// every roller part.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` left out) and rig.json (the manifest).

import { commandedSpeed, conveyorDrive, driveAgain, driveFeedbackParams, driveRampParams, publishDrive, rampedSpeed } from '../_shared/conveyorDrive.js'
import { frictionParam } from '../_shared/conveyorFriction.js'
import { METRIC_ONLY, reportSpeed, speedFpmTagParam, speedUnitParams } from '../_shared/conveyorUnits.js'
import { arcGuard, arcHolePanels } from '../_shared/guardArc.js'
import { LEG_CLEARANCE, LEG_END_INSET, LEG_SPACING, legPieces } from '../_shared/legs.js'
import { rollerBed } from '../_shared/rollerBed.js'
import { frameBottom, frameHeightParam } from '../_shared/rollerFrame.js'

// the baked footprint of the default 90° / innerRadius 0.825 / width 1.524 arc: innerRadius + width + stub
const OUTER = 0.825 + 1.524 + 0.085

const drive = conveyorDrive() // the ramp, the pulse and the encoder, remembered between steps

definePart({
  manifest: {
    id: 'oip.curved-roller-conveyor',
    name: 'Curved Roller Conveyor',
    category: 'Equipment',
    conveyor: { bed: 'arc', surface: 'roller', speedParam: 'speed', frictionParam: 'friction', reverseParam: 'reverse' },
    geometry: { kind: 'drawn', bounds: { length: OUTER, width: OUTER, top: 0.17 }, conveys: true },
  },
  params: {
    innerRadius: { type: 'number', default: 0.825, min: 0.2, max: 4, step: 0.025, label: 'Inner radius (m)', group: 'Size', desc: 'Radius of the INNER edge of the curve. The outer edge sits this plus the width away, so a tight inner radius on a wide bed makes a sharply banked turn that product can jam on.' },
    width: { type: 'number', default: 1.524, min: 0.2, step: 0.05, label: 'Width (m)', group: 'Size', desc: 'Bed width, measured across the curve from the inner edge to the outer one.' },
    ...frameHeightParam('Size'),
    // the 'arc' handle marks this a curved conveyor: the host derives the two tangent-stub arc ends (from
    // innerRadius + width + this sweep) so the curve butt-snaps to any neighbour. endGap 0.002 (vs a belt
    // curve's 0.085 half-pulley) mates a straight roller to the arc near-flush.
    sweepDeg: { type: 'number', default: 90, min: 15, max: 180, step: 5, label: 'Sweep (°)', group: 'Size', handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width', endGap: 0.002 }, desc: 'How far the curve turns. 90 degrees is the usual corner; 180 turns a lane back on itself. The snap ends move with this, so a neighbour re-snaps to the new tangent rather than needing to be dragged.' },
    ...speedUnitParams(1),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 1, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'Surface speed at the centreline of the curve; the outer edge moves faster, which carries a box round square. Negative reverses flow, the ONLY way to turn a curve around (spinning it would swap its inner and outer radius).' },
    ...driveRampParams(0.2, 0.2),
    ...frictionParam(0.42),
    // Engine storage, never an Inspector field (hidden): the SNAP flips this
    // when it mates two ends that both discharge into the junction — a curve can't just be spun 180°, that
    // would swap inner/outer radius. Reversing by hand stays a negative speed; step() folds the two below.
    reverse: { type: 'boolean', default: false, hidden: true, label: 'Reversed (snap-owned)' },
    innerGuard: { type: 'boolean', default: true, label: 'Inner guard', group: 'Guards', desc: 'Guard wall along the INNER edge of the curve. A real barrier, so turning it off lets cargo cut the corner and leave the bed.' },
    outerGuard: { type: 'boolean', default: true, label: 'Outer guard', group: 'Guards', desc: 'Guard wall along the OUTER edge, which is the one centrifugal drift pushes product against. A real barrier - turning it off is how you let product leave on the outside of a turn.' },
    // sensor-beam holes as [θ rad, y m, side ±1] rows: arc angle from the inlet, height above the deck, side −1 the
    // inner guard / +1 the outer. HOST-FED (core/guardHoles.ts works them out from the scene's beams), so hidden.
    guardHoles: { type: 'numberList', arity: 3, default: [], hidden: true, label: 'Guard holes [θ rad, y m, side ±1]', group: 'Guards', desc: 'Where sensor beams cross the side guards. Worked out by the host from the scene; not for editing.' },
    // deck height above the floor — drives the LEG length; host auto-fills it from the surface beneath at drop/snap.
    standHeight: { type: 'number', default: 2.0, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the conveyor, so the legs reach the floor - or a platform crossing underneath - without you measuring. Pin it by hand when you want a deliberate height.' },
    // Comms trio: speedTag = REAL setpoint in (replaces the speed param), runningTag = BOOL feedback out
    // (effective speed ≠ 0); runTag = BOOL run/stop gate (back-compat).
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands surface speed here, replacing the Speed field above, which then shows the live value read-only. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0 - so a half-wired conveyor sits still rather than running at its authored speed.' },
    ...speedFpmTagParam('Comms'),
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (rollers run while true)', group: 'Comms', desc: 'Start/stop gate: false forces the speed to 0 whatever the setpoint says. Unlike the speed tag, this only takes effect once a program actually DRIVES it, so binding it alone will not stop the bed.' },
    runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Running tag (true while moving)', group: 'Comms', desc: 'Feedback the conveyor publishes for the program to read: true whenever it is actually moving. This is the EFFECTIVE speed, gates included, so a run tag holding it at zero reads false here.' },
    ...driveFeedbackParams(1, 'Comms'),
  },
  geometry(g, p) {
    var DEG = Math.PI / 180
    var ir = typeof p.innerRadius === 'number' && p.innerRadius > 0 ? p.innerRadius : 0.825
    var w = typeof p.width === 'number' && p.width > 0 ? p.width : 1.524
    var sweep = (typeof p.sweepDeg === 'number' ? p.sweepDeg : 90) * DEG
    var rc = ir + w / 2 // centreline radius
    var hw = w / 2
    var FB = frameBottom(p) // the frame bottom (frameHeight below the rail top)
    // Frame + guards sweep a straight tangent tail to the SNAP end (= the sweep handle's endGap) and stop there,
    // so they meet a butted neighbour's rails end to end, the way a curved belt's do at its half-pulley. Running
    // further would lie on top of the neighbour's own rails and guard: a bare stub past the last roller at a free
    // end, and a guard put back over the neighbour's openings or switched-off side.
    var STUB = 0.002
    var n = Math.max(8, Math.ceil((sweep / DEG) / 5))
    // SDK arc convention (matches snapping): P(t) = (r·cos t, 0, −r·sin t), t ∈ [0, sweep]. Inlet at +X (t=0),
    // sweeping toward −Z. Tangent T(t) = (−sin t, 0, −cos t); radial-outward R(t) = P(t)/r.
    // edgePath(sign): the arc along one BED EDGE (radius rc + sign·hw, so −1 = innerRadius, +1 = the outer
    // edge), extended by a straight tangent STUB at each end. Each rail/guard is swept along its own edge, with
    // its profile measured off that edge, not off the centreline: the sweep squares every ring to a central-
    // difference tangent, and beside a stub much shorter than one arc step the first arc ring tilts ~dt/2.
    // Measured off the centreline that tilt had a lever arm of hw (0.76 m on the default bed) and folded the
    // inner rail 33 mm back past the stub; off the edge the lever is the profile's own ≤0.03 m.
    function edgePath(sign) {
      var r = rc + sign * hw
      var path = [[r, 0, STUB]] // t=0 lead-in: −tangent(0) = (0,0,1) → +Z stub
      for (var i = 0; i <= n; i++) {
        var t = (sweep * i) / n
        path.push([r * Math.cos(t), 0, -r * Math.sin(t)])
      }
      var et = [-Math.sin(sweep), 0, -Math.cos(sweep)] // end tangent (lead-out direction)
      path.push([r * Math.cos(sweep) + et[0] * STUB, 0, -r * Math.sin(sweep) + et[2] * STUB])
      return path
    }

    // 1. SIDE FRAME RAILS (steel) — an L-rail cross-section (wall FB..−0.005 + an outward flange lip),
    // swept along the arc. The profile's cross coord is radial, so sign −1 = the inner rail (radius rc−hw =
    // innerRadius), +1 = the outer rail (rc+hw = innerRadius+width).
    function sideRail(sign) {
      var path = edgePath(sign)
      var z1 = sign * 0.01, z2 = sign * 0.03
      var wall = g.sweep([[FB, 0], [FB, z1], [-0.005, z1], [-0.005, 0]], path, { caps: true })
      var flange = g.sweep([[-0.005, z1], [-0.005, z2], [0, z2], [0, z1]], path, { caps: true })
      return g.merge(wall, flange)
    }
    var frame = { desc: g.merge(sideRail(-1), sideRail(1)), finish: 'frame' }

    // 2. SIDE GUARDS (steel) — a thin wall just outside each rail, −0.005..0.15. Inner / outer are
    // independently toggled. collision:'box' so cargo can't leave the band.
    var guardParts = []
    // the guard section, z measured off its own bed edge (edgePath): the 5 mm sheet just outside the frame wall, its top
    // turned OUTWARD (away from the bed) into a 20 mm return so it reads as formed sheet steel. Concave (an L);
    // the capped sweep triangulates it. Visual only: the host builds the arc guard colliders from the shared
    // guard constants (core/curvedGuards.ts), never from this profile.
    function guardSection(zIn, sign) {
      var z1 = zIn + sign * 0.005, z2 = zIn + sign * 0.025
      return [[-0.005, zIn], [-0.005, z1], [0.145, z1], [0.145, z2], [0.15, z2], [0.15, zIn]]
    }
    // each guard is swept along its own bed edge (edgePath's arc), broken around its sensor-beam holes (host-fed
    // 'guardHoles' rows; the panels that fill the gaps are appended last, below)
    var holes = Array.isArray(p.guardHoles) ? p.guardHoles : [], holePanels = {}
    if (p.innerGuard !== false) guardParts.push.apply(guardParts, arcGuard(g, guardSection(-0.01, -1), rc - hw, rc - hw - 0.01, -1, holes, sweep, n, STUB, holePanels))
    if (p.outerGuard !== false) guardParts.push.apply(guardParts, arcGuard(g, guardSection(0.01, 1), rc + hw, rc + hw + 0.01, 1, holes, sweep, n, STUB, holePanels))
    var guards = guardParts.length ? { desc: g.merge.apply(g, guardParts), finish: 'guard', collision: 'box' } : null

    // 3. ROLLERS (render-only, spinning) — a bank laid on the arc: one roller per roller pitch of centreline arc
    // length. Each is yawed t+π/2 so its axle points radially (across flow) and spins about it at the bed speed.
    var R = 0.024, PITCH = 0.075 // rendered roller radius + centre-to-centre pitch
    var rollerLen = Math.max(w - 0.004, 0.01) // body recessed just behind the inner/outer frame walls
    var WALL = 0.01, STUB_PROT = 0.02, STUB_ANCHOR = 0.015 // frame wall thickness / stub poke past it / anchor into the bed
    var stubR = R * 0.34
    var stubOff = hw + (WALL + STUB_PROT - STUB_ANCHOR) / 2 // stub centre outside the bed edge
    var stubLen = WALL + STUB_PROT + STUB_ANCHOR
    var dtheta = PITCH / Math.max(rc, 0.01) // centreline pitch → angular step (density matches a straight neighbour)
    var count = Math.max(2, Math.ceil(sweep / dtheta) + 1)
    var insts = []
    // rollers span exactly the arc [0, sweep] — no tangent lead-in/out overhang, so a roller curve butts flush.
    for (var ri = 0; ri < count; ri++) {
      var a = (sweep * ri) / (count - 1)
      insts.push({ x: rc * Math.cos(a), z: -rc * Math.sin(a), yaw: a + Math.PI / 2, length: rollerLen })
    }
    // axles at y = -R (the tube tops are the conveying plane); the stubs centred stubOff out from the bed's centreline
    var rollers = rollerBed(g, insts, { radius: R, y: -R, stub: { radius: stubR, length: stubLen, protrude: stubOff - rollerLen / 2 } })

    // 4. SUPPORT LEGS (steel trestles) — dual-post legs (posts + foot plates + collars + sleeves + clamps +
    // crossbar braces + hex bolts), built leg-local then yawed to each arc station's sweep angle and dropped
    // at the centreline point. A rotation preserves the box winding, so the same faces stay outward.
    var standH = typeof p.standHeight === 'number' && p.standHeight > 0 ? p.standHeight : 0.75
    var FLOOR_Y = -standH
    var legSfc = g.surface()
    var boltSfc = g.surface()
    function ybox(sfc, t, mnx, mny, mnz, mxx, mxy, mxz) {
      var ct = Math.cos(t), st = Math.sin(t), ax = rc * ct, az = -rc * st
      function V(lx, ly, lz) { return sfc.vertex(ax + lx * -st + lz * ct, ly + FLOOR_Y, az + lx * -ct + lz * -st) }
      var x0 = mnx, x1 = mxx, y0 = mny, y1 = mxy, z0 = mnz, z1 = mxz
      sfc.quad(V(x1, y0, z1), V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1)) // +x
      sfc.quad(V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0)) // −x
      sfc.quad(V(x0, y1, z1), V(x1, y1, z1), V(x1, y1, z0), V(x0, y1, z0)) // +y
      sfc.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1)) // −y
      sfc.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)) // +z
      sfc.quad(V(x1, y0, z0), V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0)) // −z
    }
    function yhex(t, lx, ly, lz, r, depth, axis) {
      var ct = Math.cos(t), st = Math.sin(t), ax = rc * ct, az = -rc * st
      function V(ux, uy, uz) { return boltSfc.vertex(ax + ux * -st + uz * ct, uy + FLOOR_Y, az + ux * -ct + uz * -st) }
      var f = [], b = []
      for (var k = 0; k < 6; k++) {
        var a = (k / 6) * Math.PI * 2 + Math.PI / 6, u = Math.cos(a) * r, ww = Math.sin(a) * r
        if (axis === 'y') { f.push(V(lx + u, ly + depth / 2, lz + ww)); b.push(V(lx + u, ly - depth / 2, lz + ww)) }
        else { f.push(V(lx + u, ly + ww, lz + depth / 2)); b.push(V(lx + u, ly + ww, lz - depth / 2)) }
      }
      for (var k = 1; k < 5; k++) { boltSfc.triangle(f[0], f[k], f[k + 1]); boltSfc.triangle(b[0], b[k + 1], b[k]) }
      for (var k = 0; k < 6; k++) { var k2 = (k + 1) % 6; boltSfc.quad(f[k], b[k], b[k2], f[k2]) }
    }
    // a real floor support (_shared/legs.js) at arc angle t, every box/bolt yawed to the arc. No knee
    // braces: one reaching along the tangent would miss the curving frame by the arc's sag over its length.
    function legAt(t, height) {
      var pc = legPieces(hw, height, 0, -FB)
      for (var i = 0; i < pc.boxes.length; i++) {
        var b = pc.boxes[i]
        ybox(legSfc, t, b[0] - b[3] / 2, b[1] - b[4] / 2, b[2] - b[5] / 2, b[0] + b[3] / 2, b[1] + b[4] / 2, b[2] + b[5] / 2)
      }
      for (var j = 0; j < pc.bolts.length; j++) { var q = pc.bolts[j]; yhex(t, q[0], q[1], q[2], q[3], q[4], q[5]) }
    }
    // leg stations: tail/head insets + a spacing grid along the arc length, mapped back to sweep angles.
    // Height = standH − frame depth (−FB); the arc bed is flat (no tilt).
    var arcLen = rc * sweep, height = standH + FB
    if (height > 0.05 && arcLen > 0) {
      var TAIL = LEG_END_INSET, SP = LEG_SPACING, CLR = LEG_CLEARANCE
      var xs = []
      xs.push(TAIL)
      for (var v = Math.ceil((TAIL + CLR) / SP) * SP; v <= arcLen - TAIL - CLR + 1e-6; v += SP) xs.push(v)
      xs.push(arcLen - TAIL)
      for (var lgi = 0; lgi < xs.length; lgi++) { var s = xs[lgi]; if (s < 0.05 || s > arcLen - 0.05) continue; legAt(s / rc, height) }
    }
    var legs = { desc: legSfc.build(), finish: 'leg' }
    var bolts = { desc: boltSfc.build(), finish: 'bolt' }

    var parts = [frame]
    if (guards) parts.push(guards)
    parts.push(legs, bolts)
    parts.push.apply(parts, rollers)
    // hole panels LAST (they come and go with the sensors in the scene); VISUAL ONLY, no collision
    parts.push.apply(parts, arcHolePanels(g, holePanels))
    return parts
  },
  react(ctx) {
    // Tag precedence: speedTag (REAL in) replaces the speed param as the commanded speed; runTag (BOOL)
    // gates it to 0, but ONLY while a controller actually drives the tag (ctx.tagDriven, output ownership) —
    // undriven, the authored speed rules; runningTag (BOOL out) = effective speed ≠ 0, written on every call.
    // the unit the conveyor is set up in: everything below this line is m/s
    const cmd = commandedSpeed(ctx)
    const fpm = cmd.fpm, commanded = cmd.commanded
    const running = ctx.tagDriven(ctx.params.runTag) ? ctx.readTag(ctx.params.runTag) : true
    // 'reverse' is a MOUNTING fact the snap owns, not a value the program owns, so it flips whichever speed is
    // in force — authored or tag-commanded.
    const ramped = rampedSpeed(ctx, drive, cmd, running ? commanded : 0)
    const speed = ramped * (ctx.params.reverse ? -1 : 1)
    // Inspector readout for speed: the effective m/s INCLUDING the reverse flip - the arc omega below is
    // derived from it, so a curve reports the linear rate its speed param is authored in, not rad/s.
    reportSpeed(ctx, fpm, speed)
    if (ctx.params.runningTag) ctx.writeTag(ctx.params.runningTag, speed !== 0)
    // drive feedback: the velocity as a share of the speed at 30, an encoder pulse and the odometer
    publishDrive(ctx, drive, cmd, speed)
    // the arc centre is the part origin (the bed is authored around it); omega = speed / centreline-radius.
    const rc = (ctx.params.innerRadius > 0 ? ctx.params.innerRadius : 0.825) + (ctx.params.width > 0 ? ctx.params.width : 1.524) / 2
    const omega = speed / Math.max(rc, 1e-3)
    ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega })
    // the next tick is needed only while the drive ramps or counts travel (conveyorDrive.js)
    driveAgain(ctx, drive, running ? commanded : 0)
  },
})
