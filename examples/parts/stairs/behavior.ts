// Stairs — an industrial access flight. Demonstrates array links + parametric geometry + a
// constant-slope rotation: 'numSteps' closed-riser steps rise up-and-forward by a constant rise/run (a
// diagonal array `step`), carried by two sloped side stringers, with a full stair rail — sloped top, hand & mid rails,
// a bottom newel and posts about every metre and a half — that showHandrails toggles off. Invisible guard colliders line
// both open sides (slope + landing) so a walker can't step off. Two-tone: tread-plate treads/risers you
// walk on (the treads collide), steel structure tinted by `color`. Purely structural — the params reshape the
// rig, the step does nothing.
//
// geometry() details it as the steel stair it is (tread-plate treads, closed risers): a steel nosing angle
// along every tread's front edge, whatever the handrail setting; and, with the handrails, the intermediate posts
// (below), two bolt heads on each stringer where every tread is clipped to it, and each post bolted through
// the stringer. Nothing on the top landing: a deck connection drops the landing (dropWhenMounted), which geometry()
// can't see, so hardware there would float. Everything rides the 'railFrame' link, so a snapped stair's
// lift carries it with the flight. No floor anchors: the foot links stretch down to the floor under that lift
// (anchor: 'floor'), which geometry() can't see, so a plate at the foot would float. Render-only.
//
// The flight, as the rig lays it out:
//   - standard 0.178 rise / 0.28 tread → the run/rise follow a `numSteps` count (array `step` is a constant
//     diagonal) rather than independent length/height params. The slope is therefore a fixed angle
//     atan2(rise, run), so the stringers + rails are a static-quat rotation whose length (and centre) track
//     numSteps linearly - the one shape a param-driven angle couldn't express.
//   - two-tone: treads/risers/landing are steel tread plate (finish:'tread' → the rig DeckSurface),
//     the steel structure (stringers/posts/rails/newel) tints with `color`.
//   - top landing: a fixed-depth flat plate + its flat handrail continuation, for a freestanding flight. Snapped
//     to a platform, the flight's TOP meets the deck edge and the deck is the landing: every landing link is
//     `dropWhenMounted`, the deck connection lifts the flight flush, and the sloped rails end on the posts the
//     platform frames its railing gap with.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

// derived constants at 8 decimals (near-zero to 0), so the manifest's numbers and refs stay exact

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

function r8(n) { return Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8) }

var RISE = 0.178 // standard rise (m) - 7 in, the building-code maximum (STAIRS_STANDARD_RISE)
var TREAD = 0.28 // standard tread run (m) - 11 in, the building-code minimum (STAIRS_STANDARD_TREAD)
var NOSING = 0.025 // tread nose overhang DOWN-flight past the riser below
var WIDTH0 = 1.2 // default width (static fallback for a sparse instance)
var DEFAULT_STEPS = 11

var ANG = Math.atan2(RISE, TREAD) // slope angle above horizontal
var COS = Math.cos(ANG)

var STRINGER_W = 0.012 // side skirt beam thickness (local Z)
var POST = 0.04 // handrail post cross-section
var NEWEL = r8(POST * 1.2) // thicker bottom newel post; the handrail's bottom bend ends on its inner face
// the handrail you grip: round tube (1-1/2 in, 38 mm outside: inside the 1.25-2 in a graspable round rail runs, and
// narrower than the 40 mm post its ends weld to), on brackets INSIDE the post line so a sliding hand clears every
// post by OSHA 1910.29(f)'s 2.25 in. Square bar on the post line (as the other rails are) is neither graspable nor
// clear: a hand running up it met each post.
var HR_R = 0.019 // handrail tube radius
var HR_CLEAR = 0.06 // clear gap, post inner face -> handrail surface
var BEND_R = 0.05 // centreline radius of the handrail's two bends (newel end, top end)
var HRAIL_H = 1.07 // top rail height above the tread nosing line: 42 in, OSHA 1910.29(f)'s stair rail minimum
var HAND_H = 0.91 // handrail TOP above the nosing line: 36 in, inside OSHA 1910.29(f)'s 30-38 in band
// the POST LINE: posts, newels and the top and mid rails stand ON the tread edge. A platform frames the railing gap it
// opens for a flight at the flight's width, so its gap posts stand there too, and the flight's rails run square into
// them; on the stringer line, 6 mm out, each top rail sat off-centre on its gap post, proud of the post's outer face.
var POST_Z = 0
// the handrail centre's offset from the tread edge (±width/2 + this; negative = inward): a post half-width, the
// clearance and the pipe radius inside the post line
var HR_Z = r8(POST_Z - POST / 2 - HR_CLEAR - HR_R)

// ---- handrail posts (steel) - intermediate posts between the newel and the landing post, both sides --------
// Industrial stair rail carries a post every metre or so, not one per tread (a post per step read as a baby
// gate). The spacing isn't a linear function of numSteps, so no array link can place them: geometry() does, on
// the tread nearest each even division of the run. Standing on the tread's surface at
// mid-tread, topping out on the sloped rail line. The RAIL LINE runs through the tread NOSING corners + HRAIL_H
// - the line through ((i+1)·TREAD, (i+1)·RISE + h), which passes through the landing start (numSteps·TREAD,
// numSteps·RISE + h) EXACTLY, so the sloped rail SHARES its top endpoint with the flat landing rail. A post at
// mid-tread meets that line at (i+1)·RISE + h − RISE/2, so the posts are HRAIL_H − RISE/2 tall.
var POST_H = r8(HRAIL_H - RISE / 2) // post height: tread top → the nosing-line rail
var POST_MAX_RUN = 1.4 // max horizontal run between posts (newel → posts → landing post)

// ---- handrail (steel tube) - drawn by geometry(), with the posts and brackets it hangs from --------------------
// ONE swept tube per side: out of the newel's inner face, bent up the flight, along the nosing line + HAND_H (its
// TOP at 36 in), bent again and back into the top post's inner face. Bends, not two straight pieces meeting: the
// sloped run's end face stood proud of a separate return. The top post is the platform's gap post when the flight
// is mounted and the landing's own first post when it is not; both stand just down-flight of the flight top
// (their deck-side face on it), so one top bend fits both.
// tube centre above the nosing line: a round tube on a slope stands HR_R / cos(slope) above its centreline
// (measured plumb, as a handrail's height is), so its top lands on HAND_H exactly. The tube's centre is HR_Y above
// the nosing line and HR_Z off the tread edge (inside the posts).
var HR_Y = r8(HAND_H - HR_R / COS)

// NOSE_*: the nosing angle's top leg (run back over the tread), front leg (down the tread's front edge),
// thickness, and how far it stands proud of the tread. BOLT_AF: a hex's across-flats.
var NOSE_TOP = 0.045, NOSE_FRONT = 0.035, NOSE_T = 0.003, NOSE_PROUD = 0.0015, BOLT_AF = 0.016

// a quarter bend of radius r at corner C, arriving along unit a and leaving along unit b (a perpendicular to b):
// the points from C - r·a round to C + r·b, appended to pts
function bend(pts, C, a, b, r, segs) {
  var O = [C[0] - r * a[0] + r * b[0], C[1] - r * a[1] + r * b[1], C[2] - r * a[2] + r * b[2]]
  for (var k = 0; k <= segs; k++) {
    var t = (k / segs) * Math.PI / 2, co = Math.cos(t), si = Math.sin(t)
    pts.push([O[0] - r * co * b[0] + r * si * a[0], O[1] - r * co * b[1] + r * si * a[1], O[2] - r * co * b[2] + r * si * a[2]])
  }
}
// both handrails, one swept tube each: newel inner face -> bend -> up the nosing line -> bend -> top post inner face
function handrails(g, n, width) {
  var L = Math.sqrt(TREAD * TREAD + RISE * RISE), d = [TREAD / L, RISE / L, 0]
  var ring = []
  // counter-clockwise in g.sweep's [up, width] section coordinates, so the faces point OUT (clockwise turned the
  // tube inside out: its far wall's inside passed for a tube until the angle showed the open shell)
  for (var k = 0; k < 16; k++) { var t = (k / 16) * Math.PI * 2; ring.push([HR_R * Math.cos(t), HR_R * Math.sin(t)]) }
  var tubes = []
  for (var s = -1; s <= 1; s += 2) {
    var zh = s * (width / 2 + HR_Z)
    var xTop = n * TREAD - POST / 2 // the top post's centre: its deck-side face is the flight top
    var pts = [[0, HR_Y, s * (width / 2 + POST_Z - NEWEL / 2)]]
    bend(pts, [0, HR_Y, zh], [0, 0, -s], d, BEND_R, 6)
    bend(pts, [xTop, (xTop * RISE) / TREAD + HR_Y, zh], d, [0, 0, s], BEND_R, 6)
    pts.push([xTop, (xTop * RISE) / TREAD + HR_Y, s * (width / 2 + POST_Z - POST / 2)])
    tubes.push(g.sweep(ring, pts, { caps: true }))
  }
  return g.merge(tubes[0], tubes[1])
}
definePart({
  params: {
    numSteps: { type: 'number', default: DEFAULT_STEPS, min: 2, max: 40, step: 1, label: 'Steps', desc: 'Number of steps in the flight, which is what sets both its rise and its run: the slope is fixed at the standard 0.178 m rise over a 0.28 m tread, so a flight grows along the diagonal rather than getting steeper. Count the steps you need to reach the deck.' },
    width: { type: 'number', default: WIDTH0, min: 0.4, max: 4, step: 0.05, label: 'Width (m)', desc: 'Tread width across local Z.' },
    showHandrails: { type: 'boolean', default: true, label: 'Handrails', desc: 'Handrails up both sides of the flight.' },
    color: { type: 'color', default: '#f2bd0f', label: 'Steel color', desc: 'Steel tint of the stringers and rails.' },
  },
  geometry(g, p) {
    var n = typeof p.numSteps === 'number' && p.numSteps >= 2 ? Math.round(p.numSteps) : DEFAULT_STEPS
    var width = typeof p.width === 'number' && p.width > 0 ? p.width : WIDTH0
    var rails = p.showHandrails !== false
    var steel = mesh(g), hw = mesh(g)
    var i, s

    // nosing: an angle over each tread's front edge, its ends run a hair into the stringers
    var zw = width / 2 + 0.001
    for (i = 0; i < n; i++) {
      var front = i * TREAD - NOSING, top = (i + 1) * RISE
      abox(steel, front - NOSE_T, top - NOSE_T, -zw, front + NOSE_TOP, top + NOSE_PROUD, zw)
      abox(steel, front - NOSE_T, top - NOSE_FRONT, -zw, front + SEAT, top - NOSE_T + SEAT, zw)
    }
    if (rails) {
      // stringer bolts: two heads on each stringer's outer face per tread, just under the tread's level
      var zOut = width / 2 + STRINGER_W
      for (i = 0; i < n; i++) {
        for (s = -1; s <= 1; s += 2) {
          hex(hw, [i * TREAD + TREAD * 0.3, (i + 1) * RISE - 0.03, s * zOut], 2, s, BOLT_AF, BOLT_AF * 0.35)
          hex(hw, [i * TREAD + TREAD * 0.7, (i + 1) * RISE - 0.03, s * zOut], 2, s, BOLT_AF, BOLT_AF * 0.35)
        }
      }
      // The intermediate handrail posts: a rig array can only place one per tread, and industrial stair rail has
      // one every metre or so. Evenly divide the run from the newel (x = 0) to the landing post (x = numSteps x
      // tread) into spans no longer than POST_MAX_RUN and stand a post on the tread nearest each division, bolted
      // through the stringer twice.
      var spans = Math.max(1, Math.ceil((n * TREAD) / POST_MAX_RUN))
      var last = -1
      for (var j = 1; j < spans; j++) {
        i = Math.min(n - 2, Math.max(1, Math.round((j * n) / spans - 0.5))) // tread index, never beside an end post
        if (i === last) continue
        last = i
        var px = (i + 0.5) * TREAD, py = (i + 1) * RISE
        for (s = -1; s <= 1; s += 2) {
          var pz = s * (width / 2 + POST_Z)
          abox(steel, px - POST / 2, py, pz - POST / 2, px + POST / 2, py + POST_H, pz + POST / 2)
          // handrail bracket: an arm from the post's inner face under the pipe, its top just into the pipe
          var hy = (px * RISE) / TREAD + HR_Y, hz = s * (width / 2 + HR_Z), fz = s * (width / 2 + POST_Z - POST / 2)
          abox(steel, px - 0.012, hy - HR_R - 0.025, Math.min(hz, fz), px + 0.012, hy - HR_R + 0.006, Math.max(hz, fz))
          hex(hw, [px, py + 0.05, s * zOut], 2, s, BOLT_AF, BOLT_AF * 0.35)
          hex(hw, [px, py + 0.12, s * zOut], 2, s, BOLT_AF, BOLT_AF * 0.35)
        }
      }
    }
    var out = emitMeshes([
      { mesh: steel, material: 'stairSteel', colorParam: 'color', link: 'railFrame' },
      { mesh: hw, material: 'stairHardware', link: 'railFrame' },
    ])
    if (rails) out.splice(1, 0, { desc: handrails(g, n, width), material: 'stairSteel', colorParam: 'color', link: 'railFrame' })
    return out
  },
  react() {},
})
