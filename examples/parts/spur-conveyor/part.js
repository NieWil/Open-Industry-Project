// Spur Belt Conveyor — a splayed merge belt (geometry-function tier). Its deck is a
// parallelogram (the splayed ends let it merge flush onto a main line at an angle), built as a stack of conveying
// strips staircased across the width and clipped to independent front/back splay faces. Each strip is a full belt
// loop: the fabric wraps a rounded 16-segment nose at each end, tangent to the flat top and bottom, with
// white-metal side caps between the strips. Framed by straight L-rails + side guards + a trestle leg. Every
// repeated shape is emitted as instanced templates (MeshPart.instances) sharing the straight belt's pool buckets;
// only the splay-shaped gap-fill prism (+ the strip side caps merged into it) and the two collision guard walls
// stay per-part meshes. The behavior is exactly a straight belt's: step(ctx) drives the surface velocity along the
// flow axis (+X) at the set speed. A negative speed reverses; a PLC run tag gates it. Centred at the origin so the
// host's flat conveying deck (length×width) lines up under the sheared bed.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` left out) and rig.json (the manifest).

import { commandedSpeed, conveyorDrive, driveAgain, driveFeedbackParams, driveRampParams, publishDrive, rampedSpeed } from '../_shared/conveyorDrive.js'
import { frictionParam } from '../_shared/conveyorFriction.js'
import { METRIC_ONLY, reportSpeed, speedFpmTagParam, speedUnitParams } from '../_shared/conveyorUnits.js'
import { guardGapRuns, guardGapsParam } from '../_shared/guardGaps.js'
import { HOLE_PANEL, holePanel } from '../_shared/guardHolePanel.js'
import { guardBand, guardMitresParam, mitreLookup, railCutLookup, railCutsParam, spurRailCutter } from '../_shared/guardMitre.js'
import { LEG_CLEARANCE, LEG_END_INSET, LEG_SPACING, legPieces } from '../_shared/legs.js'

// the baked footprint of the default 2 m / 1.524 m / 30° spur: length + front-splay reach
const OUTER = 2 + Math.tan((30 * Math.PI) / 180) * 1.524

const drive = conveyorDrive() // the ramp, the pulse and the encoder, remembered between steps

definePart({
  manifest: {
    id: 'oip.spur-conveyor',
    name: 'Spur Belt Conveyor',
    category: 'Equipment',
    conveyor: { bed: 'spur', surface: 'belt', speedParam: 'speed', frictionParam: 'friction' },
    // `conveys` makes it a powered surface (the sim builds the flat length×width deck the sheared bed rides on)
    geometry: { kind: 'drawn', bounds: { length: OUTER, width: 1.524, top: 2.3 }, conveys: true },
  },
  params: {
    // 'face' handles = viewport resize dots (±X length, ±Z width). The length handle's
    // angleFrontParam/angleBackParam mark this part a spur: the host derives the angled snap ends (the splayed
    // face merges flush onto a straight conveyor's side, opening the host's guard), the parallelogram footprint +
    // collision deck, and the rail/guard snap extents it folds into `guardExtents` below.
    length: { type: 'number', default: 2, min: 0.5, step: 0.1, label: 'Length (m)', group: 'Size', handle: { kind: 'face', axis: 'x', angleFrontParam: 'angleFrontDeg', angleBackParam: 'angleBackDeg' }, desc: 'Bed length along travel, measured down the centreline. The end faces stay splayed at the angles below as it grows, so the short side and long side keep their difference.' },
    width: { type: 'number', default: 1.524, min: 0.2, step: 0.05, label: 'Width (m)', group: 'Size', handle: { kind: 'face', axis: 'z' }, desc: 'Bed width across travel. Drag the dot on either side face to resize in the viewport.' },
    // belt height = the straight belt's own param (same name, range and meaning): the loop depth, so the end-drum
    // radius (half of it) and the side frame's depth. A spur set to the Frame height of the line it merges onto meets
    // that line's frame flush, and shares its pooled rail template.
    height: { type: 'number', default: 0.17, min: 0.1, max: 0.6, step: 0.01, label: 'Frame height (m)', group: 'Size', desc: 'Depth of the belt loop, deck down to underside, which also sets the end drum size and the depth of the side frame. Set it to the Frame height of the conveyor this spur merges onto so the two frames line up. NOT the height off the floor - that is Stand height below.' },
    ...speedUnitParams(2),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 2, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'Surface speed carried along the bed. Negative runs it backwards, which is the ONLY way to reverse flow - rotating the part 180 degrees moves its ends and their splay instead. A program can command this through the speed tag below.' },
    ...driveRampParams(0.5, 0.5),
    ...frictionParam(0.59),
    angleFrontDeg: { type: 'number', default: 30, min: -60, max: 60, step: 1, label: 'Front angle (°)', group: 'Ends', desc: 'Splay angle of the DISCHARGE end face. This is what makes the part a spur: an angled face merges flush onto the side of a straight conveyor instead of butting square against it. 0 leaves the end square.' },
    angleBackDeg: { type: 'number', default: 0, min: -60, max: 60, step: 1, label: 'Back angle (°)', group: 'Ends', desc: 'Splay angle of the INFEED end face. Leave it at 0 for a spur fed square from behind; angle it too when the piece has to sit between two angled neighbours.' },
    // parallel belt strips fanning across the splay — more = smoother sheared edges.
    conveyorCount: { type: 'number', default: 20, min: 1, max: 20, step: 1, label: 'Belt strips', desc: 'How many narrow parallel belt loops fan across the width. More strips give a smoother angled face, since each one is clipped to the splay and the end staircases in steps of one strip.' },
    beltColor: { type: 'color', default: '#ffffff', label: 'Belt color', desc: 'Tint multiplied into the belt weave. White leaves the fabric at full brightness; a dark tint multiplies it down toward black.' },
    // 'alternate' samples /textures/BeltFabricArrows.jpg instead of the plain weave; its arrows scroll along travel.
    beltTexture: {
      type: 'enum', default: 'standard', label: 'Belt weave',
      desc: 'Which fabric the belt surface wears. Alternate carries directional arrows that scroll along travel, which is the cheapest way to make flow direction readable in a screenshot.',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'alternate', label: 'Arrows (shows flow)' },
      ],
    },
    leftGuard: { type: 'boolean', default: true, label: 'Left guard', group: 'Guards', desc: 'Guard wall down the left side, looking along travel. A real barrier, so turning it off lets cargo leave the bed sideways - which on a spur is usually the point.' },
    rightGuard: { type: 'boolean', default: true, label: 'Right guard', group: 'Guards', desc: 'Guard wall down the right side, looking along travel. A real barrier, so turning it off lets cargo leave the bed sideways.' },
    // sensor-beam holes as [x m, y m, side ±1] rows: bed-local X (centre-origin), height above the deck, side −1
    // left / +1 right. HOST-FED (core/guardHoles.ts works them out from the scene's beams), so hidden.
    guardHoles: { type: 'numberList', arity: 3, default: [], hidden: true, label: 'Guard holes [x m, y m, side ±1]', group: 'Guards', desc: 'Where sensor beams cross the side guards. Worked out by the host from the scene; not for editing.' },
    // rail/guard end overrides as [side ±1, backX m, frontX m] rows (local centre-origin X). Normally host-fed:
    // at a side merge the host folds in the snap-derived extents so rails + guards reach the host's wall plane
    // instead of stopping at the splayed face (render and collision).
    guardExtents: { type: 'numberList', hidden: true, arity: 3, default: [], label: 'Rail extents [side ±1, back m, front m]', group: 'Guards', desc: 'Where the rails and guards STOP on each side, in bed-local X. Normally written by the host: when this spur merges flush onto another conveyor, this retracts the rails to its outer wall instead of running them through its frame. Worked out by the host from the scene; not for editing.' },
    // mitred guard ends as [x m, c, side ±1] rows (_shared/guardMitre.js). HOST-FED at a side merge, so hidden.
    ...guardMitresParam('Guards'),
    ...guardGapsParam('Guards'),
    ...railCutsParam('Guards'),
    // deck height above the floor — drives the LEG length; host auto-fills it from the surface beneath at drop/snap.
    standHeight: { type: 'number', default: 2.0, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the conveyor, so the legs reach the floor - or a platform crossing underneath - without you measuring. Pin it by hand when you want a deliberate height.' },
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands surface speed here, replacing the Speed field above, which then shows the live value read-only. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0 - so a half-wired conveyor sits still rather than running at its authored speed.' },
    ...speedFpmTagParam('Comms'),
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (belt runs while true)', group: 'Comms', desc: 'Start/stop gate: false forces the speed to 0 whatever the setpoint says. Unlike the speed tag, this only takes effect once a program actually DRIVES it, so binding it alone will not stop the belt.' },
    runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Running tag (true while moving)', group: 'Comms', desc: 'Feedback the conveyor publishes for the program to read: true whenever it is actually moving. This is the EFFECTIVE speed, gates included, so a run tag holding it at zero reads false here.' },
    ...driveFeedbackParams(2, 'Comms'),
  },
  // Procedural geometry — the full spur as multi-material MeshPart[]: a scrolling fabric bed (staircased strips) +
  // end drums + a whiteish gap-fill underbody prism + straight steel L-rails + toggleable side guards + a tail
  // trestle leg + hex bolts. Centred on the origin (x ∈ [−L/2, L/2]).
  geometry(g, p) {
    var DEG = Math.PI / 180
    var L = typeof p.length === 'number' && p.length > 0 ? p.length : 2
    var w = typeof p.width === 'number' && p.width > 0 ? p.width : 1.524
    var hw = w / 2
    var tf = Math.tan((typeof p.angleFrontDeg === 'number' ? p.angleFrontDeg : 30) * DEG)
    var tb = Math.tan((typeof p.angleBackDeg === 'number' ? p.angleBackDeg : 0) * DEG)
    var count = Math.max(1, Math.round(typeof p.conveyorCount === 'number' ? p.conveyorCount : 20))
    var BT = typeof p.height === 'number' && p.height > 0 ? p.height : 0.17 // belt thickness (loop depth) = the height param
    var PR = BT / 2 // belt pulley (nose) radius
    var PERIOD = 1.0 // fabric u tiling period, m
    var RAIL_TOP = -0.005 // rail/flange top, just under the belt surface
    var FH = BT // frame height: as deep as the belt loop, like the straight belt's
    // frame bottom, rounded to the micrometre exactly as the straight belt's FB is, so the rail template below stays
    // byte-identical to a same-height belt's (0.17 + 0.005 is 0.17500000000000002 in binary: one bit splits the pool)
    var FB = -Math.round((FH - RAIL_TOP) * 1e6) / 1e6
    var FWT = 0.01 // frame wall thickness
    var FFW = 0.02 // frame flange width
    var FFT = 0.005 // frame flange thickness
    var GH = 0.15 // guard height (core GUARD_HEIGHT)
    var GT = 0.005 // guard thickness
    var SLOT_MIN = 2 * PR + 0.01 // a strip shorter than its two nose wraps (the loop diameter) is dropped
    function frontX(z) { return L / 2 + tf * z }
    function backX(z) { return -L / 2 + tb * z }

    // 1. BELT BED — one full belt loop per strip: conveyorCount parallel strips fanning across the width, each
    // clipped between its two splay faces (so the splayed end staircases). Emitted as instanced templates like the
    // straight belt's bed: a 1 m unit band strip (the flat top/bottom runs, length in scale.x) + a WRAP-segment
    // half-cylinder nose band (radius PR, tangent to both runs), 4 instances per strip in loop order. Each
    // instance's data [uMul, uAdd, vMul, vAdd] lets the shared fabric-bank material rebuild the loop arc-length
    // (u·uMul + uAdd, the same 1-per-PERIOD tiling + scroll convention as a straight belt) and the strip's slice of
    // the cross-belt weave (v·vMul + vAdd) — so scrolling rides the bank's per-instance attribute, not a per-part
    // texture. The u seam stays at the bottom of the back nose (hidden); the strip sides are the white-metal caps
    // merged into part 2.
    var WRAP = 16
    // band template: 1 m unit strip in the conveying plane (y=0), z ±1 → the strip half-width via scale.z,
    // u = local metres, v = 0..1 across the template (each instance remaps it to its slice)
    var bandSfc = g.surface()
    var ba0 = bandSfc.vertex(0, 0, -1, 0, 0), bb0 = bandSfc.vertex(0, 0, 1, 0, 1)
    var ba1 = bandSfc.vertex(1, 0, -1, 1, 0), bb1 = bandSfc.vertex(1, 0, 1, 1, 1)
    bandSfc.quad(ba0, bb0, bb1, ba1)
    // nose template: half-cylinder band from the top tangent point over the front to the bottom (WRAP
    // segments), nose centre local (0, −PR), u = arc metres
    var wrapSfc = g.surface()
    var wPrevA = -1, wPrevB = -1
    for (var wi = 0; wi <= WRAP; wi++) {
      var wTh = Math.PI / 2 - (wi * Math.PI) / WRAP
      var wU = PR * ((wi * Math.PI) / WRAP)
      var wA = wrapSfc.vertex(Math.cos(wTh) * PR, Math.sin(wTh) * PR - PR, -1, wU, 0)
      var wB = wrapSfc.vertex(Math.cos(wTh) * PR, Math.sin(wTh) * PR - PR, 1, wU, 1)
      if (wi > 0) wrapSfc.quad(wPrevA, wPrevB, wB, wA)
      wPrevA = wA; wPrevB = wB
    }
    var qBack = [0, 0, 1, 0] // rotZ(π) for the back-nose/bottom-run pieces — a proper rotation (not a mirror)
    var wrapU = Math.PI * PR
    var bandInsts = [], wrapInsts = []
    var capSfc = g.surface()
    var cw = w / count
    for (var i = 0; i < count; i++) {
      var zc = -hw + cw * (i + 0.5)
      var fX = frontX(zc), bX = backX(zc)
      if (fX - bX < SLOT_MIN) continue
      var zL = zc - cw / 2 + (i > 0 ? FWT / 2 : 0.005) // inset off the neighbour/rail
      var zR = zc + cw / 2 - (i < count - 1 ? FWT / 2 : 0.005)
      if (zR - zL < 1e-4) continue
      var m0 = bX + PR, m1 = Math.max(fX - PR, bX + PR) // nose wrap centres; the noses reach bX / fX exactly
      var run = m1 - m0
      var zMid = (zL + zR) / 2, hz = (zR - zL) / 2
      var vW = (zR - zL) / w, vL = (zL + hw) / w
      wrapInsts.push({ position: [m0, -BT, zMid], quaternion: qBack, scale: [1, 1, hz], data: [1, 0, vW, vL] }) // back nose, seam → top
      bandInsts.push({ position: [m0, 0, zMid], scale: [run, 1, hz], data: [run, wrapU, vW, vL] }) // top run
      wrapInsts.push({ position: [m1, 0, zMid], scale: [1, 1, hz], data: [1, wrapU + run, vW, vL] }) // front nose
      bandInsts.push({ position: [m1, -BT, zMid], quaternion: qBack, scale: [run, 1, hz], data: [run, 2 * wrapU + run, vW, vL] }) // bottom return
      // the loop outline (x, y) the side caps trace — the same points the 4 fabric instances realize, ordered from
      // the seam under the back nose (the caps must silhouette the fabric exactly).
      var pts = []
      for (var k = 0; k <= WRAP; k++) { var a0 = Math.PI * (1 - k / WRAP); pts.push([m0 - Math.sin(a0) * PR, -PR + Math.cos(a0) * PR]) }
      pts.push([m1, 0])
      for (var k1 = 1; k1 <= WRAP; k1++) { var a1 = (Math.PI * k1) / WRAP; pts.push([m1 + Math.sin(a1) * PR, -PR + Math.cos(a1) * PR]) }
      pts.push([m0, -BT]) // bottom run back to the seam (the start point, duplicated)
      // SIDE CAPS (frame-metal): the outermost strip sides are flat full-slot walls embedded half a wall inside the
      // rail (mid-rail plane — never coplanar with the rail's inner face); interior sides are capsule-outline fans.
      capAt(capSfc, pts, i === 0, -1, i === 0 ? -(hw + FWT / 2) : zL, bX, fX, m0, m1)
      capAt(capSfc, pts, i === count - 1, 1, i === count - 1 ? hw + FWT / 2 : zR, bX, fX, m0, m1)
    }
    function capAt(s, pts, flat, sign, z, bX, fX, m0, m1) {
      if (flat) {
        // clipped to the splayed faces at the plate's OWN z, not the strip centre's: it hides inside the rail, which
        // ends on that face line (or is cut short of it at a merge), so running on to the strip's centreline face let
        // up to tan(splay) * half a strip of plate stand past the rail, into the frame of the conveyor it merges onto
        bX = Math.max(bX, backX(z)); fX = Math.min(fX, frontX(z))
        var c0 = s.vertex(bX, 0, z, 0, 0), c1 = s.vertex(fX, 0, z, fX - bX, 0)
        var c2 = s.vertex(fX, -BT, z, fX - bX, BT), c3 = s.vertex(bX, -BT, z, 0, BT)
        if (sign < 0) s.quad(c0, c1, c2, c3)
        else s.quad(c0, c3, c2, c1)
        return
      }
      // capsule fan: centre at the loop's midpoint, outline = the loop points (minus the duplicated seam).
      // The outline runs clockwise in XY (up the back nose first), so the +Z cap reverses each triangle.
      var ctr = s.vertex((m0 + m1) / 2, -PR, z, 0.5, 0.5)
      var ring = []
      for (var q = 0; q < pts.length - 1; q++) ring.push(s.vertex(pts[q][0], pts[q][1], z, pts[q][0], pts[q][1]))
      for (var t = 0; t < ring.length; t++) {
        var u2 = ring[t], v2 = ring[(t + 1) % ring.length]
        if (sign > 0) s.triangle(ctr, v2, u2)
        else s.triangle(ctr, u2, v2)
      }
    }
    var bed = { desc: bandSfc.build(), finish: 'belt', instances: bandInsts }
    var bedWraps = { desc: wrapSfc.build(), finish: 'belt', instances: wrapInsts }

    // 2. GAP-FILL PRISM (whiteish underbody) — a prism filling the splayed footprint under the belt, its angled
    // front/back faces standing in for the (absent) end rails. Recessed a shallow depth below the surface so it
    // fills the inter-strip gaps. The per-strip side caps (part 1) merge into this same white-metal MeshPart.
    var zi = Math.max(hw - 0.002, 0.005)
    var maxA = Math.max(Math.abs(tf), Math.abs(tb)) // tan of the larger splay
    var topY = -Math.max(0.001, (0.05 / Math.sqrt(1 + maxA * maxA)) / Math.cos(Math.PI / 3)) // 0.05·cos(angle)/cos60°
    var botY = RAIL_TOP - FH // frame bottom (−0.175 at the default height)
    // push the downstream face out one half-strip slope, under the staircase's tips - unless the front end is merged
    // onto another conveyor (a host-fed rail cut there): then it stays on the splay face, since at a steep splay the
    // pushed-out corner stood inside that conveyor's frame (3 mm at 60 degrees)
    var frontMerged = Array.isArray(p.railCuts) && p.railCuts.some(function (r) { return r[0] > 0 })
    var dsShift = frontMerged ? 0 : ((0.5 * w) / count) * Math.abs(tf)
    var gfSfc = g.surface()
    // per-face vertices (never shared between faces): the host averages normals over a vertex's triangles, so
    // sharing the 8 prism corners would round every edge into a soft glossy gradient.
    var T0 = [backX(-zi) + PR, topY, -zi], T1 = [backX(zi) + PR, topY, zi]
    var T2 = [frontX(zi) + dsShift, topY, zi], T3 = [frontX(-zi) + dsShift, topY, -zi]
    var B0 = [backX(-zi) + PR, botY, -zi], B1 = [backX(zi) + PR, botY, zi]
    var B2 = [frontX(zi) + dsShift, botY, zi], B3 = [frontX(-zi) + dsShift, botY, -zi]
    function gq(a, b, c, d) {
      gfSfc.quad(
        gfSfc.vertex(a[0], a[1], a[2], a[0], a[2]),
        gfSfc.vertex(b[0], b[1], b[2], b[0], b[2]),
        gfSfc.vertex(c[0], c[1], c[2], c[0], c[2]),
        gfSfc.vertex(d[0], d[1], d[2], d[0], d[2]),
      )
    }
    gq(T0, T1, T2, T3); gq(B0, B3, B2, B1) // top / bottom
    gq(T0, T3, B3, B0); gq(T1, B1, B2, T2) // back / front angled ends
    gq(T0, B0, B1, T1); gq(T3, T2, B2, B3) // −z / +z sides
    // finish 'gapfill' = white-tinted frame metal, distinct from the blue side rails ('frame').
    var gapFill = { desc: g.merge(gfSfc.build(), capSfc.build()), finish: 'gapfill' }

    // 3. SIDE FRAME RAILS (steel L-rails) — two straight rails along the ±Z edges (the splayed end faces carry no
    // frame), emitted as instances of the straight belt's 1 m unit-rail template (wall FH tall with top at
    // RAIL_TOP + outward flange lip; profile z local 0..0.03, outward = +z): size in scale.x, the −Z side placed
    // by running the SAME prism backwards under a 180° yaw. Never a z-mirror scale: a negative-determinant
    // instance matrix reverses the winding, and under DoubleSide three flips the shading normal by
    // gl_FrontFacing, so that rail is lit as if its outer face were the inner one (the renderer's frontFaceCW fix
    // reads object.matrixWorld, never the per-instance matrix). Gated by
    // src/render/parts/instanceMirror.test.ts. The template is
    // byte-identical to the belt conveyor's, so they share one pooled rail geometry. Each rail spans its edge's own
    // back→front X (the two rails offset by the shear = the parallelogram), unless a guardExtents row overrides its
    // ends — then the rail (and the guard + bolts that follow it) reaches the host's wall plane.
    var UNIT_X = [[0, 0, 0], [1, 0, 0]]
    // capped like the belt's, so the ends don't show as hollow tubes AND the template stays byte-identical to it
    var railTemplate = g.merge(
      g.sweep([[FB, 0], [FB, 0.01], [-0.005, 0.01], [-0.005, 0]], UNIT_X, { caps: true }),
      g.sweep([[-0.005, 0.01], [-0.005, 0.03], [0, 0.03], [0, 0.01]], UNIT_X, { caps: true }),
    )
    var extRows = Array.isArray(p.guardExtents) ? p.guardExtents : []
    var railInsts = []
    var railRuns = []
    var railCutAt = railCutLookup(p)
    var spurRails = spurRailCutter(g, hw, FWT, FB, railCutAt)
    var railFills = spurRails.railFills, cutRailInstance = spurRails.cutRailInstance
    for (var s = 0; s < 2; s++) {
      var sign = s === 0 ? -1 : 1, zEdge = sign * hw
      var bE = backX(zEdge), fE = frontX(zEdge)
      for (var xr = 0; xr < extRows.length; xr++) if (extRows[xr][0] === sign) { bE = extRows[xr][1]; fE = extRows[xr][2] }
      var cx = (bE + fE) / 2, len = Math.max(fE - bE, 0.01)
      railRuns.push({ sign: sign, cx: cx, len: len })
      // an end merged onto another conveyor is CUT to fit against that one's frame (_shared/guardMitre.js)
      railInsts.push(cutRailInstance(sign, bE, fE))
    }
    var frame = { desc: railTemplate, finish: 'frame', instances: railInsts }

    // 4. SIDE GUARDS (steel walls just outside each rail, independently toggled). leftGuard = −Z, rightGuard = +Z.
    // Each side is its own collision:'box' MeshPart so the host's AABB-box collider is a thin side wall (a
    // single merged part would hull the whole width, blocking cargo on the bed).
    var guardParts = []
    // MITRED ENDS (_shared/guardMitre.js): where a guard meets the guard of the conveyor this spur merges onto,
    // its end is cut on the plane the two share instead of square, so neither runs through the other
    var mitreAt = mitreLookup(p)
    var holes = Array.isArray(p.guardHoles) ? p.guardHoles : []
    var holePanels = {} // hole height → where its panels go
    for (var s2 = 0; s2 < 2; s2++) {
      var g_sign = s2 === 0 ? -1 : 1
      var on = g_sign < 0 ? p.leftGuard !== false : p.rightGuard !== false
      if (!on) continue
      var run = railRuns[s2 === 0 ? 0 : 1]
      // GUARD GAPS (host-fed rows [x0, x1, side], _shared/guardGaps.js): where the host opens this guard, for a
      // diverter whose arms cross it. Each solid run between gaps is its own collision part, so the collider stops
      // at the gap as the mesh does. With no gap there is one run, the whole guard.
      var gRuns = guardGapRuns(p, g_sign, run.cx - run.len / 2, run.cx + run.len / 2)
      for (var gr = 0; gr < gRuns.length; gr++) {
        // SENSOR-BEAM HOLES (host-fed rows [x, y, side], guardHoles.ts): the sheet is split around a panel-long gap
        // at each hole inside this guard's run, and a sheet panel with the hole cut through fills it (the top return
        // below runs on unbroken over it). A run's pieces stay ONE collision part, so its AABB collider is the same
        // whole wall; the sim never sees the holes anyway.
        var gLo = gRuns[gr][0], gHi = gRuns[gr][1], gCuts = []
        for (var hi = 0; hi < holes.length; hi++) {
          var hrow = holes[hi], h0 = hrow[0] - HOLE_PANEL / 2, h1 = hrow[0] + HOLE_PANEL / 2
          if (hrow[2] !== g_sign || h0 < gLo || h1 > gHi) continue
          gCuts.push([h0, h1])
          var hKey = hrow[1].toFixed(4)
          if (!holePanels[hKey]) holePanels[hKey] = { y: hrow[1], descs: [] }
          // the panel's frame: outward +z from the sheet's inner face; the −Z side is it yawed 180°, never mirrored
          holePanels[hKey].descs.push({ x: hrow[0], sign: g_sign })
        }
        gCuts.sort(function (a, b) { return a[0] - b[0] })
        var gPieces = [], gCur = gLo
        for (var gc = 0; gc < gCuts.length; gc++) { if (gCuts[gc][0] - gCur > 1e-4) gPieces.push([gCur, gCuts[gc][0]]); gCur = Math.max(gCur, gCuts[gc][1]) }
        if (gHi - gCur > 1e-4) gPieces.push([gCur, gHi])
        var gboxes = gPieces.map(function (pc) { return guardBand(g, pc[0], pc[1], mitreAt(g_sign, pc[0]), mitreAt(g_sign, pc[1]), 0, GT, RAIL_TOP, GH, g_sign, hw + FWT) })
        if (gboxes.length) guardParts.push({ desc: gboxes.length === 1 ? gboxes[0] : g.merge.apply(g, gboxes), finish: 'guard', collision: 'box', sideGuard: g_sign < 0 ? 'left' : 'right' })
        // the guard's formed top: a 20 mm OUTWARD return along its top edge (as every conveyor guard has). Its own
        // part with NO collision: the host's collider is this guard part's AABB, and the return would widen it off
        // the one guard cross-section every family shares - the one butted guards merge on (core/guardRuns.ts).
        var lip = guardBand(g, gLo, gHi, mitreAt(g_sign, gLo), mitreAt(g_sign, gHi), GT, GT + 0.02, GH - GT, GH, g_sign, hw + FWT)
        guardParts.push({ desc: lip, finish: 'guard' })
      }
    }

    // 5. SUPPORT LEGS — real floor supports (_shared/legs.js), built leg-local with their floor at
    // −standHeight and placed at both ends of the bed. standHeight is host-filled (rest:'surfaceBelow') so the feet reach the floor.
    var standH = typeof p.standHeight === 'number' && p.standHeight > 0 ? p.standHeight : 0.75
    var FLOOR_Y = -standH
    // Every support piece is a box → instances of one unit cube (size in scale), so all the leg
    // hardware in the scene draws as one pooled bank.
    var legInsts = []
    // HEX bolt heads — instances of the belt conveyor's unit hex prism template (flat-topped, radius 1 in XY,
    // depth 1 along Z, centred): axis 'z' = identity (wall / sleeve / clamp bolts), 'y' = a +90° X-rotation laying
    // the prism axis along +Y. r/depth live in each instance's scale.
    var hexSfc = g.surface()
    var hexF = [], hexB = []
    for (var hk = 0; hk < 6; hk++) {
      var ha = (hk / 6) * Math.PI * 2 + Math.PI / 6 // flat-topped
      var hu = Math.cos(ha), hwv = Math.sin(ha)
      hexF.push(hexSfc.vertex(hu, hwv, 0.5))
      hexB.push(hexSfc.vertex(hu, hwv, -0.5))
    }
    for (var hk = 1; hk < 5; hk++) { hexSfc.triangle(hexF[0], hexF[hk], hexF[hk + 1]); hexSfc.triangle(hexB[0], hexB[hk + 1], hexB[hk]) } // caps
    for (var hk = 0; hk < 6; hk++) { var hk2 = (hk + 1) % 6; hexSfc.quad(hexF[hk], hexB[hk], hexB[hk2], hexF[hk2]) } // sides
    var hexTemplate = hexSfc.build()
    var hexInsts = []
    function hexAt(cx, cy, cz, r, depth, axis) {
      var inst = { position: [cx, cy, cz], scale: [r, r, depth] }
      if (axis === 'y') inst.quaternion = [0.7071067811865476, 0, 0, 0.7071067811865476] // rotX(+90°): z-depth → +Y
      hexInsts.push(inst)
    }
    function legAt(x0, height, dir) {
      var pc = legPieces(hw, height, dir, -botY)
      for (var i = 0; i < pc.boxes.length; i++) {
        var b = pc.boxes[i], inst = { position: [b[0] + x0, b[1] + FLOOR_Y, b[2]], scale: [b[3], b[4], b[5]] }
        if (b[6]) inst.quaternion = [0, 0, Math.sin(b[6] / 2), Math.cos(b[6] / 2)]
        legInsts.push(inst)
      }
      for (var j = 0; j < pc.bolts.length; j++) { var t = pc.bolts[j]; hexAt(t[0] + x0, t[1] + FLOOR_Y, t[2], t[3], t[4], t[5]) }
    }
    // the x range where the assembly spans both side rails
    var xMin = -L / 2 + Math.abs(tb) * hw, xMax = L / 2 - Math.abs(tf) * hw, legSpan = xMax - xMin
    // supports at both ends of it (a real spur is carried at its discharge as well as its infeed) and on the
    // bed-joint pitch between, their knee braces leaning toward the middle; a span too short for two gets one.
    var lh = standH + FB
    if (legSpan > 0.1 && lh > 0.05) {
      var lx0 = xMin + LEG_END_INSET, lx1 = xMax - LEG_END_INSET, mid = (xMin + xMax) / 2
      if (lx1 - lx0 < LEG_CLEARANCE) legAt(mid, lh, 0)
      else {
        // knee braces only where the two ends are far enough apart that theirs don't meet mid-span
        var kd = lx1 - lx0 >= 1.4 ? 1 : 0
        legAt(lx0, lh, kd); legAt(lx1, lh, -kd)
        var nMid = Math.ceil((lx1 - lx0) / LEG_SPACING) - 1
        for (var mi = 1; mi <= nMid; mi++) { var mx = lx0 + (mi * (lx1 - lx0)) / (nMid + 1); legAt(mx, lh, kd * (mx <= mid ? 1 : -1)) }
      }
    }
    var legs = legInsts.length ? { desc: g.box([1, 1, 1], [0, 0, 0]), finish: 'leg', instances: legInsts } : null

    // 6. FRAME WEB-BOLTS — vertical hex bolt pairs every ~1.2 m down each rail's mid-wall, into the same 'bolt'
    // instance bank as the leg bolts. Centred on the wall, the pair closing up on a shallow one so both heads stay 3 mm
    // inside it (the default belt keeps its 0.04); floored above 0 because the pair loop steps by 2 * bGap.
    var yMid = (RAIL_TOP + FB) / 2, br = 0.012, bH = 0.01
    var bGap = Math.max(0.001, Math.min(0.04, RAIL_TOP - 0.003 - br - yMid, yMid - br - 0.003 - FB))
    for (var ri = 0; ri < railRuns.length; ri++) {
      var run2 = railRuns[ri], bZ = run2.sign * (hw + 0.013), nB = Math.max(2, Math.round(run2.len / 1.2))
      for (var bi2 = 0; bi2 < nB; bi2++) {
        var bx = run2.cx - run2.len / 2 + ((bi2 + 0.5) / nB) * run2.len
        for (var bd = -bGap; bd <= bGap; bd += 2 * bGap) hexAt(bx, yMid + bd, bZ, br, bH, 'z')
      }
    }
    var bolts = hexInsts.length ? { desc: hexTemplate, finish: 'bolt', instances: hexInsts } : null

    var parts = [bed, bedWraps, gapFill, frame]
    for (var gp = 0; gp < guardParts.length; gp++) parts.push(guardParts[gp])
    if (legs) parts.push(legs)
    if (bolts) parts.push(bolts)
    // hole panels LAST (they come and go with the sensors in the scene; the host reconciles banks by index), one
    // part per hole height. VISUAL ONLY: no collision.
    Object.keys(holePanels).sort().forEach(function (k) {
      var base = holePanel(g, holePanels[k].y, false)
      var placed = holePanels[k].descs.map(function (d) {
        return d.sign > 0
          ? g.transform(base, { translate: [d.x, 0, hw + FWT] })
          : g.transform(base, { rotate: [0, 1, 0, 0], translate: [d.x, 0, -(hw + FWT)] })
      })
      parts.push({ desc: placed.length === 1 ? placed[0] : g.merge.apply(g, placed), finish: 'guard' })
    })
    // the rail-end fills after them, for the same reason: they come and go with the junction
    if (railFills.length) parts.push({ desc: g.merge.apply(g, railFills), finish: 'frame' })
    return parts
  },
  react(ctx) {
    // Tag precedence: speedTag (REAL in) replaces the speed param; runTag (BOOL) gates the commanded speed to 0
    // only while a controller DRIVES it (ctx.tagDriven — undriven, the authored speed rules); runningTag (BOOL out)
    // = effective speed ≠ 0.
    // the unit the conveyor is set up in: everything below this line is m/s
    const cmd = commandedSpeed(ctx)
    const fpm = cmd.fpm, commanded = cmd.commanded
    const running = ctx.tagDriven(ctx.params.runTag) ? ctx.readTag(ctx.params.runTag) : true
    const s = rampedSpeed(ctx, drive, cmd, running ? commanded : 0)
    // the readout the Inspector shows for 'speed' while a setpoint tag owns it: the EFFECTIVE value,
    // gates and all, not the raw setpoint (a runTag holding this at 0 must not read as the commanded rate)
    reportSpeed(ctx, fpm, s)
    if (ctx.params.runningTag) ctx.writeTag(ctx.params.runningTag, s !== 0)
    // drive feedback: the velocity as a share of the speed at 30, an encoder pulse and the odometer
    publishDrive(ctx, drive, cmd, s)
    ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
    // the next tick is needed only while the drive ramps or counts travel (conveyorDrive.js)
    driveAgain(ctx, drive, running ? commanded : 0)
  },
})
