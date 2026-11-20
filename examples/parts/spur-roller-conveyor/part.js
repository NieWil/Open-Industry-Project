// Spur Roller Conveyor — a splayed merge roller bed (geometry-function tier). Its deck is a
// parallelogram of spinning rollers clipped to independent front/back splay faces, framed by straight L-rails +
// side guards + a trestle leg. The steel is emitted as instanced templates (MeshPart.instances) sharing the unit
// templates (and pool buckets) the straight belt and belt spur use; only the two collision guard walls stay
// per-part meshes. The behavior is a straight roller conveyor's: step(ctx) drives the surface velocity along the
// flow axis (+X) at the set speed and the host both carries cargo on the flat deck and spins each roller about its
// own axle. A negative speed reverses; a PLC comms trio gates/commands it. The rollers are clipped to the front/back
// splay faces, each end roller shortened to the bevel (the per-instance roller `length`). Centred on the origin so the
// host's flat conveying deck (length×width) lines up under the rollers.
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
import { rollerBandMaterial, rollerBed } from '../_shared/rollerBed.js'
import { frameBottom, frameHeightParam } from '../_shared/rollerFrame.js'

// the baked footprint of the default 2 m / 1.524 m / 30° spur: length + front-splay reach
const OUTER = 2 + Math.tan((30 * Math.PI) / 180) * 1.524

const drive = conveyorDrive() // the ramp, the pulse and the encoder, remembered between steps

definePart({
  manifest: {
    id: 'oip.spur-roller-conveyor',
    name: 'Spur Roller Conveyor',
    category: 'Equipment',
    conveyor: { bed: 'spur', surface: 'roller', speedParam: 'speed', frictionParam: 'friction' },
    // `conveys` makes it a powered surface (the sim builds the flat length×width deck)
    geometry: { kind: 'drawn', bounds: { length: OUTER, width: 1.524, top: 2.3 }, conveys: true },
    // the drive bands' urethane
    materials: [rollerBandMaterial('band')],
  },
  params: {
    // The length handle's angleFrontParam/angleBackParam mark this part a spur to the host (angled snap ends,
    // parallelogram footprint/deck, host guard opening + host-fed guardExtents). No sideGap override: this bed
    // ends flush at its splayed face (no end drum, and the roller stubs protrude in Z, not X), so the default
    // 2x-frame-flange junction clearance is all it needs — same as the belt spur.
    length: { type: 'number', default: 2, min: 0.5, step: 0.1, label: 'Length (m)', group: 'Size', handle: { kind: 'face', axis: 'x', angleFrontParam: 'angleFrontDeg', angleBackParam: 'angleBackDeg' }, desc: 'Bed length along travel, measured down the centreline. The end faces stay splayed at the angles below as it grows, so the short side and long side keep their difference.' },
    width: { type: 'number', default: 1.524, min: 0.2, step: 0.05, label: 'Width (m)', group: 'Size', handle: { kind: 'face', axis: 'z' }, desc: 'Bed width across travel. Drag the dot on either side face to resize in the viewport.' },
    ...frameHeightParam('Size'),
    ...speedUnitParams(1),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 1, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'Surface speed carried along the bed. Negative runs it backwards, which is the ONLY way to reverse flow - rotating the part 180 degrees moves its ends and their splay instead. A program can command this through the speed tag below.' },
    ...driveRampParams(0.2, 0.2),
    ...frictionParam(0.42),
    angleFrontDeg: { type: 'number', default: 30, min: -60, max: 60, step: 1, label: 'Front angle (°)', group: 'Ends', desc: 'Splay angle of the DISCHARGE end face. This is what makes the part a spur: an angled face merges flush onto the side of a straight conveyor instead of butting square against it. 0 leaves the end square.' },
    angleBackDeg: { type: 'number', default: 0, min: -60, max: 60, step: 1, label: 'Back angle (°)', group: 'Ends', desc: 'Splay angle of the INFEED end face. Leave it at 0 for a spur fed square from behind; angle it too when the piece has to sit between two angled neighbours.' },
    rollerClass: {
      type: 'enum', default: 'light', label: 'Roller class', group: 'Size',
      desc: 'Duty rating, which sets how thick the rollers are and how closely they are pitched: light 24 mm at 75 mm centres, medium 30 at 100, heavy 40 at 130. Heavier rollers sit further apart, so small product needs the lighter class to stay supported.',
      options: [{ value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'heavy', label: 'Heavy' }],
    },
    leftGuard: { type: 'boolean', default: true, label: 'Left guard', group: 'Guards', desc: 'Guard wall down the left side, looking along travel. A real barrier, so turning it off lets cargo leave the bed sideways - which on a spur is usually the point.' },
    rightGuard: { type: 'boolean', default: true, label: 'Right guard', group: 'Guards', desc: 'Guard wall down the right side, looking along travel. A real barrier, so turning it off lets cargo leave the bed sideways.' },
    // sensor-beam holes as [x m, y m, side ±1] rows: bed-local X (centre-origin), height above the deck, side −1
    // left / +1 right. HOST-FED (core/guardHoles.ts works them out from the scene's beams), so hidden.
    guardHoles: { type: 'numberList', arity: 3, default: [], hidden: true, label: 'Guard holes [x m, y m, side ±1]', group: 'Guards', desc: 'Where sensor beams cross the side guards. Worked out by the host from the scene; not for editing.' },
    // rail/guard end overrides as [side ±1, backX m, frontX m] rows (local centre-origin X). Normally host-fed:
    // at a side merge the host folds in the snap-derived extents so rails + guards reach the host's wall plane.
    guardExtents: { type: 'numberList', hidden: true, arity: 3, default: [], label: 'Rail extents [side ±1, back m, front m]', group: 'Guards', desc: 'Where the rails and guards STOP on each side, in bed-local X. Normally written by the host: when this spur merges flush onto another conveyor, this retracts the rails to its outer wall instead of running them through its frame. Worked out by the host from the scene; not for editing.' },
    // mitred guard ends as [x m, c, side ±1] rows (_shared/guardMitre.js). HOST-FED at a side merge, so hidden.
    ...guardMitresParam('Guards'),
    ...guardGapsParam('Guards'),
    ...railCutsParam('Guards'),
    // deck height above the floor — drives the LEG length; host auto-fills it from the surface beneath at drop/snap.
    standHeight: { type: 'number', default: 2.0, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the conveyor, so the legs reach the floor - or a platform crossing underneath - without you measuring. Pin it by hand when you want a deliberate height.' },
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands surface speed here, replacing the Speed field above, which then shows the live value read-only. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0 - so a half-wired conveyor sits still rather than running at its authored speed.' },
    ...speedFpmTagParam('Comms'),
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (rollers run while true)', group: 'Comms', desc: 'Start/stop gate: false forces the speed to 0 whatever the setpoint says. Unlike the speed tag, this only takes effect once a program actually DRIVES it, so binding it alone will not stop the bed.' },
    runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Running tag (true while moving)', group: 'Comms', desc: 'Feedback the conveyor publishes for the program to read: true whenever it is actually moving. This is the EFFECTIVE speed, gates included, so a run tag holding it at zero reads false here.' },
    ...driveFeedbackParams(1, 'Comms'),
  },
  // Procedural geometry — the full spur roller as multi-material MeshPart[]: a splay-clipped roller bank
  // (render-only spinning cylinders) + straight steel L-rails + toggleable side guards + a tail trestle leg +
  // hex bolts. Centred on the origin (x ∈ [−L/2, L/2]); no belt bed / gap fill.
  geometry(g, p) {
    var DEG = Math.PI / 180
    var L = typeof p.length === 'number' && p.length > 0 ? p.length : 2
    var w = typeof p.width === 'number' && p.width > 0 ? p.width : 1.524
    var hw = w / 2
    var tf = Math.tan((typeof p.angleFrontDeg === 'number' ? p.angleFrontDeg : 30) * DEG)
    var tb = Math.tan((typeof p.angleBackDeg === 'number' ? p.angleBackDeg : 0) * DEG)
    // roller class → [radius, centre-to-centre pitch], m.
    var CLASS = { light: [0.024, 0.075], medium: [0.03, 0.1], heavy: [0.04, 0.13] }
    var cls = CLASS[p.rollerClass] || CLASS.light
    var R = cls[0], PITCH = cls[1]
    var RAIL_TOP = -0.005, FB = frameBottom(p), FWT = 0.01, FFW = 0.02, FFT = 0.005, GH = 0.15, GT = 0.005
    var RAIL_INSET = 0.005, CAP_INSET = 0.01
    function frontX(z) { return L / 2 + tf * z }
    function backX(z) { return -L / 2 + tb * z }
    // z-span of a roller at local x, clipped to the splayed end faces, inset off the rails.
    function clipAtX(x) {
      var zMin = -hw + RAIL_INSET, zMax = hw - RAIL_INSET
      if (Math.abs(tf) > 1e-6) { var zf = (x - L / 2) / tf; if (tf > 0) zMin = Math.max(zMin, zf); else zMax = Math.min(zMax, zf) }
      else if (x > L / 2) return null
      if (Math.abs(tb) > 1e-6) { var zb = (x + L / 2) / tb; if (tb > 0) zMax = Math.min(zMax, zb); else zMin = Math.max(zMin, zb) }
      else if (x < -L / 2) return null
      zMin += CAP_INSET; zMax -= CAP_INSET
      return zMax - zMin > 0.02 ? { zMin: zMin, zMax: zMax } : null
    }

    // 1. ROLLER BANK (render-only, spinning; _shared/rollerBed.js) — a grid at the class pitch along +X, each
    // roller clipped to the splay: centred at its clip mid-z with its own length = the clipped span, so the end
    // rollers shorten to the bevelled face. yaw 0 (axle along +Z); each spins about its own axle at the bed speed.
    var insts = []
    var maxReach = Math.abs(tf) * hw + Math.abs(tb) * hw
    var xLo = -L / 2 - maxReach, xHi = L / 2 + maxReach
    var n0 = Math.ceil(xLo / PITCH)
    for (var k = n0; k * PITCH <= xHi + 1e-6; k++) {
      var x = k * PITCH
      var clip = clipAtX(x)
      if (!clip) continue
      insts.push({ x: x, z: (clip.zMin + clip.zMax) / 2, yaw: 0, length: clip.zMax - clip.zMin })
    }
    var stubR = R * 0.34, STUB_PROT = 0.02, STUB_ANCHOR = 0.015
    // drive bands: an O-ring chaining each roller to the next at the +Z end, alternating two grooves measured in from
    // the unclipped roller end (so a splay-shortened end roller that doesn't reach the grooves carries none). Cord
    // and groove spacing scale with the roller class's radius (the kit's defaults).
    var bands = { zWall: hw - RAIL_INSET - CAP_INSET }
    // axles at y = -R (the tube tops are the conveying plane); a full roller's stubs sit centred stubOff out from the
    // bed centreline, through the frame wall, and a splay-shortened roller's follow its clipped ends the same way
    var stubOff = hw + (FWT + STUB_PROT - STUB_ANCHOR) / 2, axle = w - 0.004
    var rollers = rollerBed(g, insts, { radius: R, y: -R, stub: { radius: stubR, length: FWT + STUB_PROT + STUB_ANCHOR, protrude: stubOff - axle / 2 }, bands: bands, fullAxle: axle })

    // 2. SIDE FRAME RAILS (steel L-rails) — two straight rails along the ±Z edges (the splayed ends carry no
    // frame), emitted as instances of the straight belt's 1 m unit-rail template (wall + outward flange lip;
    // profile z local 0..0.03, outward = +z): size in scale.x, the −Z side placed by running the SAME prism
    // backwards under a 180° yaw. Never a z-mirror scale: a negative-determinant instance matrix reverses the
    // winding, and under DoubleSide three flips the shading normal by gl_FrontFacing, so that rail is lit as if
    // its outer face were the inner one (the renderer's frontFaceCW fix reads object.matrixWorld, never the
    // per-instance matrix). Gated by src/render/parts/instanceMirror.test.ts. The template is byte-identical to the belt conveyor's, so
    // they share one pooled rail geometry. Each rail spans its edge's own back→front X (offset by the shear = the
    // parallelogram), unless a host-fed guardExtents row overrides its ends at a side merge (rails/guards/bolts
    // reach the host wall).
    var UNIT_X = [[0, 0, 0], [1, 0, 0]]
    // capped like the belt's, so the ends don't show as hollow tubes AND the template stays byte-identical to it
    // (FB is rounded the way the belt's is, so a spur whose Frame height matches a belt's Frame height shares its rail)
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

    // 3. SIDE GUARDS (steel walls just outside each rail, independently toggled). Each side is its own
    // collision:'box' MeshPart so the host's AABB-box collider is a thin side wall (not the full width).
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

    // 4. SUPPORT LEGS — real floor supports (_shared/legs.js) at both ends of the bed.
    // standHeight is host-filled (rest:'surfaceBelow') so the feet reach the floor.
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
      var pc = legPieces(hw, height, dir, -FB)
      for (var i = 0; i < pc.boxes.length; i++) {
        var b = pc.boxes[i], inst = { position: [b[0] + x0, b[1] + FLOOR_Y, b[2]], scale: [b[3], b[4], b[5]] }
        if (b[6]) inst.quaternion = [0, 0, Math.sin(b[6] / 2), Math.cos(b[6] / 2)]
        legInsts.push(inst)
      }
      for (var j = 0; j < pc.bolts.length; j++) { var t = pc.bolts[j]; hexAt(t[0] + x0, t[1] + FLOOR_Y, t[2], t[3], t[4], t[5]) }
    }
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

    // 5. FRAME WEB-BOLTS — vertical hex bolt pairs every ~1.2 m down each rail's mid-wall, into the same
    // 'bolt' instance bank as the leg bolts.
    // the pair closes up on a shallow wall so both heads stay 3 mm inside it; the default frame keeps its 0.04.
    // Floored above 0: the pair loop below steps by 2 * bGap.
    var yMid = (RAIL_TOP + FB) / 2, br = 0.012, bH = 0.01
    var bGap = Math.max(0.001,Math.min(0.04, RAIL_TOP - 0.003 - br - yMid, yMid - br - 0.003 - FB))
    for (var ri = 0; ri < railRuns.length; ri++) {
      var run2 = railRuns[ri], bZ = run2.sign * (hw + 0.013), nB = Math.max(2, Math.round(run2.len / 1.2))
      for (var bi2 = 0; bi2 < nB; bi2++) {
        var bx = run2.cx - run2.len / 2 + ((bi2 + 0.5) / nB) * run2.len
        for (var bd = -bGap; bd <= bGap; bd += 2 * bGap) hexAt(bx, yMid + bd, bZ, br, bH, 'z')
      }
    }
    var bolts = hexInsts.length ? { desc: hexTemplate, finish: 'bolt', instances: hexInsts } : null

    var parts = rollers.concat([frame])
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
    // Tag precedence: speedTag (REAL in) replaces the speed param; runTag (BOOL) gates to 0 only while a
    // controller DRIVES it (ctx.tagDriven — undriven, the authored speed rules); runningTag (BOOL out) = effective
    // speed ≠ 0. This drives the flat conveying deck; the host spins the rollers from the same commanded speed.
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
