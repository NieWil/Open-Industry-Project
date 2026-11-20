// Curved Belt Conveyor — a quarter-turn belt conveyor. Demonstrates the geometry-function tier and arc
// surface velocity: geometry(g, p) lofts the belt bed + steel frame + side guards along a horizontal arc and
// places trestle legs; step(ctx) hands the host the arc centre (the part origin) + omega = speed /
// centreline-radius, so cargo is carried around the curve.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` left out) and rig.json (the manifest).

import { commandedSpeed, conveyorDrive, driveAgain, driveFeedbackParams, driveRampParams, publishDrive, rampedSpeed } from '../_shared/conveyorDrive.js'
import { frictionParam } from '../_shared/conveyorFriction.js'
import { METRIC_ONLY, reportSpeed, speedFpmTagParam, speedUnitParams } from '../_shared/conveyorUnits.js'
import { arcGuard, arcHolePanels } from '../_shared/guardArc.js'
import { LEG_CLEARANCE, LEG_END_INSET, LEG_SPACING, legPieces } from '../_shared/legs.js'

// the baked footprint of the default 90° / innerRadius 0.825 / width 1.524 arc: innerRadius + width + stub
const OUTER = 0.825 + 1.524 + 0.085

const drive = conveyorDrive() // the ramp, the pulse and the encoder, remembered between steps

definePart({
  manifest: {
    id: 'oip.curved-conveyor',
    name: 'Curved Belt Conveyor',
    category: 'Equipment',
    conveyor: { bed: 'arc', surface: 'belt', speedParam: 'speed', frictionParam: 'friction', reverseParam: 'reverse' },
    geometry: { kind: 'drawn', bounds: { length: OUTER, width: OUTER, top: 0.17 }, conveys: true },
  },
  params: {
    innerRadius: { type: 'number', default: 0.825, min: 0.2, max: 4, step: 0.025, label: 'Inner radius (m)', group: 'Size', desc: 'Radius of the INNER edge of the curve. The outer edge sits this plus the width away, so a tight inner radius on a wide bed makes a sharply banked turn that product can jam on.' },
    width: { type: 'number', default: 1.524, min: 0.2, step: 0.05, label: 'Width (m)', group: 'Size', desc: 'Bed width, measured across the curve from the inner edge to the outer one.' },
    // belt height = the straight belt's own param (same name, range and meaning): the loop depth, so the end-drum
    // radius (half of it, which is also the tangent stub the snap ends sit at) and the side frame's depth
    height: { type: 'number', default: 0.17, min: 0.1, max: 0.6, step: 0.01, label: 'Frame height (m)', group: 'Size', desc: 'Depth of the belt loop, deck down to underside, which also sets the end drum size and the depth of the side frame. Set it to the Frame height of the conveyors this curve joins so the frames line up at each end. NOT the height off the floor - that is Stand height below.' },
    // the 'arc' handle marks this a curved conveyor: the host derives the two tangent-stub arc ends (from
    // innerRadius + width + this sweep) so the curve butt-snaps to any neighbour. endGapParam: the stub is the
    // drum radius, height / 2, the same reach a straight belt of that height puts its ends at past its run.
    sweepDeg: { type: 'number', default: 90, min: 15, max: 180, step: 5, label: 'Sweep (°)', group: 'Size', handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width', endGapParam: { param: 'height', scale: 0.5 } }, desc: 'How far the curve turns. 90 degrees is the usual corner; 180 turns a lane back on itself. The snap ends move with this, so a neighbour re-snaps to the new tangent rather than needing to be dragged.' },
    ...speedUnitParams(2),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 2, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'Surface speed carried around the curve. Negative reverses flow, which is the ONLY way to turn a curve around - spinning the part would swap its inner and outer radius. A program can command this through the speed tag below.' },
    ...driveRampParams(0.5, 0.5),
    ...frictionParam(0.59),
    // Engine storage, never an Inspector field (hidden): the SNAP flips this
    // when it mates two ends that both discharge into the junction — a curve can't just be spun 180°, that
    // would swap inner/outer radius. Reversing by hand stays a negative speed; step() folds the two below.
    reverse: { type: 'boolean', default: false, hidden: true, label: 'Reversed (snap-owned)' },
    beltColor: { type: 'color', default: '#ffffff', label: 'Belt color', desc: 'Tint multiplied into the belt weave. White leaves the fabric at full brightness; a dark tint multiplies it down toward black.' },
    // 'alternate' swaps the belt image to a directional-arrows fabric whose arrows scroll along the travel.
    beltTexture: {
      type: 'enum', default: 'standard', label: 'Belt weave',
      desc: 'Which fabric the belt surface wears. Alternate carries directional arrows that scroll along travel, which is the cheapest way to make flow direction readable in a screenshot.',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'alternate', label: 'Arrows (shows flow)' },
      ],
    },
    innerGuard: { type: 'boolean', default: true, label: 'Inner guard', group: 'Guards', desc: 'Guard wall along the INNER edge of the curve. A real barrier, so turning it off lets cargo cut the corner and leave the bed.' },
    outerGuard: { type: 'boolean', default: true, label: 'Outer guard', group: 'Guards', desc: 'Guard wall along the OUTER edge, which is the one centrifugal drift pushes product against. A real barrier - turning it off is how you let product leave on the outside of a turn.' },
    // sensor-beam holes as [θ rad, y m, side ±1] rows: arc angle from the inlet, height above the deck, side −1 the
    // inner guard / +1 the outer. HOST-FED (core/guardHoles.ts works them out from the scene's beams), so hidden.
    guardHoles: { type: 'numberList', arity: 3, default: [], hidden: true, label: 'Guard holes [θ rad, y m, side ±1]', group: 'Guards', desc: 'Where sensor beams cross the side guards. Worked out by the host from the scene; not for editing.' },
    // rest:'surfaceBelow' → the host auto-fills this from the surface beneath at drop/snap.
    standHeight: { type: 'number', default: 2.0, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the conveyor, so the legs reach the floor - or a platform crossing underneath - without you measuring. Pin it by hand when you want a deliberate height.' },
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands surface speed here, replacing the Speed field above, which then shows the live value read-only. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0 - so a half-wired conveyor sits still rather than running at its authored speed.' },
    ...speedFpmTagParam('Comms'),
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (belt runs while true)', group: 'Comms', desc: 'Start/stop gate: false forces the speed to 0 whatever the setpoint says. Unlike the speed tag, this only takes effect once a program actually DRIVES it, so binding it alone will not stop the bed.' },
    runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Running tag (true while moving)', group: 'Comms', desc: 'Feedback the conveyor publishes for the program to read: true whenever it is actually moving. This is the EFFECTIVE speed, gates included, so a run tag holding it at zero reads false here.' },
    ...driveFeedbackParams(2, 'Comms'),
  },
  geometry(g, p) {
    var DEG = Math.PI / 180
    var ir = typeof p.innerRadius === 'number' && p.innerRadius > 0 ? p.innerRadius : 0.825
    var w = typeof p.width === 'number' && p.width > 0 ? p.width : 1.524
    var sweep = (typeof p.sweepDeg === 'number' ? p.sweepDeg : 90) * DEG
    var rc = ir + w / 2 // centreline radius
    var hw = w / 2
    var BT = typeof p.height === 'number' && p.height > 0 ? p.height : 0.17 // belt thickness (m): the loop round a 2·STUB drum
    var STUB = BT / 2 // the end-drum radius (the arc handle's endGapParam; core ARC_END_EXT at the default height): tangent lead-in/out so the curve merges flush with a straight neighbour
    // frame bottom, rounded to the micrometre exactly as the straight belt's is (-0.175 at the default height)
    var FB = -Math.round((BT + 0.005) * 1e6) / 1e6
    var n = Math.max(8, Math.ceil((sweep / DEG) / 5))
    // arc convention: P(t) = (rc·cos t, 0, −rc·sin t), t ∈ [0, sweep]. The inlet is at +X (t=0), sweeping
    // toward −Z. Tangent T(t) = (−sin t, 0, −cos t); radial-outward R(t) = P(t)/rc.
    function P(t) { return [rc * Math.cos(t), 0, -rc * Math.sin(t)] }
    // arc centreline path; g.sweep maps a profile [up, cross] → [Y, radial] on a horizontal arc.
    var path = []
    path.push([rc + 0, 0, 0 + STUB]) // t=0 lead-in: P(0)=(rc,0,0), −tangent(0)=(0,0,1) → +Z stub
    for (var i = 0; i <= n; i++) path.push(P((sweep * i) / n))
    var e = P(sweep), et = [-Math.sin(sweep), 0, -Math.cos(sweep)]
    path.push([e[0] + et[0] * STUB, 0, e[2] + et[2] * STUB])

    // 1. BELT BED — a ring strip (top annulus at y=0 + inner/outer sides down to the belt thickness) wrapping
    // a rounded end-drum nose at each end. u = arc-length so the fabric scrolls; finish 'belt' gets the host's
    // scrolling fabric material (tinted by beltColor in render).
    var bed = g.surface()
    var ri = ir + 0.01, ro = ir + w - 0.01
    var rings = []
    for (var i2 = 0; i2 <= n; i2++) {
      var a = (sweep * i2) / n, ca = Math.cos(a), sa = Math.sin(a)
      rings.push({ ix: ri * ca, iz: -ri * sa, ox: ro * ca, oz: -ro * sa, u: (a * rc) / 1.0 })
    }
    function bq(A, B, C, D) { bed.quad(bed.vertex(A[0], A[1], A[2], A[3], A[4]), bed.vertex(B[0], B[1], B[2], B[3], B[4]), bed.vertex(C[0], C[1], C[2], C[3], C[4]), bed.vertex(D[0], D[1], D[2], D[3], D[4])) }
    for (var i2 = 0; i2 < rings.length - 1; i2++) {
      var r0 = rings[i2], r1 = rings[i2 + 1]
      bq([r0.ix, 0, r0.iz, r0.u, 0], [r0.ox, 0, r0.oz, r0.u, 1], [r1.ox, 0, r1.oz, r1.u, 1], [r1.ix, 0, r1.iz, r1.u, 0]) // top
      bq([r0.ox, 0, r0.oz, r0.u, 1], [r0.ox, -BT, r0.oz, r0.u, 0], [r1.ox, -BT, r1.oz, r1.u, 0], [r1.ox, 0, r1.oz, r1.u, 1]) // outer side
      bq([r0.ix, 0, r0.iz, r0.u, 0], [r1.ix, 0, r1.iz, r1.u, 0], [r1.ix, -BT, r1.iz, r1.u, 1], [r0.ix, -BT, r0.iz, r0.u, 1]) // inner side
    }
    // end-drum nose: wrap the cross-section from the top edge (y=0) down under (y=−2·STUB), bulging STUB along
    // the end's outward tangent — the belt curling over a pulley.
    function nose(r, dx, dz, uSign) {
      var DRUM = 12, pi = [r.ix, 0, r.iz], po = [r.ox, 0, r.oz], pu = r.u
      for (var k = 1; k <= DRUM; k++) {
        var th = (Math.PI * k) / DRUM, along = STUB * Math.sin(th), y = -STUB + STUB * Math.cos(th)
        var ci = [r.ix + dx * along, y, r.iz + dz * along], co = [r.ox + dx * along, y, r.oz + dz * along], cu = r.u + uSign * (STUB * th) / 1.0
        bq([pi[0], pi[1], pi[2], pu, 0], [po[0], po[1], po[2], pu, 1], [co[0], co[1], co[2], cu, 1], [ci[0], ci[1], ci[2], cu, 0])
        pi = ci; po = co; pu = cu
      }
    }
    nose(rings[0], 0, 1, -1) // back: outward tangent at t=0 is +Z
    nose(rings[rings.length - 1], -Math.sin(sweep), -Math.cos(sweep), 1) // front: +tangent at sweep
    var bedPart = { desc: bed.build(), finish: 'belt' }

    // 2. SIDE FRAME RAILS (steel) — an L-rail cross-section (wall FB..−0.005, as deep as the belt loop, + an outward flange lip)
    // swept along the arc path. The profile's cross coord is radial here, so sign −1 = the inner rail
    // (radius rc−hw = innerRadius), +1 = the outer rail (rc+hw = innerRadius+width).
    function sideRail(sign) {
      var z0 = sign * hw, z1 = sign * (hw + 0.01), z2 = sign * (hw + 0.03)
      var wall = g.sweep([[FB, z0], [FB, z1], [-0.005, z1], [-0.005, z0]], path, { caps: true })
      var flange = g.sweep([[-0.005, z1], [-0.005, z2], [0, z2], [0, z1]], path, { caps: true })
      return g.merge(wall, flange)
    }
    var frame = { desc: g.merge(sideRail(-1), sideRail(1)), finish: 'frame' }

    // 3. SIDE GUARDS (steel) — a thin wall just outside each rail, −0.005 up to the 0.15 guard height.
    // collision:'box' so cargo can't leave the band.
    var guardParts = []
    // the guard section, z measured from the curve's centreline: the 5 mm sheet at the bed edge + wall, its top
    // turned OUTWARD (away from the bed) into a 20 mm return so it reads as formed sheet steel. Concave (an L);
    // the capped sweep triangulates it. Visual only: the host builds the arc guard colliders from the shared
    // guard constants (core/curvedGuards.ts), never from this profile.
    function guardSection(zIn, sign) {
      var z1 = zIn + sign * 0.005, z2 = zIn + sign * 0.025
      return [[-0.005, zIn], [-0.005, z1], [0.145, z1], [0.145, z2], [0.15, z2], [0.15, zIn]]
    }
    // each guard is swept along the centreline arc (its section offset by hw + 0.01), broken around its sensor-beam
    // holes (host-fed 'guardHoles' rows; the panels that fill the gaps are appended last, below)
    var holes = Array.isArray(p.guardHoles) ? p.guardHoles : [], holePanels = {}
    if (p.innerGuard !== false) guardParts.push.apply(guardParts, arcGuard(g, guardSection(-(hw + 0.01), -1), rc, rc - hw - 0.01, -1, holes, sweep, n, STUB, holePanels))
    if (p.outerGuard !== false) guardParts.push.apply(guardParts, arcGuard(g, guardSection(hw + 0.01, 1), rc, rc + hw + 0.01, 1, holes, sweep, n, STUB, holePanels))
    var guards = guardParts.length ? { desc: g.merge.apply(g, guardParts), finish: 'guard', collision: 'box' } : null

    // 4. SUPPORT LEGS (steel trestles) — dual-post legs built leg-local, then yawed to each arc station's
    // sweep angle and dropped at the centreline point. A rotation preserves the box winding, so the same
    // faces stay outward.
    var standH = typeof p.standHeight === 'number' && p.standHeight > 0 ? p.standHeight : 0.75
    var FLOOR_Y = -standH
    var legSfc = g.surface()
    var boltSfc = g.surface()
    // a box (local x=tangent, y=up, z=radial) placed at arc angle t, centred on the centreline point P(t).
    // Emits the six faces in CCW-outward order so the rotated box lights correctly.
    function ybox(sfc, t, mnx, mny, mnz, mxx, mxy, mxz) {
      var ct = Math.cos(t), st = Math.sin(t), ax = rc * ct, az = -rc * st
      // world = P(t) + lx·T + ly·up + lz·R, with T=(−st,0,−ct), R=(ct,0,−st)
      function V(lx, ly, lz) { return sfc.vertex(ax + lx * -st + lz * ct, ly + FLOOR_Y, az + lx * -ct + lz * -st) }
      var x0 = mnx, x1 = mxx, y0 = mny, y1 = mxy, z0 = mnz, z1 = mxz
      sfc.quad(V(x1, y0, z1), V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1)) // +x
      sfc.quad(V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0)) // −x
      sfc.quad(V(x0, y1, z1), V(x1, y1, z1), V(x1, y1, z0), V(x0, y1, z0)) // +y
      sfc.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1)) // −y
      sfc.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)) // +z
      sfc.quad(V(x1, y0, z0), V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0)) // −z
    }
    // hex bolt at a leg-local point, yawed to the arc: axis 'y' = a foot bolt standing up; 'z' = along the radial.
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
    // leg stations: tail/head insets + a fixed-spacing grid along the arc length, mapped back to sweep angles.
    var arcLen = rc * sweep, height = standH + FB
    if (height > 0.05 && arcLen > 0) {
      var TAIL = LEG_END_INSET, SP = LEG_SPACING, CLR = LEG_CLEARANCE
      var xs = []
      xs.push(TAIL)
      for (var v = Math.ceil((TAIL + CLR) / SP) * SP; v <= arcLen - TAIL - CLR + 1e-6; v += SP) xs.push(v)
      xs.push(arcLen - TAIL)
      for (var li = 0; li < xs.length; li++) { var s = xs[li]; if (s < 0.05 || s > arcLen - 0.05) continue; legAt(s / rc, height) }
    }
    var legs = { desc: legSfc.build(), finish: 'leg' }
    var bolts = { desc: boltSfc.build(), finish: 'bolt' }

    var parts = [bedPart, frame]
    if (guards) parts.push(guards)
    parts.push(legs, bolts)
    // hole panels LAST (they come and go with the sensors in the scene); VISUAL ONLY, no collision
    parts.push.apply(parts, arcHolePanels(g, holePanels))
    return parts
  },
  react(ctx) {
    // Tag precedence: 1. speedTag (REAL in) replaces the speed param; 2. runTag (BOOL) gates it to 0, but
    // ONLY while a controller drives the tag (ctx.tagDriven = output ownership) — undriven, the authored
    // speed rules; 3. runningTag (BOOL out) is written on every call.
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
    // the arc centre is the part origin — the bed is authored around it.
    const rc = (ctx.params.innerRadius > 0 ? ctx.params.innerRadius : 0.825) + (ctx.params.width > 0 ? ctx.params.width : 1.524) / 2
    const omega = speed / Math.max(rc, 1e-3)
    ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega })
    // the next tick is needed only while the drive ramps or counts travel (conveyorDrive.js)
    driveAgain(ctx, drive, running ? commanded : 0)
  },
})
