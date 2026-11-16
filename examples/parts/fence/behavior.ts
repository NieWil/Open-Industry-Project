// Fence — a safety barrier: yellow posts auto-spaced along the length (each with a cap and a floor plate) + a
// black wire-mesh grid (a frame rectangle + vertical/horizontal wires) filling every span, clamped to its posts and
// anchored to the floor — not a solid slab. Demonstrates a
// rig dressed by procedural geometry: geometry() emits the mesh (render-only); the hidden full-span 'barrier'
// rig link is the collision. Length/height-parametric (both with viewport resize dots) + per-surface colour.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

// fixed dimensions (m)

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

var POST = 0.06, MAX_SPACING = 1.5, FRAME = 0.03, WIRE = 0.008, SPACING = 0.1
var CAP_H = 0.03, CAP_FP = POST * 1.08, INSET = 0.08
// Post hardware, SHARED with the Safety Gate (same numbers, same heights) so a gate in a fence line matches it:
// a floor plate under every post, and a clamp COLLAR round the post at each clamp height with a STRAP from the
// collar into the panel frame. Every piece is a little bigger or smaller than what it meets, never flush with it,
// so no two faces share a plane (a shared plane z-fights). Four floor anchors on every plate, ANCHOR_IN out from
// the post's centre on each diagonal. Render-only: the hidden 'barrier' is the collision.
var FOOT = 0.12, FOOT_T = 0.01, COLLAR = POST + 0.012, COLLAR_H = 0.05, STRAP_H = 0.04, STRAP_T = 0.012
var CLAMP_IN = 0.2, SINK = 0.005, ANCHOR_IN = 0.043, ANCHOR_AF = 0.016
// the clamp heights for a panel spanning yb..yt: near the top and the bottom, or one mid-height on a short panel
function clampHeights(yb, yt) { return yt - yb > CLAMP_IN * 3 ? [yb + CLAMP_IN, yt - CLAMP_IN] : [(yb + yt) / 2] }

definePart({
  params: {
    // both sizes are viewport-editable: a 'face' handle puts a resize dot on that axis's faces (docs/part-gizmos.md).
    // X is centre-origin (the opposite end holds); Y is base-origin, so the +Y dot drags the top and the base stays put.
    // The floor is a FILLER PANEL, not a usable run. A guard line is only closed where it meets the machine,
    // and the piece that closes it is whatever the leftover measures — commonly a few hundred mm, as where the
    // demo cell's north run returns to the case line (a 0.48 m slot, so 0.40 m of fence). At 0.5 no fence could
    // shut that at all and the param quietly clamped, which reads as a guarded cell with a person-sized hole in
    // it. 0.2 is where a panel stops being one: the two end posts leave 0.12 of mesh between them.
    length: { type: 'number', default: 4, min: 0.2, step: 0.1, label: 'Length (m)', handle: { kind: 'face', axis: 'x' }, desc: 'Fence run length along local +X. Drag the dot on either end face to resize in the viewport; short runs are legitimate filler panels where a guard line meets a machine.' },
    height: { type: 'number', default: 2, min: 0.5, max: 4, step: 0.1, label: 'Height (m)', handle: { kind: 'face', axis: 'y' }, desc: 'Panel height. The base stays on the floor and the top face moves, so the viewport dot drags the top.' },
    postColor: { type: 'color', default: '#f2bd0f', label: 'Post color', group: 'Colors', desc: 'Post tint.' },
    meshColor: { type: 'color', default: '#0d0d0d', label: 'Mesh color', group: 'Colors', desc: 'Tint of the frame and the wire panel it holds.' },
    omitPostStart: { type: 'boolean', default: false, label: 'Omit start post', group: 'Posts', desc: 'Suppress the post at local -X so a snapped neighbour draws the shared one instead. Snapping sets this for you.' },
    omitPostEnd: { type: 'boolean', default: false, label: 'Omit end post', group: 'Posts', desc: 'Suppress the post at local +X so a snapped neighbour draws the shared one instead. Snapping sets this for you.' },
  },
  geometry(g, p) {
    var length = typeof p.length === 'number' && p.length > 0 ? p.length : 4
    var height = typeof p.height === 'number' && p.height > 0 ? p.height : 2
    var omitStart = p.omitPostStart === true
    var omitEnd = p.omitPostEnd === true
    var box = function (cx, cy, cz, sx, sy, sz) { return g.box([sx, sy, sz], [cx, cy, cz]) }
    var posts = []
    var wires = [] // the frame, wires, caps and clamps: one meshColor submesh
    var hw = mesh(g) // the floor anchors, merged into it (the fixings share the clamps' colour, and a fence line is
    //                  many fences, so a draw of their own each would add up)
    // fill [xa,xb] x [yb,yt] with a frame rectangle + a wire grid
    var panel = function (xa, xb, yb, yt) {
      var cx = (xa + xb) / 2, cy = (yb + yt) / 2, w = xb - xa, h = yt - yb
      wires.push(box(cx, yb, 0, w, FRAME, FRAME), box(cx, yt, 0, w, FRAME, FRAME))
      wires.push(box(xa, cy, 0, FRAME, h, FRAME), box(xb, cy, 0, FRAME, h, FRAME))
      var cols = Math.max(1, Math.round(w / SPACING)), colStep = w / cols
      for (var i = 1; i < cols; i++) wires.push(box(xa + i * colStep, cy, 0, WIRE, h, WIRE))
      var rows = Math.max(1, Math.round(h / SPACING)), rowStep = h / rows
      for (var j = 1; j < rows; j++) wires.push(box(cx, yb + j * rowStep, 0, w, WIRE, WIRE))
    }
    var hl = length / 2
    var numSpans = Math.max(1, Math.ceil(length / MAX_SPACING))
    var span = length / numSpans
    var inset = Math.min(INSET, height * 0.1)
    var yb = inset, yt = height - inset
    var margin = POST * 0.5 + 0.01
    var clampYs = clampHeights(yb, yt)
    var postXs = []
    for (var s0 = 0; s0 <= numSpans; s0++) postXs.push(-hl + s0 * span)
    for (var i = 0; i < postXs.length; i++) {
      if ((i === 0 && omitStart) || (i === numSpans && omitEnd)) continue // a snapped neighbour supplies the corner post
      var x = postXs[i]
      posts.push(box(x, height / 2, 0, POST, height, POST))
      posts.push(box(x, FOOT_T / 2, 0, FOOT, FOOT_T, FOOT))
      wires.push(box(x, height + CAP_H / 2, 0, CAP_FP, CAP_H, CAP_FP))
      for (var c = 0; c < clampYs.length; c++) wires.push(box(x, clampYs[c], 0, COLLAR, COLLAR_H, COLLAR))
      for (var ax = -1; ax <= 1; ax += 2) for (var az = -1; az <= 1; az += 2) anchor(hw, x + ax * ANCHOR_IN, FOOT_T, az * ANCHOR_IN, ANCHOR_AF)
    }
    // a strap from the collar round the post at px into the frame's vertical bar at fx (either side)
    var strap = function (px, fx, y) {
      var dir = fx > px ? 1 : -1
      var x0 = px + dir * (COLLAR / 2 - SINK)
      wires.push(box((x0 + fx) / 2, y, 0, Math.abs(fx - x0), STRAP_H, STRAP_T))
    }
    for (var s = 0; s < numSpans; s++) {
      var xa = postXs[s] + margin, xb = postXs[s + 1] - margin
      if (xb > xa) {
        panel(xa, xb, yb, yt)
        for (var k = 0; k < clampYs.length; k++) { strap(postXs[s], xa, clampYs[k]); strap(postXs[s + 1], xb, clampYs[k]) }
      }
    }
    var parts = []
    if (posts.length) parts.push({ desc: g.merge.apply(g, posts), material: 'postMetal', colorParam: 'postColor' })
    wires.push(hw.sb.build())
    parts.push({ desc: g.merge.apply(g, wires), material: 'meshMetal', colorParam: 'meshColor' })
    return parts
  },
  react() {},
})
