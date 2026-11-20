// Builds the personnel-door wall overlay: `node scripts/build-personnel-door.mjs`, then `npm run bake-walls`.
//
// Writes assets/building-bake/Personnel_Door.glb, an input of scripts/bake-wall-lighting.mjs, which adds its lightmap
// uvs and writes public/models/building/Personnel_Door.glb. building.ts draws it over a plain Wall_D cell for a
// `personnel_door` wall rule. It is an overlay, not a whole wall module, so the lightmap atlas gains only the door's
// own few charts rather than a second copy of Wall_D's cladding.
//
// A single steel exit door, shut, in the middle of a 10 m cell: a stepped frame and a leaf with a narrow vision panel
// that pass through the cladding (their faces stand proud on both sides, so no hole is cut and the sim wall needs
// none) over a threshold. Inside: a panic bar, a kick plate and a door closer on the leaf's head; outside: round hinge
// knuckles and a lever on its rose. An illuminated EXIT sign hangs over it inside. Beside it inside, the fire equipment an exit
// carries: a wall-mounted extinguisher under its sign on the hinge side, and a fire-alarm pull station at hand height
// on the latch side. Module space is the wall modules':
// x along the cell (0..10), y up from the floor, the cladding's inner face at z = 0 (the room is +z) and its outer face
// at z = -0.25. The door's centre, x = 5, is PERSONNEL_DOOR_AT in src/core/building/buildingDocks.ts.
//
// Materials are plain colours, no textures. Exit_Sign and Exit_Text are drawn unlit (building.ts SELF_LIT), the way a
// lit sign reads; the rest take the baked wall light.
/* global console */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document, NodeIO } from '@gltf-transform/core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets/building-bake/Personnel_Door.glb')

/** the door's centre along the cell; mirrors PERSONNEL_DOOR_AT (src/core/building/buildingDocks.ts) */
const AT = 5
/** the leaf: a 0.9 x 2.1 m single door, standing 15 mm off the floor (clear of the 12 mm threshold) */
const LEAF_W = 0.9
const LEAF_H = 2.1
const LEAF_FLOOR = 0.015
/** the hollow-metal frame's face width round the leaf */
const FRAME = 0.05
/** the cladding's two faces, and how far the frame and leaf stand proud of each */
const INNER = 0
const OUTER = -0.25
const FRAME_PROUD = 0.05
const LEAF_PROUD = 0.035

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => mul(a, 1 / Math.hypot(a[0], a[1], a[2]))
/** a planar polygon's normal from its winding (Newell's method): counter-clockwise seen from where it points */
const newell = (pts) => {
  let n = [0, 0, 0]
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])])
  }
  return norm(n)
}
/** the frames a lathe turns about: its axis A and two radial directions with U x W = A, so increasing angle is
 *  counter-clockwise seen from the end A points to */
const AXES = {
  x: { A: [1, 0, 0], U: [0, 1, 0], W: [0, 0, 1] },
  y: { A: [0, 1, 0], U: [1, 0, 0], W: [0, 0, -1] },
  z: { A: [0, 0, 1], U: [1, 0, 0], W: [0, 1, 0] },
  '-z': { A: [0, 0, -1], U: [1, 0, 0], W: [0, -1, 0] },
}
/** a smooth bend from heading `a` to heading `b` (perpendicular unit vectors) of radius `rad`, starting at `from` */
const arc = (from, a, b, rad, n = 8) => {
  const c = add(from, mul(b, rad))
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = ((Math.PI / 2) * k) / n
    return add(c, add(mul(b, -rad * Math.cos(t)), mul(a, rad * Math.sin(t))))
  })
}

/** a mesh under construction: faces wound counter-clockwise seen from outside, flat or smooth-shaded */
function builder() {
  const pos = []
  const nor = []
  const uv = []
  const idx = []
  /** one planar polygon (counter-clockwise seen from where `n` points), fanned into triangles */
  const face = (pts, n) => {
    const base = pos.length / 3
    for (const p of pts) {
      pos.push(...p)
      nor.push(...n)
      // a box projection, metres: nothing samples it (the materials are untextured), but the bake reads TEXCOORD_0
      const a = Math.abs(n[0]) > 0.5 ? [p[2], p[1]] : Math.abs(n[1]) > 0.5 ? [p[0], p[2]] : [p[0], p[1]]
      uv.push(...a)
    }
    for (let k = 1; k < pts.length - 1; k++) idx.push(base, base + k, base + k + 1)
  }
  /**
   * A prism: a convex outline in the x/y plane (counter-clockwise seen from +z), extruded from z0 to z1. Its +z cap
   * faces the room, its -z cap the outside, and its sides face outward.
   */
  const prism = (outline, z0, z1) => {
    face(outline.map(([x, y]) => [x, y, z1]), [0, 0, 1])
    face([...outline].reverse().map(([x, y]) => [x, y, z0]), [0, 0, -1])
    for (let k = 0; k < outline.length; k++) {
      const [ax, ay] = outline[k]
      const [bx, by] = outline[(k + 1) % outline.length]
      const len = Math.hypot(bx - ax, by - ay)
      // outward normal of an edge of a counter-clockwise outline: the edge direction turned clockwise
      const n = [(by - ay) / len, -(bx - ax) / len, 0]
      face([[ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]], n)
    }
  }
  const box = (x0, x1, y0, y1, z0, z1) => prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1)
  /** an upright cylinder, `n` flat sides, centred on (cx, cz) from y0 to y1 */
  const cylinderY = (cx, cz, r, y0, y1, n = 16) => {
    // angle a runs +x toward -z, which is counter-clockwise seen from above (+y)
    const at = (k, y) => [cx + r * Math.cos((2 * Math.PI * k) / n), y, cz - r * Math.sin((2 * Math.PI * k) / n)]
    face(Array.from({ length: n }, (_, k) => at(k, y1)), [0, 1, 0])
    face(Array.from({ length: n }, (_, k) => at(n - k, y0)), [0, -1, 0])
    for (let k = 0; k < n; k++) {
      const m = (2 * Math.PI * (k + 0.5)) / n
      face([at(k, y0), at(k + 1, y0), at(k + 1, y1), at(k, y1)], [Math.cos(m), 0, -Math.sin(m)])
    }
  }
  /** a cylinder along x, centred on (cy, cz) from x0 to x1 */
  const cylinderX = (cy, cz, r, x0, x1, n = 12) => {
    // angle a runs +y toward +z, which is counter-clockwise seen from +x
    const at = (k, x) => [x, cy + r * Math.cos((2 * Math.PI * k) / n), cz + r * Math.sin((2 * Math.PI * k) / n)]
    face(Array.from({ length: n }, (_, k) => at(k, x1)), [1, 0, 0])
    face(Array.from({ length: n }, (_, k) => at(n - k, x0)), [-1, 0, 0])
    for (let k = 0; k < n; k++) {
      const m = (2 * Math.PI * (k + 0.5)) / n
      face([at(k, x0), at(k + 1, x0), at(k + 1, x1), at(k, x1)], [0, Math.cos(m), Math.sin(m)])
    }
  }
  /** a cylinder along z, centred on (cx, cy) from z0 to z1 */
  const cylinderZ = (cx, cy, r, z0, z1, n = 12) => {
    // angle a runs +x toward +y, which is counter-clockwise seen from +z
    const at = (k, z) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n), z]
    face(Array.from({ length: n }, (_, k) => at(k, z1)), [0, 0, 1])
    face(Array.from({ length: n }, (_, k) => at(n - k, z0)), [0, 0, -1])
    for (let k = 0; k < n; k++) {
      const m = (2 * Math.PI * (k + 0.5)) / n
      face([at(k, z0), at(k + 1, z0), at(k + 1, z1), at(k, z1)], [Math.cos(m), Math.sin(m), 0])
    }
  }
  /** a facet of a curved surface: four corners, each with its own normal */
  const smoothQuad = (p, n) => {
    const base = pos.length / 3
    for (let k = 0; k < 4; k++) {
      pos.push(...p[k])
      nor.push(...n[k])
      uv.push(p[k][0], p[k][1])
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  /**
   * A solid of revolution: `profile` is [radius, height] pairs running along the axis from one end to the other,
   * starting and ending on the axis (radius 0) so the surface closes. Normals are smooth across a profile vertex
   * unless it turns more than 30 degrees there, which is a crease (the bake's own fold threshold).
   */
  const lathe = (c, axis, profile, n = 24) => {
    const { A, U, W } = AXES[axis]
    const segN = []
    for (let i = 0; i + 1 < profile.length; i++) {
      const [r0, h0] = profile[i]
      const [r1, h1] = profile[i + 1]
      const l = Math.hypot(r1 - r0, h1 - h0)
      segN.push([(h1 - h0) / l, -(r1 - r0) / l])
    }
    const crease = Math.cos((30 * Math.PI) / 180)
    const blend = (a, b) => (a[0] * b[0] + a[1] * b[1] > crease ? norm([a[0] + b[0], a[1] + b[1], 0]).slice(0, 2) : a)
    const at = (r, h, t) => add(c, add(mul(A, h), mul(add(mul(U, Math.cos(t)), mul(W, Math.sin(t))), r)))
    const nAt = ([nr, nh], t) => norm(add(mul(A, nh), mul(add(mul(U, Math.cos(t)), mul(W, Math.sin(t))), nr)))
    for (let i = 0; i < segN.length; i++) {
      const [r0, h0] = profile[i]
      const [r1, h1] = profile[i + 1]
      if (r0 === 0 && r1 === 0) continue
      const n0 = i > 0 ? blend(segN[i], segN[i - 1]) : segN[i]
      const n1 = i + 1 < segN.length ? blend(segN[i], segN[i + 1]) : segN[i]
      for (let k = 0; k < n; k++) {
        const ta = (2 * Math.PI * k) / n
        const tb = (2 * Math.PI * (k + 1)) / n
        smoothQuad([at(r0, h0, ta), at(r0, h0, tb), at(r1, h1, tb), at(r1, h1, ta)], [nAt(n0, ta), nAt(n0, tb), nAt(n1, tb), nAt(n1, ta)])
      }
    }
  }
  /** a round tube of radius `r` swept along a polyline, its ring carried by parallel transport so it never twists */
  const tube = (path, r, n = 12) => {
    const T = path.map((_, i) => norm(sub(path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)])))
    const ref = Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    let N = norm(sub(ref, mul(T[0], dot(ref, T[0]))))
    const rings = []
    for (let i = 0; i < path.length; i++) {
      N = norm(sub(N, mul(T[i], dot(N, T[i]))))
      const B = cross(T[i], N)
      rings.push(Array.from({ length: n }, (_, k) => {
        const t = (2 * Math.PI * k) / n
        const d = add(mul(N, Math.cos(t)), mul(B, Math.sin(t)))
        return { p: add(path[i], mul(d, r)), d }
      }))
    }
    for (let i = 0; i + 1 < rings.length; i++) {
      for (let k = 0; k < n; k++) {
        const a = rings[i][k], b = rings[i][(k + 1) % n], c2 = rings[i + 1][(k + 1) % n], d = rings[i + 1][k]
        smoothQuad([a.p, b.p, c2.p, d.p], [a.d, b.d, c2.d, d.d])
      }
    }
    face(rings[rings.length - 1].map((v) => v.p), T[T.length - 1])
    face([...rings[0]].reverse().map((v) => v.p), mul(T[0], -1))
  }
  /**
   * A box whose front edges are chamfered by `b`: its front is the +z face (`dir` 1, a fitting inside) or the -z face
   * (`dir` -1, outside). The back stays square, against the leaf or the wall.
   */
  const bevelBox = (x0, x1, y0, y1, z0, z1, b, dir = 1) => {
    const flip = (pts) => (dir > 0 ? pts : [...pts].reverse().map(([x, y, z]) => [x, y, z0 + z1 - z]))
    const poly = (pts) => {
      const q = flip(pts)
      face(q, newell(q))
    }
    const O = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    const I = [[x0 + b, y0 + b], [x1 - b, y0 + b], [x1 - b, y1 - b], [x0 + b, y1 - b]]
    const zb = z1 - b
    poly([...O].reverse().map(([x, y]) => [x, y, z0]))
    for (let k = 0; k < 4; k++) {
      const [a, c2] = [O[k], O[(k + 1) % 4]]
      const [ia, ic] = [I[k], I[(k + 1) % 4]]
      poly([[a[0], a[1], z0], [c2[0], c2[1], z0], [c2[0], c2[1], zb], [a[0], a[1], zb]])
      poly([[a[0], a[1], zb], [c2[0], c2[1], zb], [ic[0], ic[1], z1], [ia[0], ia[1], z1]])
    }
    poly(I.map(([x, y]) => [x, y, z1]))
  }
  return { pos, nor, uv, idx, prism, box, cylinderY, cylinderX, cylinderZ, lathe, tube, bevelBox }
}

const paint = builder()
const metal = builder()
const sign = builder()
const text = builder()
const red = builder()
const glass = builder()

const L = AT - LEAF_W / 2
const R = AT + LEAF_W / 2
const TOP = LEAF_FLOOR + LEAF_H

// frame: two jambs and a head, through the wall, proud of both faces, each with a lower return on its outer edge so its
// face reads as a stepped profile rather than a flat bar
const ZF0 = OUTER - FRAME_PROUD
const ZF1 = INNER + FRAME_PROUD
const RET = 0.015
paint.box(L - FRAME, L, 0, TOP + FRAME, ZF0, ZF1)
paint.box(R, R + FRAME, 0, TOP + FRAME, ZF0, ZF1)
paint.box(L, R, TOP, TOP + FRAME, ZF0, ZF1)
paint.box(L - FRAME - RET, L - FRAME, 0, TOP + FRAME + RET, ZF0 + 0.02, ZF1 - 0.02)
paint.box(R + FRAME, R + FRAME + RET, 0, TOP + FRAME + RET, ZF0 + 0.02, ZF1 - 0.02)
paint.box(L - FRAME, R + FRAME, TOP + FRAME, TOP + FRAME + RET, ZF0 + 0.02, ZF1 - 0.02)
// leaf: set 15 mm back from the frame's faces on both sides. It passes through the wall like the frame, so it also
// covers the inner face's step back to z -0.062 below y 0.2 (the base kerb)
const IN = INNER + LEAF_PROUD
const OUT_FACE = OUTER - LEAF_PROUD
paint.box(L, R, LEAF_FLOOR, TOP, OUT_FACE, IN)
// a narrow vision panel toward the latch side: the glass a millimetre proud of both faces, in a metal bead
{
  const [gx0, gx1, gy0, gy1] = [AT + 0.06, AT + 0.26, 1.35, 1.95]
  glass.box(gx0, gx1, gy0, gy1, OUT_FACE - 0.001, IN + 0.001)
  const B = 0.018
  for (const [z0, z1] of [[IN, IN + 0.008], [OUT_FACE - 0.008, OUT_FACE]]) {
    metal.box(gx0 - B, gx0, gy0 - B, gy1 + B, z0, z1)
    metal.box(gx1, gx1 + B, gy0 - B, gy1 + B, z0, z1)
    metal.box(gx0, gx1, gy1, gy1 + B, z0, z1)
    metal.box(gx0, gx1, gy0 - B, gy0, z0, z1)
  }
}
// threshold: a metal saddle across the opening, under the leaf, past the frame on both faces
metal.box(L - FRAME - RET, R + FRAME + RET, 0, 0.012, OUTER - 0.1, INNER + 0.08)

// inside: a panic bar (a mounting channel, a round touch bar with rounded ends, the latch mechanism's case at the latch
// end and a bracket at the hinge end), a kick plate, and a door closer on the leaf's head with its arm to a shoe on
// the frame
metal.bevelBox(L + 0.08, R - 0.04, 0.975, 1.065, IN, IN + 0.03, 0.006)
{
  const len = R - 0.18 - (L + 0.13)
  metal.lathe([L + 0.13, 1.02, IN + 0.055], 'x', [[0, 0], [0.018, 0.002], [0.023, 0.007], [0.024, 0.012], [0.024, len - 0.012], [0.023, len - 0.007], [0.018, len - 0.002], [0, len]], 20)
}
metal.bevelBox(R - 0.18, R - 0.04, 0.955, 1.085, IN, IN + 0.075, 0.012)
metal.bevelBox(L + 0.08, L + 0.13, 0.985, 1.055, IN, IN + 0.07, 0.01)
metal.box(L + 0.03, R - 0.03, 0.03, 0.28, IN, IN + 0.003)
metal.bevelBox(L + 0.06, L + 0.34, TOP - 0.13, TOP - 0.05, IN, IN + 0.06, 0.012)
metal.lathe([L + 0.3, TOP - 0.09, IN + 0.06], 'z', [[0, 0], [0.014, 0], [0.014, 0.012], [0.01, 0.017], [0, 0.017]], 16)
metal.bevelBox(L + 0.3, L + 0.62, TOP - 0.1, TOP - 0.08, IN + 0.06, IN + 0.075, 0.004)
metal.bevelBox(L + 0.56, L + 0.68, TOP + 0.005, TOP + FRAME - 0.005, ZF1, IN + 0.075, 0.006)
metal.bevelBox(L + 0.6, L + 0.62, TOP - 0.08, TOP + 0.005, IN + 0.06, IN + 0.075, 0.003)

// outside: three round hinge knuckles with domed ends on the hinge joint, and a lever on its rose at the latch side: the
// rose a chamfered disc, the lever a round bar that leaves it square to the door and bends toward the hinge side
for (const y of [0.25, 1.05, 1.85]) {
  metal.lathe([L, y, OUT_FACE - 0.012], 'y', [[0, -0.006], [0.006, -0.005], [0.01, -0.002], [0.012, 0.004], [0.012, 0.106], [0.01, 0.112], [0.006, 0.115], [0, 0.116]], 16)
}
metal.lathe([R - 0.07, 1.03, OUT_FACE], '-z', [[0, 0], [0.033, 0], [0.033, 0.005], [0.029, 0.011], [0.02, 0.014], [0, 0.014]], 24)
{
  const start = [R - 0.07, 1.03, OUT_FACE - 0.012]
  const bendAt = [R - 0.07, 1.03, OUT_FACE - 0.04]
  const bend = arc(bendAt, [0, 0, -1], [-1, 0, 0], 0.014)
  const end = bend[bend.length - 1]
  metal.tube([start, ...bend, [R - 0.2, end[1], end[2]]], 0.009, 12)
}

// the EXIT sign over the door, inside: a green housing with white block letters on its face
const SIGN_Y0 = TOP + FRAME + 0.15
const SIGN_W = 0.64
const SIGN_H = 0.25
const SIGN_D = 0.07
sign.bevelBox(AT - SIGN_W / 2, AT + SIGN_W / 2, SIGN_Y0, SIGN_Y0 + SIGN_H, INNER, INNER + SIGN_D, 0.012)
{
  const H = 0.15 // letter height
  const W = 0.1 // letter width
  const S = 0.024 // stroke
  const GAP = 0.04
  const z0 = INNER + SIGN_D
  const z1 = z0 + 0.004
  const y0 = SIGN_Y0 + (SIGN_H - H) / 2
  const y1 = y0 + H
  let x = AT - (4 * W + 3 * GAP) / 2
  const bar = (x0, x1, b0, b1) => text.box(x0, x1, b0, b1, z0, z1)
  // E
  bar(x, x + S, y0, y1)
  bar(x + S, x + W, y1 - S, y1)
  bar(x + S, x + W * 0.8, (y0 + y1 - S) / 2, (y0 + y1 + S) / 2)
  bar(x + S, x + W, y0, y0 + S)
  x += W + GAP
  // X: two diagonal strokes, each a parallelogram running corner to corner. They cross, so the second stands 0.5 mm
  // proud of the first rather than on its plane, where the two would z-fight
  text.prism([[x, y0], [x + S, y0], [x + W, y1], [x + W - S, y1]], z0, z1)
  text.prism([[x + W - S, y0], [x + W, y0], [x + S, y1], [x, y1]], z0, z1 + 0.0005)
  x += W + GAP
  // I
  bar(x + (W - S) / 2, x + (W + S) / 2, y0, y1)
  x += W + GAP
  // T
  bar(x, x + W, y1 - S, y1)
  bar(x + (W - S) / 2, x + (W + S) / 2, y0, y1 - S)
}

// fire equipment beside the door, inside
{
  // an extinguisher on the hinge side, 0.6 m clear of the frame: a bracket plate on the wall, the cylinder standing in
  // it with its top under 1.2 m (in reach), a valve head and carrying handle, and its red sign above it
  const X = L - FRAME - 0.6
  const RAD = 0.08
  const CZ = INNER + 0.02 + RAD + 0.005
  metal.bevelBox(X - 0.05, X + 0.05, 0.75, 0.95, INNER, INNER + 0.02, 0.005)
  metal.bevelBox(X - 0.03, X + 0.03, 0.8, 0.83, INNER + 0.02, CZ - 0.06, 0.004)
  metal.lathe([X, 0, CZ], 'y', [[0, 0.8], [RAD + 0.004, 0.8], [RAD + 0.006, 0.805], [RAD + 0.006, 0.825], [RAD + 0.004, 0.83], [0, 0.83]], 32)
  // the body: a rounded foot, a straight barrel and a domed shoulder up to the neck
  red.lathe([X, 0, CZ], 'y', [[0, 0.6], [RAD - 0.01, 0.6], [RAD - 0.003, 0.603], [RAD, 0.612], [RAD, 0.98], [RAD - 0.003, 1.01], [RAD - 0.012, 1.035], [RAD - 0.028, 1.055], [RAD - 0.048, 1.068], [0.02, 1.072], [0.02, 1.085], [0, 1.085]], 32)
  // the valve: a round head, a pressure gauge facing out, a carrying handle and the hose running down the barrel's side
  metal.lathe([X, 0, CZ], 'y', [[0, 1.085], [0.022, 1.085], [0.022, 1.118], [0.018, 1.126], [0, 1.128]], 20)
  metal.lathe([X + 0.012, 1.103, CZ + 0.02], 'z', [[0, 0], [0.012, 0], [0.012, 0.008], [0.01, 0.011], [0, 0.011]], 16)
  metal.bevelBox(X - 0.075, X + 0.035, 1.126, 1.14, CZ - 0.012, CZ + 0.012, 0.004)
  {
    const s0 = [X + 0.02, 1.1, CZ]
    const s1 = [X + 0.055, 1.1, CZ]
    const bend = arc(s1, [1, 0, 0], [0, -1, 0], 0.04)
    const down = bend[bend.length - 1]
    paint.tube([s0, ...bend, [down[0], 0.72, down[2]]], 0.009, 12)
    metal.lathe([down[0], 0, down[2]], 'y', [[0, 0.66], [0.008, 0.66], [0.012, 0.67], [0.012, 0.72], [0, 0.72]], 12)
  }
  // the sign: a red panel with a white extinguisher silhouette (body, head, nozzle)
  red.bevelBox(X - 0.1, X + 0.1, 1.45, 1.7, INNER, INNER + 0.006, 0.002)
  const sz = INNER + 0.006
  text.box(X - 0.03, X + 0.03, 1.49, 1.62, sz, sz + 0.002)
  text.box(X - 0.015, X + 0.015, 1.62, 1.65, sz, sz + 0.002)
  text.box(X + 0.015, X + 0.06, 1.635, 1.65, sz, sz + 0.002)
  // a pull station on the latch side, 0.35 m clear of the frame at hand height, with its pull handle
  const P = R + FRAME + 0.35
  red.bevelBox(P - 0.065, P + 0.065, 1.09, 1.28, INNER, INNER + 0.06, 0.012)
  metal.bevelBox(P - 0.045, P + 0.045, 1.16, 1.19, INNER + 0.06, INNER + 0.075, 0.005)
}

const doc = new Document()
const buffer = doc.createBuffer()
const mesh = doc.createMesh('Personnel_Door')
const material = (name, rgb, metalness, roughness) =>
  doc.createMaterial(name).setBaseColorFactor([...rgb, 1]).setMetallicFactor(metalness).setRoughnessFactor(roughness)
/** sRGB hex to the linear factor glTF stores */
const lin = (hex) => [16, 8, 0].map((s) => {
  const c = ((hex >> s) & 255) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
const parts = [
  [paint, material('Door_Paint', lin(0x5b6770), 0.15, 0.6)],
  [metal, material('Door_Metal', lin(0xa9adb1), 0.15, 0.5)],
  [sign, material('Exit_Sign', lin(0x12914a), 0, 0.8)],
  [text, material('Exit_Text', lin(0xf4f6f2), 0, 0.8)],
  [red, material('Fire_Red', lin(0xc4161c), 0.1, 0.5)],
  [glass, material('Door_Glass', lin(0x2b3a44), 0, 0.15)],
]
for (const [b, mat] of parts) {
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer)
  mesh.addPrimitive(
    doc.createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', new Float32Array(b.pos)))
      .setAttribute('NORMAL', accessor('VEC3', new Float32Array(b.nor)))
      .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(b.uv)))
      .setIndices(accessor('SCALAR', new Uint32Array(b.idx)))
      .setMaterial(mat),
  )
}
doc.createScene('Scene').addChild(doc.createNode('Personnel_Door').setMesh(mesh))
mkdirSync(dirname(OUT), { recursive: true })
await new NodeIO().write(OUT, doc)
console.log(`wrote ${OUT.slice(ROOT.length + 1)}: ${parts.map(([b, m]) => `${m.getName()} ${b.idx.length / 3} tris`).join(', ')}`)
