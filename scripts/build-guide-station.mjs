// Builds the example model the part guides use: `node scripts/build-guide-station.mjs`.
//
// Writes public/guides/pusher-station.glb, the file a reader downloads from guides/part-model/ (and the guides after
// it) and the file each guide's e2e script imports. A side pusher that stands beside a conveyor: a two-post floor
// stand with brackets reaching forward, a guided pneumatic cylinder on it (an aluminium body with end caps and air
// fittings), and a pusher plate with a plastic face. Two nodes, each one mesh, so the Inspector offers both by name:
//   Body    the stand and the cylinder body: everything that stays put
//   Pusher  the piston rod, the two guide rods and the plate: what later guides move along +Z
// The Pusher node's origin is the front face of the cylinder's head, on the piston rod's axis, so a guide can hang it
// off a joint at that point. Its rods reach back into the head, so they stay in it while the plate travels.
//
// Plain colours, no textures, metalness under 0.5: a fully metallic untextured material renders dark in the app.
/* global console */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document, NodeIO } from '@gltf-transform/core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/guides/pusher-station.glb')

/** the stand: its posts behind the cylinder, its top plate under the cylinder body */
const POST_Z = -0.12
const PLATE_TOP = 0.82
/** the cylinder: its axis height, and where its body and its head end along Z */
const AXIS_Y = 0.86
const BODY_BACK = -0.17
const BODY_FRONT = 0.05
const HEAD_FRONT = 0.09
/** the moving piece, from the head's front face: rods out to the plate, the plate, its plastic face */
const ROD_OUT = 0.04
const ROD_IN = 0.18
const GUIDE_X = 0.045

/** an axis-aligned box as flat-shaded triangles: centre and full size */
function box(c, s) {
  const [hx, hy, hz] = s.map((v) => v / 2)
  const faces = [
    [[1, 0, 0], [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]]],
    [[-1, 0, 0], [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]]],
    [[0, 1, 0], [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]]],
    [[0, -1, 0], [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]]],
    [[0, 0, 1], [[hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz]]],
    [[0, 0, -1], [[-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz]]],
  ]
  const g = { pos: [], nrm: [], idx: [] }
  for (const [n, quad] of faces) {
    const base = g.pos.length / 3
    for (const p of quad) {
      g.pos.push(p[0] + c[0], p[1] + c[1], p[2] + c[2])
      g.nrm.push(...n)
    }
    g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return g
}

/** a cylinder of radius r from `a` to `a + length` along `axis` ('y' or 'z'): smooth sides, flat caps */
function cylinder(axis, a, length, r, segments = 32) {
  // built along Z, then for 'y' the Y and Z coordinates swap, which mirrors it, so the winding flips too
  const toY = axis === 'y'
  const at = (x, y, z) => (toY ? [a[0] + x, a[1] + z, a[2] + y] : [a[0] + x, a[1] + y, a[2] + z])
  const dir = (x, y, z) => (toY ? [x, z, y] : [x, y, z])
  const g = { pos: [], nrm: [], idx: [] }
  const tri = (i, j, k) => (toY ? g.idx.push(i, k, j) : g.idx.push(i, j, k))
  const ring = (z, n) => {
    const base = g.pos.length / 3
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2
      g.pos.push(...at(Math.cos(t) * r, Math.sin(t) * r, z))
      g.nrm.push(...dir(...(n ?? [Math.cos(t), Math.sin(t), 0])))
    }
    return base
  }
  const back = ring(0)
  const front = ring(length)
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    tri(back + i, back + j, front + j)
    tri(back + i, front + j, front + i)
  }
  for (const [z, n] of [[0, -1], [length, 1]]) {
    const rim = ring(z, [0, 0, n])
    const centre = g.pos.length / 3
    g.pos.push(...at(0, 0, z))
    g.nrm.push(...dir(0, 0, n))
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      if (n > 0) tri(centre, rim + i, rim + j)
      else tri(centre, rim + j, rim + i)
    }
  }
  return g
}

const merge = (...gs) => {
  const out = { pos: [], nrm: [], idx: [] }
  for (const g of gs) {
    const base = out.pos.length / 3
    out.pos.push(...g.pos)
    out.nrm.push(...g.nrm)
    out.idx.push(...g.idx.map((i) => i + base))
  }
  return out
}

const doc = new Document()
const buffer = doc.createBuffer()
const material = (name, rgb, metallic, roughness) =>
  doc.createMaterial(name).setBaseColorFactor([...rgb, 1]).setMetallicFactor(metallic).setRoughnessFactor(roughness)
const frame = material('Frame', [0.05, 0.16, 0.36], 0.2, 0.55) // powder-coated steel
const aluminium = material('Aluminium', [0.76, 0.78, 0.8], 0.45, 0.35) // the cylinder's anodised body
const caps = material('EndCap', [0.13, 0.13, 0.14], 0.3, 0.45) // its end caps and fittings
const chrome = material('Chrome', [0.86, 0.87, 0.89], 0.45, 0.15) // hard-chromed rods, zinc bolts
const plastic = material('PusherFace', [0.9, 0.9, 0.86], 0.0, 0.7) // a UHMW face, gentle on cartons

const primitive = (g, mat) => {
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer)
  const nrm = doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.nrm)).setBuffer(buffer)
  const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(g.idx)).setBuffer(buffer)
  return doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx).setMaterial(mat)
}
const mesh = (name, parts) => {
  const m = doc.createMesh(name)
  for (const [g, mat] of parts) m.addPrimitive(primitive(g, mat))
  return m
}

// ---- Body, in model space ----
// a two-post frame: a foot under each post, a low brace and a crossbar between them, and a bracket on each side
// reaching forward under the top plate
const postTop = PLATE_TOP - 0.015
const POST_X = 0.12
const stand = merge(
  ...[-POST_X, POST_X].flatMap((x) => [
    box([x, 0.006, POST_Z], [0.12, 0.012, 0.24]), // foot
    box([x, postTop / 2 + 0.006, POST_Z], [0.06, postTop - 0.012, 0.06]), // post
    box([x, PLATE_TOP - 0.06, (POST_Z + BODY_FRONT) / 2 + 0.01], [0.01, 0.09, BODY_FRONT - POST_Z + 0.02]), // side bracket
  ]),
  box([0, 0.22, POST_Z], [2 * POST_X - 0.06, 0.05, 0.04]), // low brace
  box([0, PLATE_TOP - 0.04, POST_Z], [2 * POST_X + 0.06, 0.05, 0.06]), // crossbar under the top plate
  box([0, PLATE_TOP - 0.0075, (BODY_BACK + BODY_FRONT) / 2], [2 * POST_X + 0.06, 0.015, BODY_FRONT - BODY_BACK + 0.02]), // top plate
)
const bolts = merge(
  ...[-POST_X, POST_X].flatMap((x) => [-0.085, 0.085].map((dz) => cylinder('y', [x, 0.012, POST_Z + dz], 0.008, 0.011, 12))),
)
const bodyLength = BODY_FRONT - BODY_BACK - 0.04
const cylBody = merge(
  box([0, AXIS_Y, BODY_BACK + 0.02 + bodyLength / 2], [0.12, 0.07, bodyLength]),
  // the profile's sensor slots, a shallow step on each side
  box([0.0605, AXIS_Y, BODY_BACK + 0.02 + bodyLength / 2], [0.002, 0.012, bodyLength - 0.01]),
  box([-0.0605, AXIS_Y, BODY_BACK + 0.02 + bodyLength / 2], [0.002, 0.012, bodyLength - 0.01]),
)
const endCaps = merge(
  box([0, AXIS_Y, BODY_BACK + 0.01], [0.124, 0.074, 0.02]), // back cap
  box([0, AXIS_Y, BODY_FRONT - 0.01], [0.124, 0.074, 0.02]), // front cap
  box([0, AXIS_Y, (BODY_FRONT + HEAD_FRONT) / 2], [0.15, 0.08, HEAD_FRONT - BODY_FRONT]), // guide head
  // air fittings on top: a stub and an elbow toward the back, one at each end
  ...[BODY_BACK + 0.012, BODY_FRONT - 0.012].flatMap((z) => [
    cylinder('y', [0.03, AXIS_Y + 0.035, z], 0.018, 0.007, 12),
    cylinder('z', [0.03, AXIS_Y + 0.05, z - 0.03], 0.03, 0.006, 12),
  ]),
)
const bodyMesh = mesh('Body', [
  [stand, frame],
  [bolts, chrome],
  [cylBody, aluminium],
  [endCaps, caps],
])

// ---- Pusher, in its own frame: origin on the piston rod's axis at the head's front face, pushing toward +Z ----
const rods = merge(
  cylinder('z', [0, 0, -0.06], 0.06 + ROD_OUT, 0.01), // piston rod, its end hidden in the head
  cylinder('z', [GUIDE_X, 0, -ROD_IN], ROD_IN + ROD_OUT, 0.008), // guide rods, through the head into the body
  cylinder('z', [-GUIDE_X, 0, -ROD_IN], ROD_IN + ROD_OUT, 0.008),
)
const backing = box([0, 0, ROD_OUT + 0.006], [0.15, 0.08, 0.012]) // the rods' yoke plate
const face = box([0, 0, ROD_OUT + 0.012 + 0.01], [0.36, 0.13, 0.02]) // the face that meets the carton
const pusherMesh = mesh('Pusher', [
  [rods, chrome],
  [backing, caps],
  [face, plastic],
])

const scene = doc.createScene('Pusher station')
scene.addChild(doc.createNode('Body').setMesh(bodyMesh))
scene.addChild(doc.createNode('Pusher').setMesh(pusherMesh).setTranslation([0, AXIS_Y, HEAD_FRONT]))
doc.getRoot().setDefaultScene(scene)

mkdirSync(dirname(OUT), { recursive: true })
await new NodeIO().write(OUT, doc)
console.log(`wrote ${OUT}`)
