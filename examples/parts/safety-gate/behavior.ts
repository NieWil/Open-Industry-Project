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

// ---- from examples/parts/_shared/hardware.js ----
// SEAT: how far a piece sinks into the face it stands on. VERT_CAP: stop adding to one submesh well short of
// the host's per-mesh vertex budget.
var SEAT = 0.0005, VERT_CAP = 150000
// one submesh under construction, counting its vertices against VERT_CAP
function mesh(g) { return { sb: g.surface(), n: 0, full: false } }
function room(m, k) {
  if (m.full || m.n + k > VERT_CAP) { m.full = true; return false }
  m.n += k
  return true
}
// an oriented box: centre c, half-extent axes e[0..2] (right-handed: e0 x e1 = e2), each face its own four
// vertices wound CCW from outside
function obox(m, c, e) {
  if (!room(m, 24)) return
  var sb = m.sb
  var pt = function (s0, s1, s2) {
    return sb.vertex(c[0] + s0 * e[0][0] + s1 * e[1][0] + s2 * e[2][0], c[1] + s0 * e[0][1] + s1 * e[1][1] + s2 * e[2][1], c[2] + s0 * e[0][2] + s1 * e[1][2] + s2 * e[2][2])
  }
  // the face normal to axis n (sign sg): its other two axes a, b with a x b = +n, walked CCW seen from outside
  var face = function (n, sg) {
    var a = (n + 1) % 3, b = (n + 2) % 3
    var q = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    var idx = []
    for (var k = 0; k < 4; k++) {
      var sv = [0, 0, 0]
      sv[n] = sg
      sv[a] = q[k][0] * sg // flipping one in-plane axis reverses the winding for the negative face
      sv[b] = q[k][1]
      idx.push(pt(sv[0], sv[1], sv[2]))
    }
    sb.quad(idx[0], idx[1], idx[2], idx[3])
  }
  for (var n = 0; n < 3; n++) { face(n, 1); face(n, -1) }
}
// an axis-aligned box from its min and max corners
function abox(m, x0, y0, z0, x1, y1, z1) {
  obox(m, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [[(x1 - x0) / 2, 0, 0], [0, (y1 - y0) / 2, 0], [0, 0, (z1 - z0) / 2]])
}
// the in-plane axes (u, v) of a face normal to axis ax, with u x v = +ax
var PLANE = [[1, 2], [2, 0], [0, 1]]
// a hex prism (bolt head, nut, thread end) standing on a face: base centre p, rising h along axis ax in
// direction s (+1/-1), af across flats. The base sits on the face and is never seen, so it isn't emitted.
function hex(m, p, ax, s, af, h) {
  if (!room(m, 31)) return
  var sb = m.sb, u = PLANE[ax][0], v = PLANE[ax][1], r = af / Math.sqrt(3)
  var ring = function (t) {
    var out = []
    for (var k = 0; k < 6; k++) {
      var a = (k * Math.PI) / 3, q = [p[0], p[1], p[2]]
      q[u] += r * Math.cos(a)
      q[v] += r * Math.sin(a)
      q[ax] += s * t
      out.push(q)
    }
    return out
  }
  var lo = ring(-SEAT), hi = ring(h)
  var V = function (q) { return sb.vertex(q[0], q[1], q[2]) }
  for (var k = 0; k < 6; k++) {
    var k1 = (k + 1) % 6
    var b0 = V(lo[k]), b1 = V(lo[k1]), f1 = V(hi[k1]), f0 = V(hi[k])
    // CCW about +ax, so tangent x (+ax) points outward; a prism rising along -ax walks the other way
    if (s > 0) sb.quad(b0, b1, f1, f0)
    else sb.quad(b1, b0, f0, f1)
  }
  var cc = [p[0], p[1], p[2]]
  cc[ax] += s * h
  var c = V(cc), cap = []
  for (var k2 = 0; k2 < 6; k2++) cap.push(V(hi[k2]))
  for (var k3 = 0; k3 < 6; k3++) {
    if (s > 0) sb.triangle(c, cap[k3], cap[(k3 + 1) % 6])
    else sb.triangle(c, cap[(k3 + 1) % 6], cap[k3])
  }
}
// a floor anchor on a plate whose top is at y: a square washer, a hex nut, and the stud end standing out of it
function anchor(m, x, y, z, af) {
  af = af || 0.022
  var w = af * 1.45, wt = 0.003, nh = af * 0.55
  abox(m, x - w / 2, y - SEAT, z - w / 2, x + w / 2, y + wt, z + w / 2)
  hex(m, [x, y + wt, z], 1, 1, af, nh)
  hex(m, [x, y + wt + nh, z], 1, 1, af * 0.55, af * 0.4)
}

const D2R = Math.PI / 180
let angle = 0 // current swing angle (rad)
let flip = false // viewport Use toggles: XORed with the authored 'open' param

definePart({
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
