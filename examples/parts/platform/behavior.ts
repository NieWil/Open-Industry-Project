// Platform — an elevated walkway/storage deck. Purely structural: its length/width/height params
// drive a deck (steel tread plate or a solid deck: deckSurface), a steel column/beam frame and a perimeter safety railing
// (parametric geometry + per-link steel colour), and the step does nothing. showSupports adds the OSHA
// middle-column grid + under-deck beams (off → a bare table on 4 corner legs); showRailings toggles the whole
// perimeter railing (the links' showParam).
//
// geometry() adds what makes the frame read as bolted steel, which a rig can't place because it all sits at
// the columns, and the column grid moves with length, width and showSupports: four anchors on every base
// plate; a shear tab bolted through the beam web on each side of a column a beam runs from; and a knee brace
// from each perimeter column up to the beam beside it, bolted at both ends. The railing gets none of it on
// purpose: a stair landing cuts openings into it (core/structureCuts.ts), which geometry() never sees, so
// hardware there would float in the gap. Render-only; the columns and deck collide.
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
// a square-section member of side t from point a to point b (any direction), its width axis kept horizontal
// where it can be (so a diagonal brace in a vertical plane shows its flat side to that plane)
function member(m, a, b, t) {
  var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  var len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
  if (len < 1e-6) return
  var u = [d[0] / len, d[1] / len, d[2] / len]
  // side = u x up, or u x X when the member is vertical; then e2 = u x side completes a right-handed set
  var s = Math.abs(u[1]) > 0.999 ? [0, u[2], -u[1]] : [-u[2], 0, u[0]]
  var sl = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2])
  s = [s[0] / sl, s[1] / sl, s[2] / sl]
  var w = [u[1] * s[2] - u[2] * s[1], u[2] * s[0] - u[0] * s[2], u[0] * s[1] - u[1] * s[0]]
  var h = t / 2
  obox(m, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [[u[0] * len / 2, u[1] * len / 2, u[2] * len / 2], [s[0] * h, s[1] * h, s[2] * h], [w[0] * h, w[1] * h, w[2] * h]])
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
// a bolt through a member along axis ax: head on the face at +ax (coordinate hiFace), nut and thread end on the
// face at -ax (loFace), both centred on the point p (whose ax coordinate is ignored). af across flats.
function throughBolt(m, p, ax, loFace, hiFace, af) {
  var a = [p[0], p[1], p[2]], b = [p[0], p[1], p[2]], c = [p[0], p[1], p[2]]
  a[ax] = hiFace
  b[ax] = loFace
  c[ax] = loFace - af * 0.5
  hex(m, a, ax, 1, af, af * 0.35)
  hex(m, b, ax, -1, af, af * 0.5)
  hex(m, c, ax, -1, af * 0.55, af * 0.3)
}
// a floor anchor on a plate whose top is at y: a square washer, a hex nut, and the stud end standing out of it
function anchor(m, x, y, z, af) {
  af = af || 0.022
  var w = af * 1.45, wt = 0.003, nh = af * 0.55
  abox(m, x - w / 2, y - SEAT, z - w / 2, x + w / 2, y + wt, z + w / 2)
  hex(m, [x, y + wt, z], 1, 1, af, nh)
  hex(m, [x, y + wt + nh, z], 1, 1, af * 0.55, af * 0.4)
}
// the realized submeshes: push each non-empty accumulator as a MeshPart
function emitMeshes(list) {
  var out = []
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    if (!e.mesh) continue
    var desc = e.mesh.sb.build()
    if (!desc.positions.length) continue
    var part = { desc: desc, material: e.material }
    if (e.colorParam) part.colorParam = e.colorParam
    if (e.link) part.link = e.link
    out.push(part)
  }
  return out
}

var DECK = 0.006 // deck thickness - thin plate or panel carried by the beam grid
var COL = 0.1 // column cross-section
var COL_SPAN = 2.4 // max column spacing (OSHA 8 ft)
var BEAM_H = 0.15 // under-deck support beam height
var BEAM_T = 0.006
var PLATE_T = 0.008
// ANCHOR_IN: an anchor's offset from the plate centre along X and Z. TAB_*: a shear tab's run past the column
// face, height, thickness. BOLT_AF: a hex's across-flats. KNEE: the brace's reach along the beam (it drops the
// same amount down the column, so 45 degrees), shortened on a low deck or a short span; KNEE_T its section.
var ANCHOR_IN = 0.07, ANCHOR_AF = 0.022, TAB_RUN = 0.075, TAB_H = 0.11, TAB_T = 0.008, BOLT_AF = 0.018
var KNEE = 0.6, KNEE_T = 0.05, KNEE_MIN = 0.2

// the rig's grid coordinates along one axis (core/rigPose: maxSpacing = every gap <= COL_SPAN, spread edge to
// edge), or just the two corners without the middle supports
function columnsAlong(span, supports) {
  if (!supports) return [-span / 2, span / 2]
  var n = Math.max(1, Math.min(63, Math.ceil(span / COL_SPAN))), out = []
  for (var i = 0; i <= n; i++) out.push(-span / 2 + (i * span) / n)
  return out
}
function num(v, d) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : d }

definePart({
  params: {
    // 'face' handles put resize dots in the viewport on that axis (clamped to the param's min/max); the host
    // reflows the deck/frame/railing parametrically.
    length: { type: 'number', default: 4, min: 0.5, step: 0.1, label: 'Length (m)', handle: { kind: 'face', axis: 'x' }, desc: 'Deck extent along local X. Drag the dot on either end face to resize in the viewport; the frame, railing and columns reflow to match.' },
    width: { type: 'number', default: 4, min: 0.5, max: 20, step: 0.1, label: 'Width (m)', handle: { kind: 'face', axis: 'z' }, desc: 'Deck extent along local Z. Drag the dot on either side face to resize in the viewport.' },
    // deck elevation above the floor — drives the column length. The origin is the deck TOP (the columns hang
    // below it), so rest:'surfaceBelow' makes the host stand the origin `height` above whatever surface is
    // beneath at drop/snap/translate: the columns always reach the floor, and dragging the platform up regrows
    // them.
    height: { type: 'number', default: 2, min: 0.3, max: 8, step: 0.05, rest: 'surfaceBelow', label: 'Height (m)', desc: 'Height of the deck top above whatever it stands on, which is also the column length. The origin is the deck top, so raising the platform regrows the columns to reach the floor rather than leaving them hanging.' },
    // the deck link's finishParam: each option value IS a rig finish. An access platform is walked on (tread
    // plate); one carrying conveyors or machines has a solid deck that takes the load and stops small items
    // falling through. Only the look changes: the deck collides and seats parts the same either way.
    deckSurface: { type: 'enum', default: 'tread', options: [{ value: 'tread', label: 'Tread plate' }, { value: 'deck', label: 'Solid deck' }], label: 'Deck surface', desc: 'What the deck is made of. Tread plate is the steel walking surface of an access platform; a solid deck is what an equipment platform carrying conveyors or machines has. Only the look changes.' },
    color: { type: 'color', default: '#f2bd0f', label: 'Steel color', desc: 'Steel tint of the frame, columns and railing.' },
    showRailings: { type: 'boolean', default: true, label: 'Perimeter railing', desc: 'Guard railing around the deck edge. Turning it off removes the barrier a walking pilot leans on, not just the visual.' },
    showSupports: { type: 'boolean', default: true, label: 'Middle supports', desc: 'Interior columns under a large deck, in addition to the corner ones. Cosmetic on a small platform, which the corners already carry.' },
  },
  geometry(g, p) {
    var length = num(p.length, 4), width = num(p.width, 4), height = num(p.height, 2)
    var supports = p.showSupports !== false
    var xs = columnsAlong(length, supports), zs = columnsAlong(width, supports)
    var floor = -height, beamTop = -DECK, beamBot = -DECK - BEAM_H, beamMid = (beamTop + beamBot) / 2
    var steel = mesh(g), hw = mesh(g)
    var i, k, d

    // anchors: four per base plate, one near each corner
    for (i = 0; i < xs.length; i++) for (k = 0; k < zs.length; k++)
      for (var ax = -1; ax <= 1; ax += 2) for (var az = -1; az <= 1; az += 2) anchor(hw, xs[i] + ax * ANCHOR_IN, floor + PLATE_T, zs[k] + az * ANCHOR_IN, ANCHOR_AF)

    // knee braces on the perimeter frame: from the column face KNEE down, up to the beam's underside KNEE along
    // it, in the beam's plane; each end runs a hair on into what it meets, and is bolted through
    var gap = function (list) { var m = 1e9; for (var q = 0; q + 1 < list.length; q++) m = Math.min(m, list[q + 1] - list[q]); return m }
    var knee = Math.min(KNEE, (height - DECK - BEAM_H) * 0.35, (Math.min(gap(xs), gap(zs)) - COL) / 2 - TAB_RUN)
    if (knee >= KNEE_MIN) {
      var brace = function (c, along, dir, plane) {
        var n = along === 0 ? 2 : 0
        var a = [0, beamBot - knee, 0], b = [0, beamBot, 0]
        a[along] = c + dir * COL / 2; b[along] = c + dir * (COL / 2 + knee)
        a[n] = plane; b[n] = plane
        var e = KNEE_T / 2 / (Math.sqrt(2) * knee)
        member(steel, [a[0] - (b[0] - a[0]) * e, a[1] - (b[1] - a[1]) * e, a[2] - (b[2] - a[2]) * e], [b[0] + (b[0] - a[0]) * e, b[1] + (b[1] - a[1]) * e, b[2] + (b[2] - a[2]) * e], KNEE_T)
        for (var t = 0; t < 2; t++) {
          var f = t === 0 ? 0.12 : 0.88
          throughBolt(hw, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], n, plane - KNEE_T / 2, plane + KNEE_T / 2, BOLT_AF * 0.85)
        }
      }
      var zEdge = [zs[0], zs[zs.length - 1]], xEdge = [xs[0], xs[xs.length - 1]]
      for (i = 0; i < xs.length; i++) for (var e1 = 0; e1 < 2; e1++) for (d = -1; d <= 1; d += 2)
        if ((d < 0 && i > 0) || (d > 0 && i < xs.length - 1)) brace(xs[i], 0, d, zEdge[e1])
      for (k = 0; k < zs.length; k++) for (var e2 = 0; e2 < 2; e2++) for (d = -1; d <= 1; d += 2)
        if ((d < 0 && k > 0) || (d > 0 && k < zs.length - 1)) brace(zs[k], 2, d, xEdge[e2])
    }

    // shear tabs: at every column, on each side a beam leaves from, along X (the beam at this z) and along Z (the
    // beam at this x). The tab sits on one face of the web; two bolts go through tab and web - one, or none, if a
    // big deck's column grid would run the hardware out of budget (these are under the deck; the braces come first).
    //   c: the column's coordinate along the beam; along: 0 = the beam runs along X (web normal Z), 2 = along Z;
    //   dir: which way the beam leaves; web: the web's centre on its normal axis; out: the face the tab is on
    var tab = function (c, along, dir, web, out) {
      var n = along === 0 ? 2 : 0
      var f0 = web + out * (BEAM_T / 2 - SEAT), f1 = web + out * (BEAM_T / 2 + TAB_T)
      var a0 = c + dir * (COL / 2 - SEAT), a1 = c + dir * (COL / 2 + TAB_RUN)
      var lo = [0, beamMid - TAB_H / 2, 0], hi = [0, beamMid + TAB_H / 2, 0]
      lo[along] = Math.min(a0, a1); hi[along] = Math.max(a0, a1)
      lo[n] = Math.min(f0, f1); hi[n] = Math.max(f0, f1)
      abox(steel, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2])
      var back = web - out * BEAM_T / 2
      for (var yy = 0; yy < tabBolts; yy++) {
        var pt = [0, beamMid + (tabBolts === 1 ? 0 : (yy * 2 - 1) * TAB_H * 0.27), 0]
        pt[along] = c + dir * (COL / 2 + TAB_RUN / 2)
        throughBolt(hw, pt, n, Math.min(back, f1), Math.max(back, f1), BOLT_AF)
      }
    }
    // each column has a tab per beam side: 2 per axis, less one at each end of the axis
    var tabCount = (2 * xs.length - 2) * zs.length + (2 * zs.length - 2) * xs.length
    var tabBolts = 2
    while (tabBolts > 0 && tabCount * tabBolts * 3 * 31 > VERT_CAP - hw.n) tabBolts--
    for (i = 0; i < xs.length; i++) {
      for (k = 0; k < zs.length; k++) {
        // a perimeter web gets its tab on the inside face, where it's seen from under the deck; a grid web on +
        var outZ = k === zs.length - 1 ? -1 : 1
        var outX = i === xs.length - 1 ? -1 : 1
        for (d = -1; d <= 1; d += 2) {
          if ((d < 0 && i > 0) || (d > 0 && i < xs.length - 1)) tab(xs[i], 0, d, zs[k], outZ)
          if ((d < 0 && k > 0) || (d > 0 && k < zs.length - 1)) tab(zs[k], 2, d, xs[i], outX)
        }
      }
    }

    return emitMeshes([
      { mesh: steel, material: 'platformSteel', colorParam: 'color' },
      { mesh: hw, material: 'platformHardware' },
    ])
  },
  react() {},
})
