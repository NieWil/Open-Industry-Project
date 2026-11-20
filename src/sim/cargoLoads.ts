// Product state and unit loads, the stateless half: a piece's marks, the load standing in a zone, a film web's
// path, and composing a unit's pieces into the pose rows. CargoRegistry (cargoRegistry.ts) holds the units, dressings and rows themselves.
import { webCorner, wrapAnchor, wrapLoad } from '../core/cargoWrap'
import type { WrapBody } from '../core/cargoWrap'
import { CARGO_CAP_LOAD_BASE } from '../core/frame'
import type { FrameDressing } from '../core/frame'
import type { CargoMarkValue } from '../core/parts/partPackage'
import { reportPartDiagnostic } from '../core/parts/partDiagnostics'
import { getPackage } from '../core/parts/partRegistry'
import { POSE_STRIDE, qApply, qConjugate, rigLinkIndex } from '../core/rig/rigPose'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import { pointInZone } from './cargoSensing'
import type { BehaviorRecord, LiveBox, RigInstance, UnitLoad } from './worldTypes'

/** every live cargo body as the load measure sees it (core/cargoWrap), row for row with boxes */
export function wrapBodies(boxes: readonly LiveBox[], snap: Float32Array | null): WrapBody[] {
  const out: WrapBody[] = []
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!
    let pos: Vec3
    let quat: Quat
    if (snap) {
      const o = i * 7
      pos = [snap[o] as number, snap[o + 1] as number, snap[o + 2] as number]
      quat = [snap[o + 3] as number, snap[o + 4] as number, snap[o + 5] as number, snap[o + 6] as number]
    } else {
      const p = box.body.GetPosition()
      const q = box.body.GetRotation()
      pos = [p.GetX(), p.GetY(), p.GetZ()]
      quat = [q.GetX(), q.GetY(), q.GetZ(), q.GetW()]
    }
    out.push({ pos, quat, half: [box.hx, box.hy, box.hz] })
  }
  return out
}

/** leave marks on a piece: on its unit when it is joined (so they apply to the whole load), else on the piece. A
 *  mark of a declared product attribute must be of its kind; one that is not is refused and reported against the
 *  machine that made it (`by`), rather than turning an authored boolean into a string mid-run. */
export function markPiece(box: LiveBox, marks: Readonly<Record<string, CargoMarkValue>>, by: BehaviorRecord | undefined, simTime: number): void {
  const types = box.unit ? unitAttrTypes(box.unit) : box.attrTypes
  let ok: Record<string, CargoMarkValue> = marks as Record<string, CargoMarkValue>
  if (types) {
    ok = {}
    for (const [k, v] of Object.entries(marks)) {
      const t = types[k]
      if (t && typeof v !== t) {
        if (by?.partId) reportPartDiagnostic({ source: 'step', partId: by.partId, message: `mark '${k}' refused: the product declares it a ${t}, not a ${typeof v}`, simTime })
        continue
      }
      ok[k] = v
    }
  }
  if (box.unit) Object.assign(box.unit.marks, ok)
  else box.marks = { ...(box.marks ?? {}), ...ok }
}

/** the attribute kinds that bind a unit's marks: every piece's declared ones (a unit load's own come with Step 2) */
export function unitAttrTypes(unit: UnitLoad): Record<string, 'boolean' | 'number' | 'string'> | null {
  let out: Record<string, 'boolean' | 'number' | 'string'> | null = unit.attrTypes ?? null
  for (const m of unit.members) if (m.attrTypes) out = { ...m.attrTypes, ...(out ?? {}) }
  return out
}

/** rows whose centre is inside a zone */
export function rowsInZone(z: { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; cos: number; sin: number }, bodies: WrapBody[]): number[] {
  const out: number[] = []
  for (let i = 0; i < bodies.length; i++) {
    const p = bodies[i]!.pos
    if (pointInZone(z, p[0], p[1], p[2])) out.push(i)
  }
  return out
}

/** The load in a zone, found the same way by every product-state op: its anchor (the lowest pallet whose centre
 *  is in the zone, else the lowest body) and everything resting on it (core/cargoWrap wrapLoad), anchor first,
 *  with the box a dressing is fitted to (null for a bare anchor). Null when the zone holds no cargo. */
export function loadInZone(z: { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; cos: number; sin: number }, bodies: WrapBody[], boxes: readonly LiveBox[]): { rows: number[]; box: { min: Vec3; max: Vec3 } | null } | null {
  const cands = rowsInZone(z, bodies).map((i) => ({ index: i, y: bodies[i]!.pos[1], pallet: (boxes[i]!.caps & CARGO_CAP_LOAD_BASE) !== 0 }))
  const a = wrapAnchor(cands)
  if (a < 0) return null
  const w = wrapLoad(a, bodies, (boxes[a]!.caps & CARGO_CAP_LOAD_BASE) !== 0)
  return { rows: [a, ...(w?.members ?? [])], box: w ? w.box : null }
}

/** one of a package's materials as a LINEAR rgb (what a dressing is drawn in); a light grey when it has no such material */
export function packageMaterialColor(pkgId: string | null, material: string): [number, number, number] {
  const m = pkgId ? getPackage(pkgId)?.materials?.find((x) => x.id === material) : undefined
  return m?.color ? [m.color[0], m.color[1], m.color[2]] : [0.8, 0.8, 0.8]
}

// The web of a dressing this tick: from the roll (the named link's pose as the rig was last posed, so the web
// leaves the roll where it is drawn) to the corner of the dressing it trails back to. Null on the first tick a
// roll is seen, before there is a direction of travel to trail.
export function filmWeb(
  rigs: readonly RigInstance[],
  webRollPrev: WeakMap<BehaviorRecord, [number, number]>,
  b: BehaviorRecord,
  web: { link: string; offset: [number, number, number]; height: number },
  anchor: WrapBody,
  film: FrameDressing,
): FrameDressing['web'] | null {
  const rig = rigs.find((r) => r.rec === b)
  const li = rig?.poseBuf ? rigLinkIndex(rig.geo).get(web.link) : undefined
  if (!rig?.poseBuf || li === undefined) return null
  const o = li * POSE_STRIDE
  const p = rig.poseBuf
  const d = qApply([p[o + 3]!, p[o + 4]!, p[o + 5]!, p[o + 6]!], web.offset)
  const roll: [number, number] = [p[o]! + d[0], p[o + 2]! + d[2]]
  const y0 = p[o + 1]! + d[1]
  const prev = webRollPrev.get(b)
  webRollPrev.set(b, roll)
  if (!prev || (prev[0] === roll[0] && prev[1] === roll[1])) return null
  // into the anchor's frame to find the corner, and back out to draw it
  const inv = qConjugate(anchor.quat)
  const local = (x: number, z: number): [number, number] => {
    const v = qApply(inv, [x - anchor.pos[0], 0, z - anchor.pos[2]])
    return [v[0], v[2]]
  }
  const r = local(roll[0], roll[1])
  const q = local(prev[0], prev[1])
  const corner = webCorner(film, r, [r[0] - q[0], r[1] - q[1]])
  const w = qApply(anchor.quat, [corner[0], 0, corner[1]])
  return { from: roll, to: [anchor.pos[0] + w[0], anchor.pos[2] + w[2]], y0, y1: y0 + web.height }
}

/** a unit load's pieces all read the unit's pose in the snapshot rows; compose each with its fixed offset in the unit */
export function composeUnitRows(boxes: readonly LiveBox[], out: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const box = boxes[i] as LiveBox
    if (!box.local) continue
    // qApply(unit, local.p) and qMul(unit, local.q), written out: this runs for every piece every step, and the
    // tuple-returning helpers would allocate three arrays a row
    const o = i * 7
    const ux = out[o + 3]!, uy = out[o + 4]!, uz = out[o + 5]!, uw = out[o + 6]!
    const [px, py, pz] = box.local.p
    const tx = 2 * (uy * pz - uz * py)
    const ty = 2 * (uz * px - ux * pz)
    const tz = 2 * (ux * py - uy * px)
    out[o] = out[o]! + px + uw * tx + (uy * tz - uz * ty)
    out[o + 1] = out[o + 1]! + py + uw * ty + (uz * tx - ux * tz)
    out[o + 2] = out[o + 2]! + pz + uw * tz + (ux * ty - uy * tx)
    const [bx, by, bz, bw] = box.local.q
    out[o + 3] = ux * bw + uw * bx + uy * bz - uz * by
    out[o + 4] = uy * bw + uw * by + uz * bx - ux * bz
    out[o + 5] = uz * bw + uw * bz + ux * by - uy * bx
    out[o + 6] = uw * bw - ux * bx - uy * by - uz * bz
  }
}
