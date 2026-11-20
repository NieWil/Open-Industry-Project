// Safety Gate — a swinging interlock gate: a black wire-mesh leaf carrying a red e-stop handle, hinged at the
// -X post between yellow posts, swinging to 'openAngle' at 'openSpeed' (°/s). A safety interlock switch on the
// latch post takes an actuator on the leaf when it's shut (the look of one; the signal is the 'open' state below).
// Demonstrates procedural geometry on a MOVING link — geometry() emits the posts/caps on the rig root and tags the leaf mesh to the swinging
// 'hinge' frame (MeshPart.link), so it rides the joint; the hidden 'leaf' box is the collision. A PLC input
// (safety-door switch): it writes 'open XOR normallyClosed' and never reads a tag.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { mesh, hex, anchor } from '../_shared/hardware.js'

const D2R = Math.PI / 180
let angle = 0 // current swing angle (rad)
let flip = false // viewport Use toggles: XORed with the authored 'open' param
// the rig's dimensions (m); geometry() keeps its own copies of the ones it draws with
const GATE_H = 2.0 // gate/fence height
const GATE_POST = 0.06 // post cross-section
const GATE_GAP = GATE_POST * 0.5 + 0.01 // leaf-to-post gap (0.04 m)
const INTERACT_DEPTH = 0.3 // depth of the full-span Use/pick slab

definePart({
  manifest: {
    id: 'oip.safety-gate',
    name: 'Safety Gate',
    category: 'Structure',
    // End-to-end chaining (declarative SnapChain, docs/part-snap-chain.md): the gate butts into a fence run or
    // corners with one, sharing the corner post via the omitPost* handshake. Group 'barrierFence' is shared with
    // the Fence - a gate is a door IN a fence line - at the fence family's tight 1 m reach.
    snap: { chain: { group: 'barrierFence', lengthParam: 'length', reach: 1, omitStartParam: 'omitPostStart', omitEndParam: 'omitPostEnd' } },
    // each static color is only a seed - the submesh's colorParam repaints it live from its param
    materials: [
      { id: 'postMetal', color: [0.949, 0.741, 0.059], metalness: 0.1, roughness: 0.45 },
      { id: 'meshMetal', color: [0.05, 0.05, 0.05], metalness: 0.4, roughness: 0.5 },
      { id: 'handleMetal', color: [0.788, 0.09, 0.09], metalness: 0.2, roughness: 0.4 },
    ],
  },
  interactive: true,
  useParam: 'open', // the hand state is the param: the state a run starts from. The Inspector sets it; Use never writes it
  joints: ['swing'],
  params: {
    length: { type: 'number', default: 1, min: 0.5, max: 6, step: 0.05, label: 'Width (m)', desc: 'Gate width, hinge post to latch post. Size it to the gap you are closing in the fence line.' },
    open: { type: 'boolean', default: false, label: 'Open', group: 'Start state', desc: 'Swing the leaf open. This is the state it starts in; Use swings it by hand, which is how someone in pilot mode walks through the guard line.' },
    openAngle: { type: 'number', default: 110, min: -180, max: 180, step: 1, label: 'Open angle (°)', desc: 'How far the leaf swings about the hinge when open. Negative angles swing it the other way, for a gate that has to open into the aisle.' },
    openSpeed: { type: 'number', default: 180, min: 10, max: 720, step: 5, label: 'Open speed (°/s)', desc: 'How fast the leaf travels between shut and the open angle.' },
    normallyClosed: { type: 'boolean', default: false, label: 'Normally closed (inverts the signal)', desc: 'Invert the signal this gate publishes, so the tag reads true while the gate is SHUT - the safety convention, where a broken wire and an open gate look the same to the program. Affects the tag only, never the visuals.' },
    postColor: { type: 'color', default: '#f2bd0f', label: 'Post color', group: 'Colors', desc: 'Post tint.' },
    meshColor: { type: 'color', default: '#0d0d0d', label: 'Mesh color', group: 'Colors', desc: 'Tint of the leaf frame and the panel it holds.' },
    handleColor: { type: 'color', default: '#c91717', label: 'Handle color', group: 'Colors', desc: 'Tint of the emergency release handle.' },
    omitPostStart: { type: 'boolean', default: false, label: 'Omit start post', group: 'Posts', desc: 'Suppress the post at local -X so a snapped neighbour draws the shared one instead. Snapping sets this for you.' },
    omitPostEnd: { type: 'boolean', default: false, label: 'Omit end post', group: 'Posts', desc: 'Suppress the post at local +X so a snapped neighbour draws the shared one instead. Snapping sets this for you.' },
    tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Gate signal tag', group: 'Comms', desc: 'Where the gate publishes its state for the program to read. Whether true means open or shut is set by Normally closed above.' },
  },
  // A revolute hinge + a hidden collision-only leaf box; the visible mesh comes from geometry().
  rig(p) {
    return {
      links: [
        { name: 'hinge', shape: { kind: 'frame' }, offset: [-p.length / 2, 0, 0] },
        // the swinging leaf - the only collision barrier; hidden (geometry() draws its wire mesh on the hinge link).
        // Centred at the part origin when closed (hinge −length/2 + leaf +length/2), box y-centre GATE_H/2.
        {
          name: 'leaf',
          parent: 'hinge',
          shape: { kind: 'box', size: [p.length - 2 * GATE_GAP, GATE_H, GATE_POST] },
          offset: [p.length / 2, GATE_H / 2, 0],
          hidden: true,
        },
        // full-span Use/pick volume on the root (it never swings), so you can still aim at the opening when the leaf
        // has swung away. hidden = not drawn but still raycastable; collision: 'none' = cargo passes the open gap.
        { name: 'interact', shape: { kind: 'box', size: [p.length, GATE_H, INTERACT_DEPTH] }, offset: [0, GATE_H / 2, 0], hidden: true, collision: 'none' },
      ],
      joints: [{ name: 'swing', link: 'hinge', type: 'revolute', axis: [0, 1, 0], min: -3.15, max: 3.15 }],
      bounds: { length: 1, width: 0.2, top: GATE_H },
    }
  },
  geometry(g, p) {
    var length = typeof p.length === 'number' && p.length > 0 ? p.length : 1
    var omitStart = p.omitPostStart === true
    var omitEnd = p.omitPostEnd === true
    // fixed dimensions (m)
    var H = 2.0, POST = 0.06, GAP = 0.04, INSET = 0.08
    var FRAME = 0.03, WIRE = 0.008, SPACING = 0.1, CAP_H = 0.03, CAP_FP = POST * 1.08
    // the pull handle, one each face: a round bar BAR_R in radius bent at BEND_R into a D standing STANDOFF off the
    // leaf's centre plane, its legs LEG_IN in from the ends of a PLATE_X x PLATE_Y mounting plate PLATE_Z thick
    // (thicker than the wires it clamps, thinner than the frame bar), each foot on a round-ish ROSETTE
    var BAR_R = 0.011, BEND_R = 0.028, STANDOFF = 0.068, LEG_IN = 0.035, HANDLE_H = 1.0, ROSETTE = 0.03, ROSETTE_T = 0.004
    var PLATE_X = 0.22, PLATE_Y = 0.1, PLATE_Z = 0.022
    // the safety INTERLOCK on the latch post, SWITCH_UP above the handle: a switch body on the post's +Z face and
    // a head that overhangs toward the leaf, which the leaf's ACTUATOR tongue enters when the gate is shut. The
    // leaf swings open toward -Z (a positive angle about +Y), so the head on the +Z side is never in its path.
    var SWITCH_UP = 0.24, SW_W = 0.045, SW_H = 0.1, SW_D = 0.034, HEAD_W = 0.07, HEAD_H = 0.042, ACT_T = 0.006
    // post hardware, the SAME numbers and clamp heights as the Fence (examples/parts/fence/part.js) so a gate in a
    // fence line matches it: a floor plate under each post and a collar round it at each clamp height. On the hinge
    // side the leaf's straps run into those collars as its hinges; the swing axis is the post's own centreline, so
    // a strap's inner end stays inside the collar at every angle.
    var FOOT = 0.12, FOOT_T = 0.01, COLLAR = POST + 0.012, COLLAR_H = 0.05, STRAP_H = 0.04, STRAP_T = 0.012
    var CLAMP_IN = 0.2, SINK = 0.005, ANCHOR_IN = 0.043, ANCHOR_AF = 0.016
    // hinge KNUCKLES: a hex barrel on the leaf stacked just above and below each hinge-side collar, round the swing
    // axis (the post's centreline), so it turns with the leaf like a real hinge's leaf-side knuckle. KNUCKLE_AF
    // keeps the flats clear of the square post's corners (half-diagonal 0.042) at any angle.
    var KNUCKLE_AF = 0.09, KNUCKLE_H = 0.035, KNUCKLE_GAP = 0.003
    var box = function (cx, cy, cz, sx, sy, sz) { return g.box([sx, sy, sz], [cx, cy, cz]) }
    var hl = length / 2
    var posts = [], caps = [], leaf = [], handle = []
    var rootHw = mesh(g), leafHw = mesh(g) // anchors on the root; knuckles on the swinging hinge link
    var yb = INSET, yt = H - INSET
    var clampYs = yt - yb > CLAMP_IN * 3 ? [yb + CLAMP_IN, yt - CLAMP_IN] : [(yb + yt) / 2]

    // omit an end post where a snapped corner neighbour supplies it (its own collars stand at the same heights)
    var post = function (x) {
      posts.push(box(x, H / 2, 0, POST, H, POST), box(x, FOOT_T / 2, 0, FOOT, FOOT_T, FOOT))
      caps.push(box(x, H + CAP_H / 2, 0, CAP_FP, CAP_H, CAP_FP))
      for (var c = 0; c < clampYs.length; c++) caps.push(box(x, clampYs[c], 0, COLLAR, COLLAR_H, COLLAR))
      for (var ax = -1; ax <= 1; ax += 2) for (var az = -1; az <= 1; az += 2) anchor(rootHw, x + ax * ANCHOR_IN, FOOT_T, az * ANCHOR_IN, ANCHOR_AF)
    }
    if (!omitStart) post(-hl)
    if (!omitEnd) post(hl)

    // Leaf wire-mesh + e-stop in the hinge link's local frame: the hinge pivots at the −X post, so its local x
    // runs GAP..length−GAP and y runs INSET..H−INSET. Tagged link:'hinge' to ride the swing joint — tagging the
    // hidden 'leaf' box (same pose, collision-only) instead would inherit its invisibility.
    var xa = GAP, xb = length - GAP
    var cx = (xa + xb) / 2, cy = (yb + yt) / 2, w = xb - xa, h = yt - yb
    leaf.push(box(cx, yb, 0, w, FRAME, FRAME), box(cx, yt, 0, w, FRAME, FRAME))
    leaf.push(box(xa, cy, 0, FRAME, h, FRAME), box(xb, cy, 0, FRAME, h, FRAME))
    var cols = Math.max(1, Math.round(w / SPACING)), colStep = w / cols
    for (var i = 1; i < cols; i++) leaf.push(box(xa + i * colStep, cy, 0, WIRE, h, WIRE))
    var rows = Math.max(1, Math.round(h / SPACING)), rowStep = h / rows
    for (var j = 1; j < rows; j++) leaf.push(box(cx, yb + j * rowStep, 0, w, WIRE, WIRE))
    // hinge straps: from inside the hinge post's collar (the pivot is x = 0 here) out to the leaf's frame bar
    var x0 = COLLAR / 2 - SINK
    for (var k = 0; k < clampYs.length; k++) {
      leaf.push(box((x0 + xa) / 2, clampYs[k], 0, xa - x0, STRAP_H, STRAP_T))
      hex(leafHw, [0, clampYs[k] + COLLAR_H / 2 + KNUCKLE_GAP, 0], 1, 1, KNUCKLE_AF, KNUCKLE_H)
      hex(leafHw, [0, clampYs[k] - COLLAR_H / 2 - KNUCKLE_GAP, 0], 1, -1, KNUCKLE_AF, KNUCKLE_H)
    }

    // the handle's mounting plate on the latch side (+X), mesh colour, clamping the wires between its two faces
    var hy = Math.min(Math.max(HANDLE_H, yb + PLATE_Y), Math.max(yb + PLATE_Y, yt - PLATE_Y))
    leaf.push(box(xb - PLATE_X / 2, hy, 0, PLATE_X, PLATE_Y, PLATE_Z))

    // the pull handle on each face (handle colour): a round bar swept along a D - out from the plate, a bend, the
    // grip, a bend, back in - so it reads as a bent bar rather than three blocks. Each foot sits on a rosette.
    var ring = []
    for (var q = 0; q < 12; q++) ring.push([BAR_R * Math.cos((q * Math.PI) / 6), BAR_R * Math.sin((q * Math.PI) / 6)])
    var bend = function (out, P, dIn, dOut) {
      // a quarter circle rounding the corner P from direction dIn to dOut (both unit, in the X-Z plane)
      var cx = P[0] + (dOut[0] - dIn[0]) * BEND_R, cz = P[2] + (dOut[2] - dIn[2]) * BEND_R
      for (var t = 0; t <= 6; t++) {
        var a = (t / 6) * Math.PI / 2, co = Math.cos(a), sn = Math.sin(a)
        out.push([cx - dOut[0] * BEND_R * co + dIn[0] * BEND_R * sn, P[1], cz - dOut[2] * BEND_R * co + dIn[2] * BEND_R * sn])
      }
    }
    var gx0 = xb - PLATE_X + LEG_IN, gx1 = xb - LEG_IN
    var feet = mesh(g)
    for (var si = 0; si < 2; si++) {
      var side = si === 0 ? 1 : -1
      var foot = side * (PLATE_Z / 2 + ROSETTE_T - 0.002), top = side * STANDOFF
      var path = [[gx0, hy, foot]]
      bend(path, [gx0, hy, top], [0, 0, side], [1, 0, 0])
      bend(path, [gx1, hy, top], [1, 0, 0], [0, 0, -side])
      path.push([gx1, hy, foot])
      handle.push(g.sweep(ring, path))
      hex(feet, [gx0, hy, side * PLATE_Z / 2], 2, side, ROSETTE, ROSETTE_T)
      hex(feet, [gx1, hy, side * PLATE_Z / 2], 2, side, ROSETTE, ROSETTE_T)
    }
    handle.push(feet.sb.build())

    // the interlock: the switch on the latch post (root; only where this gate draws that post), and its actuator
    // on the leaf - an L from the frame bar out to where the switch head is when shut
    var sy = Math.min(hy + SWITCH_UP, yt - HEAD_H)
    if (!omitEnd) {
      var pz = POST / 2 - SINK, bx = hl - POST / 2 + SW_W / 2 + 0.004
      caps.push(box(bx, sy - SW_H / 2, pz + SW_D / 2, SW_W, SW_H, SW_D))
      // the head: 4 mm deeper than the body so their front faces never share a plane, and reaching back over
      // the leaf's frame bar, which it sits in front of when the gate is shut
      var hx1 = hl - POST / 2 + SW_W + 0.004 - 0.003, hx0 = hx1 - HEAD_W
      caps.push(box((hx0 + hx1) / 2, sy + HEAD_H / 2 - 0.002, pz + (SW_D + 0.004) / 2, HEAD_W, HEAD_H, SW_D + 0.004))
      hex(rootHw, [bx, sy - SW_H, pz + SW_D / 2], 1, -1, 0.016, 0.012) // the cable gland
    }
    // the actuator: a stub from the frame bar's +Z face into the back of the head, seen across the gap between them
    leaf.push(box(xb - 0.002, sy + HEAD_H / 2, (FRAME / 2 - SINK + POST / 2 + 0.01) / 2, 0.02, 0.02, POST / 2 + 0.01 - FRAME / 2 + SINK))

    var parts = []
    if (posts.length) parts.push({ desc: g.merge.apply(g, posts), material: 'postMetal', colorParam: 'postColor' })
    // the anchors and knuckles join the meshColor submesh on their link (no draw of their own)
    caps.push(rootHw.sb.build())
    leaf.push(leafHw.sb.build())
    parts.push({ desc: g.merge.apply(g, caps), material: 'meshMetal', colorParam: 'meshColor' })
    parts.push({ desc: g.merge.apply(g, leaf), link: 'hinge', material: 'meshMetal', colorParam: 'meshColor' })
    parts.push({ desc: g.merge.apply(g, handle), link: 'hinge', material: 'handleMetal', colorParam: 'handleColor' })
    return parts
  },
  step(ctx) {
    if (ctx.used()) flip = !flip
    // a PLC that drives this tag is watching a real gate switch (Watch only): the leaf swings as that switch reads
    const watched = ctx.params.tag && ctx.tagDriven(ctx.params.tag)
    const open = watched ? ctx.readTag(ctx.params.tag) !== ctx.params.normallyClosed : ctx.params.open !== flip
    ctx.report('open', open) // the hand state it is actually in (useParam requires it): authored, then hand-flipped
    const target = open ? ctx.params.openAngle * D2R : 0
    angle = ctx.approach(angle, target, ctx.params.openSpeed * D2R * ctx.dt)
    ctx.joints.swing = angle
    // safety-door-switch output — normallyClosed inverts the signal only, not the motion
    if (ctx.params.tag) ctx.writeTag(ctx.params.tag, open !== ctx.params.normallyClosed)
  },
})
