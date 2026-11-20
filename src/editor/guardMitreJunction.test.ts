import { beforeAll, describe, expect, it } from 'vitest'
import { Color, Matrix4, Vector3 } from 'three'
import type { InstancedMesh, Material, Mesh, MeshStandardMaterial, Object3D } from 'three'
import type { PartPackage } from '../core/parts/partPackage'
import type { SdkPart } from '../core/types'
import { FRAME_WALL_THICKNESS } from '../core/types'
import { registerPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import { findSnap } from '../core/snap/snapFeatures'
import { resolveScene } from '../core/scene/sceneResolve'
import { toLocalXZ, toWorldXZ } from '../core/parts/partGeometry'
import { buildPackage } from '../sim/buildPackage'
import { createCustomVisual } from '../render/parts/sdkPart'
import { bundledPartById } from './parts/bundledExamples'

/**
 * Guards meet at a junction instead of running through each other.
 *
 * This guards against the spur's guard sticking out through the host's guard where it merges. If both guards end
 * square, placed so only their inner faces meet, everything outboard of that (the 5 mm sheet, the 20-25 mm top
 * return) crosses the other guard's band at the junction angle, up to ~25 mm proud at a shallow spur. So both are
 * cut on the plane bisecting the angle between them (core/guards/guardExtents.ts GuardMitre).
 *
 * Judged on the rendered meshes of the real first-party parts, every host family against every mover family, and
 * from geometry derived here rather than by the resolver under test: the corner is the intersection of the two
 * inner-face lines, the mitre plane the bisector of the two guard directions leaving it. Two claims per corner:
 *  - No overlap: no host guard vertex lies on the mover's side of the plane, and none of the mover's on the host's.
 *    A convex piece crossing the plane must have a vertex past it, so this sees any piece that reaches through.
 *  - No gap: both guards reach the plane at the inner corner and at the outer edge of the top return, so a cut that
 *    pulled back too far (or too little on one side) fails as well.
 */

// the belt fabric's weave loads as an <img>; node has none, and the fabric is not what this measures
beforeAll(() => {
  ;(globalThis as { Image?: unknown }).Image ??= class {
    src = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    addEventListener(): void {}
    decode(): Promise<void> { return Promise.resolve() }
  }
})

const pkgs = new Map<string, PartPackage>()
function pkg(id: string): PartPackage {
  let p = pkgs.get(id)
  if (!p) {
    const d = bundledPartById(id)
    if (!d) throw new Error(`no bundled part ${id}`)
    p = buildPackage(d.manifest, d.behavior)
    registerPackage(p)
    pkgs.set(id, p)
  }
  return p
}

const W = 1.524
const INNER = W / 2 + FRAME_WALL_THICKNESS // every family's guard inner face
const RETURN = 0.025 // every family's top return reaches this far out from the inner face
const DECK = 0.75

function host(id: string): SdkPart {
  const belt = id === 'oip.belt-conveyor'
  const p = createSdkPart(pkg(id), 'host', [belt ? -3 : 0, DECK, 0], 0)
  Object.assign(p.params, belt ? { segments: [[6, 0]], width: W } : { length: 6, width: W }, { leftGuard: true, rightGuard: true, standHeight: DECK })
  return p
}

function mover(id: string, angleDeg: number, onto: SdkPart): SdkPart {
  const spur = id.startsWith('oip.spur')
  const belt = id === 'oip.belt-conveyor'
  // dropped overlapping the host's +Z side, already turned so its (splayed) face roughly parallels the host: the
  // snap engine pulls it out to butt, the same gesture a user makes. A tail-origin belt is tried both ways round.
  const yaw = Math.PI / 2 - (angleDeg * Math.PI) / 180
  const drops: [number, number][] = belt
    ? [[2.6, Math.PI / 2], [2.6, -Math.PI / 2], [0.6, Math.PI / 2], [0.6, -Math.PI / 2]]
    : [[1.6, yaw], [1.2, yaw], [1.0, yaw]]
  const p = createSdkPart(pkg(id), 'mover', [0, DECK, 1.6], yaw)
  Object.assign(p.params, spur
    ? { length: 2, width: W, angleFrontDeg: angleDeg, angleBackDeg: 0 }
    : belt ? { segments: [[2, 0]], width: W } : { length: 2, width: W },
  { leftGuard: true, rightGuard: true, standHeight: DECK })
  let cand = null
  for (const [z, r] of drops) {
    p.position = [0, DECK, z]
    p.rotationY = r
    cand = findSnap(p, { position: p.position, rotationY: p.rotationY }, [onto])
    // only a side merge is this test's subject: a shallow spur dropped too far along can butt the host's end instead
    if (cand && toLocalXZ(onto, cand.pose.position[0], cand.pose.position[2]).z > INNER) break
    cand = null
  }
  if (!cand) throw new Error(`no side merge for ${id}`)
  p.position = cand.pose.position
  p.rotationY = cand.pose.rotationY
  return p
}

type V2 = { x: number; z: number }
const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, z: a.z - b.z })
const dot = (a: V2, b: V2): number => a.x * b.x + a.z * b.z
const unit = (a: V2): V2 => { const l = Math.hypot(a.x, a.z); return { x: a.x / l, z: a.z / l } }
const axis = (p: SdkPart): V2 => sub(toWorldXZ(p, 1, 0), toWorldXZ(p, 0, 0))

/** where two plan lines (point + direction) cross */
function meet(p: V2, d: V2, q: V2, e: V2): V2 {
  const den = d.x * e.z - d.z * e.x
  const t = ((q.x - p.x) * e.z - (q.z - p.z) * e.x) / den
  return { x: p.x + d.x * t, z: p.z + d.z * t }
}

type V3 = V2 & { y: number; rail: boolean }

// frame rail steel is the one powder-coated light blue (render/parts/common.ts railMaterial): how a vertex is known
// to be rail, whichever family drew it (a rig link, an instanced template, a fill)
const RAIL_HEX = new Color(0x56a7c8).getHex()
const isRail = (m: Material | Material[]): boolean => !Array.isArray(m) && (m as MeshStandardMaterial).color?.getHex() === RAIL_HEX

/** every rendered vertex of a part, world space */
function vertices(part: SdkPart, ctx: ReturnType<typeof resolveScene>): V3[] {
  const v = createCustomVisual(part)
  v.update(part, ctx.get(part.id))
  v.object.position.set(part.position[0], part.position[1], part.position[2])
  v.object.rotation.set(0, part.rotationY, 0)
  v.object.updateMatrixWorld(true)
  const out: V3[] = []
  const m = new Matrix4()
  const w = new Matrix4()
  const p = new Vector3()
  const take = (mesh: Mesh, world: Matrix4): void => {
    if (world.determinant() === 0) return
    const pos = mesh.geometry.attributes.position!
    const rail = isRail(mesh.material)
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(world)
      out.push({ x: p.x, y: p.y, z: p.z, rail })
    }
  }
  v.object.traverse((o: Object3D) => {
    if (!(o as Mesh).isMesh || !o.visible) return
    const inst = o as InstancedMesh
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m)
        take(inst, w.multiplyMatrices(inst.matrixWorld, m))
      }
    } else take(o as Mesh, o.matrixWorld)
  })
  v.dispose()
  return out
}

const HOSTS = ['oip.roller-conveyor', 'oip.belt-conveyor']
const MOVERS: [string, number][] = [
  ['oip.spur-conveyor', 15], ['oip.spur-conveyor', 30], ['oip.spur-conveyor', 60],
  ['oip.spur-roller-conveyor', 15], ['oip.spur-roller-conveyor', 30], ['oip.spur-roller-conveyor', 60],
  ['oip.roller-conveyor', 0], ['oip.belt-conveyor', 0], // a square T: the straight retracts to the wall plane
]
const CASES = HOSTS.flatMap((h) => MOVERS.map(([m, a]) => [h, m, a] as const))

/** the merged pair, its rendered vertices, and the junction geometry derived by hand: the host's guard line (its
 *  inner face) on the side the mover meets, crossed by each of the mover's two guard lines = the two corners */
function junction(hostId: string, moverId: string, angle: number) {
  const h = host(hostId)
  const s = mover(moverId, angle, h)
  const ctx = resolveScene([h, s], 'render')
  const side = Math.sign(toLocalXZ(h, s.position[0], s.position[2]).z)
  const hx = unit(axis(h))
  const sx = unit(axis(s))
  const hostLine = toWorldXZ(h, 0, side * INNER)
  const corners = [-1, 1].map((z) => meet(hostLine, hx, toWorldXZ(s, 0, z * INNER), sx))
  return { h, s, side, hx, sx, corners, hostVerts: vertices(h, ctx), moverVerts: vertices(s, ctx) }
}

describe('guards meet on one mitre plane at a side merge', () => {
  it.each(CASES)('%s host, %s mover at %i degrees', (hostId, moverId, angle) => {
    const { h, side, hx, sx, corners, hostVerts: hostAll, moverVerts: moverAll } = junction(hostId, moverId, angle)
    // guard height: above the bed, which keeps rails, rollers and belts out
    const hostVerts = hostAll.filter((v) => v.y > DECK + 0.02)
    const moverVerts = moverAll.filter((v) => v.y > DECK + 0.02)
    const out = unit(sub(toWorldXZ(h, 0, side), toWorldXZ(h, 0, 0))) // host outward, toward the mover
    const away = dot(sx, out) > 0 ? sx : { x: -sx.x, z: -sx.z } // the mover's guards leave the host this way
    for (const [ci, corner] of corners.entries()) {
      const other = corners[1 - ci]!
      const hDir = dot(sub(corner, other), hx) > 0 ? hx : { x: -hx.x, z: -hx.z } // the kept host guard runs away from the mouth
      const bis = unit({ x: hDir.x + away.x, z: hDir.z + away.z })
      const n = { x: -bis.z, z: bis.x } // the mitre plane's normal
      const hostSign = Math.sign(dot(hDir, n))
      const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot(hDir, away)))) / 2
      const outer = { x: corner.x + (bis.x * RETURN) / Math.sin(halfAngle), z: corner.z + (bis.z * RETURN) / Math.sin(halfAngle) }
      const reach = Math.max(0.3, (RETURN / Math.tan(halfAngle)) * 1.5)
      const near = (vs: V2[]) => vs.filter((v) => Math.hypot(v.x - corner.x, v.z - corner.z) < reach)
      const hv = near(hostVerts)
      const mv = near(moverVerts)
      const label = `corner ${ci} (half-angle ${((halfAngle * 180) / Math.PI).toFixed(1)} deg)`
      expect(hv.length, `${label}: host guard present`).toBeGreaterThan(0)
      expect(mv.length, `${label}: mover guard present`).toBeGreaterThan(0)

      // no overlap (mm): the furthest either guard reaches past the plane onto the other's side
      const past = (vs: V2[], sign: number) => Math.max(0, ...vs.map((v) => -sign * dot(sub(v, corner), n))) * 1000
      expect(past(hv, hostSign), `${label}: host guard crosses onto the mover's side`).toBeLessThan(0.5)
      expect(past(mv, -hostSign), `${label}: mover guard crosses onto the host's side`).toBeLessThan(0.5)

      // no gap (mm): both reach the inner corner and the outer edge of the return, where the plane cuts them
      const closest = (vs: V2[], q: V2) => Math.min(...vs.map((v) => Math.hypot(v.x - q.x, v.z - q.z))) * 1000
      for (const [what, q] of [['inner corner', corner], ['return edge', outer]] as const) {
        expect(closest(hv, q), `${label}: host guard reaches the ${what}`).toBeLessThan(1.5)
        expect(closest(mv, q), `${label}: mover guard reaches the ${what}`).toBeLessThan(1.5)
      }
    }
  })
})

/**
 * ...and the mover's frame rails fit against the host's frame, which stays whole (it never opens). The host frame is
 * an L on each side: its wall out to one wall thickness past the bed edge, its top flange a further flange width out.
 * So in the host's own frame no mover rail vertex may sit inboard of the host wall's outer face below the flange, nor
 * of the flange's outer edge at flange height; and both bands must reach those faces (no gap). Measured on the rail
 * zone only: between the mover's bed edge and its flange edge, from the frame bottom up to the deck.
 */
const WALL = FRAME_WALL_THICKNESS
const FLANGE_OUT = W / 2 + WALL + 0.02 // the host flange's outer edge
const FLANGE_Y = DECK - 0.005 // the wall/flange split (RAIL_TOP)

describe('mover rails fit against the host frame at a side merge', () => {
  it.each(CASES)('%s host, %s mover at %i degrees', (hostId, moverId, angle) => {
    const { h, side, corners, moverVerts } = junction(hostId, moverId, angle)
    const hostZ = (v: V2) => side * toLocalXZ(h, v.x, v.z).z // out from the host's centreline, toward the mover
    for (const [ci, corner] of corners.entries()) {
      const label = `corner ${ci}`
      const rail = moverVerts.filter((v) => v.rail && Math.hypot(v.x - corner.x, v.z - corner.z) < 0.3)
      expect(rail.every((v) => v.y > DECK - 0.4 && v.y < DECK + 5e-4), `${label}: rail picks only rail`).toBe(true)
      const wall = rail.filter((v) => v.y < FLANGE_Y - 1e-4)
      const flange = rail.filter((v) => v.y > FLANGE_Y + 1e-4)
      expect(wall.length, `${label}: mover rail wall present`).toBeGreaterThan(0)
      expect(flange.length, `${label}: mover rail flange present`).toBeGreaterThan(0)
      // no overlap (mm): how far inside the host frame's outline either band reaches
      const inside = (vs: V2[], face: number) => Math.max(0, ...vs.map((v) => face - hostZ(v))) * 1000
      expect(inside(wall, W / 2 + WALL), `${label}: mover rail wall inside the host frame wall`).toBeLessThan(0.5)
      expect(inside(flange, FLANGE_OUT), `${label}: mover rail flange inside the host frame flange`).toBeLessThan(0.5)
      // no gap (mm): each band reaches its face
      const gap = (vs: V2[], face: number) => Math.min(...vs.map((v) => Math.abs(hostZ(v) - face))) * 1000
      expect(gap(wall, W / 2 + WALL), `${label}: mover rail wall reaches the host wall`).toBeLessThan(1)
      expect(gap(flange, FLANGE_OUT), `${label}: mover rail flange reaches the host flange edge`).toBeLessThan(1)
    }
  })
})

/**
 * ...and nothing of the mover stands in the host's frame, whatever draws it: not the rails, and not the bed either (a
 * belt spur's white side caps and its gap-fill underbody, pushed out under the strip tips, can both run past its
 * splayed face into the host frame at the sharp corner - the strips themselves never do, measured). Below the deck and out to the host flange's edge, a mover vertex may touch the host
 * frame's faces or the host's bed edge (a square T butts on it) but never sit strictly inside the wall or the flange,
 * nor past the bed edge into the host's bed.
 *
 * Square Ts included: the snap engine seats one with its end face on the host frame's outer wall face. Butting it
 * on the bed edge would stand a belt T's end drum (which reaches that face) up to a wall thickness inside the host's
 * frame wall - placement, not a cut, so this is what holds the snap engine to it.
 */
describe('nothing of the mover stands in the host frame at a side merge', () => {
  it.each(CASES)('%s host, %s mover at %i degrees', (hostId, moverId, angle) => {
    const { h, side, corners, moverVerts } = junction(hostId, moverId, angle)
    const hostZ = (v: V2) => side * toLocalXZ(h, v.x, v.z).z
    const bed = W / 2
    const tol = 5e-4
    for (const [ci, corner] of corners.entries()) {
      const near = moverVerts.filter((v) => v.y < DECK + tol && v.y > DECK - 0.18 && Math.hypot(v.x - corner.x, v.z - corner.z) < 0.4)
      expect(near.length, `corner ${ci}: mover geometry present`).toBeGreaterThan(0)
      // how deep (mm) the worst vertex stands inside: the bed, the wall (below the flange), or the flange
      const depth = (v: V3): number => {
        const z = hostZ(v)
        if (z < bed - tol) return (bed - z) * 1000 // past the bed edge
        const inWall = v.y < FLANGE_Y - tol && z > bed + tol && z < bed + WALL - tol
        const inFlange = v.y > FLANGE_Y + tol && z > bed + WALL + tol && z < FLANGE_OUT - tol
        return inWall ? Math.min(z - bed, bed + WALL - z) * 1000 : inFlange ? Math.min(z - bed - WALL, FLANGE_OUT - z) * 1000 : 0
      }
      const worst = near.reduce((a, v) => Math.max(a, depth(v)), 0)
      expect(worst, `corner ${ci}: mover geometry inside the host frame or bed (mm)`).toBeLessThan(0.5)
    }
  })
})
