// Layout check: does every part that is meant to sit on something actually sit on something?
//
// `validate-project`, `check-wiring` and `test-project` say nothing about geometry, so a scene can pass them
// all and still have every part misplaced. That is the most common failure in scene JSON written by an agent.
//
// It reports disconnection, not collision: on the correct demo scene a naive AABB overlap test flags 303 pairs,
// since the building encloses everything, cargo rides conveyors and much contact is intended (a blade stop seats
// inside a roller bed, a sensor overlaps its belt). The parts that legitimately overlap are the ones that declare
// the relationship (`snap.track`, `snap.mounts`, ...), and that declaration makes absence reportable: a part that
// says it seats onto a host, with no host near it, is wrong. No heuristics, no tolerance tuning.
//
// The only collision reported is a part standing in an interior building column (`columnSpacing`,
// core/building/buildingColumns.ts): solid floor-to-roof, nothing is ever meant to overlap it. Cargo is exempt, and so is
// anything flat on the floor (markings).
//
// Two warnings, never errors. The first: a conveyor's end placed against a spur's side. A spur is itself a merge and
// takes end joins only, so its guard stays closed there (endJoinSideFindings).
//
// The second: a box feed (a part with a `keepSpacing` param: the box spawner) dropping onto a belt
// whose run tag something drives, without being held with that belt. A program that stops the belt (accumulation, a
// release, Stop) then gets boxes stacked on the stopped belt at the drop point, or one dropped the instant it
// restarts onto the box still under the drop; see feedFindings. It needs to know which tags are driven (the
// program's outputs, a part's `out` tags), which only the caller can say, so it runs only when given `drivenTags`:
// a belt nobody drives runs on its own and is fine.
//
// Not reported: `chain` and `edges` (peer relationships; one lone fence is not an error) and `surfaces` (the host
// half needs no guest).
//
// Registry-dependent: footprint and snap declaration resolve per package, so the scene's packages must be
// registered (true anywhere a scene is loaded).

import { getPackage } from './parts/partRegistry'
import { packageParamSpecs, switchValue, visibleWhenHolds } from './packageParams'
import { bedOf, conveyorEndsOf, isConveyorLike, partFootprint, toLocalXZ, toWorldXZ } from './parts/partGeometry'
import { commsOn } from './conveyor/conveyorDirection'
import { INTERIOR_COLUMN_SIZE, interiorColumnHeight, interiorColumns } from './building/buildingColumns'
import { cargoView } from './frame'
import type { PartInstance } from './types'

/**
 * Snap kinds that make a part a guest: it is placed onto a host, so having no host is a defect.
 * Read off the package's own declaration, which is why this needs no per-part-type special-casing.
 */
const GUEST_SNAPS = ['mounts', 'track', 'edgeMount'] as const

/** Human phrasing per guest kind, so the finding says what the part expected rather than naming a field. */
const EXPECTED: Record<(typeof GUEST_SNAPS)[number], string> = {
  mounts: 'mounts onto a host surface',
  track: 'seats into a conveyor bed',
  edgeMount: 'seats on a host deck edge',
}

/**
 * How close a host has to be to count as one. Generous: this check catches a part
 * placed nowhere near anything and ignores millimetre gaps. A tight tolerance would make it as noisy as a
 * collision test.
 */
const CONTACT_XZ = 0.15
const CONTACT_Y = 0.4

export interface LayoutFinding {
  partId: string
  partName?: string
  /** the package for a package part, else the part's type */
  packageId: string
  /** 'unseated': declares a host and has none. 'column': stands in an interior building column. 'feed': a box feed
   *  drops onto a driven belt without being held with it (a warning). 'endJoinSide': a conveyor's end meets the side
   *  of a bed that takes end joins only, a spur (a warning). */
  kind: 'unseated' | 'column' | 'feed' | 'endJoinSide'
  /** 'error' fails the CLI; 'warning' is reported and does not (unless --strict) */
  severity: 'error' | 'warning'
  detail: string
}

interface WorldBox {
  part: PartInstance
  x0: number
  x1: number
  z0: number
  z1: number
  y0: number
  y1: number
}

/**
 * A part's world-space bounding box. The footprint is local (and may be off-centre via `cx`), so the
 * four corners are taken through the part's own transform and re-bounded: an axis-aligned box of a
 * rotated part, which is what a proximity test wants.
 *
 * Null for anything with no footprint at all: groups, annotations, and any package that will not
 * resolve. A part we cannot measure must never become a finding, to avoid false positives.
 */
function worldBox(part: PartInstance): WorldBox | null {
  let fp: ReturnType<typeof partFootprint>
  try {
    fp = partFootprint(part)
  } catch {
    return null
  }
  if (!fp || (fp.hx === 0 && fp.hz === 0 && fp.y0 === 0 && fp.y1 === 0)) return null
  const cx = fp.cx ?? 0
  const cz = fp.cz ?? 0
  const xs: number[] = []
  const zs: number[] = []
  for (const lx of [cx - fp.hx, cx + fp.hx]) {
    for (const lz of [cz - fp.hz, cz + fp.hz]) {
      const w = toWorldXZ(part, lx, lz)
      xs.push(w.x)
      zs.push(w.z)
    }
  }
  const baseY = part.position?.[1] ?? 0
  return {
    part,
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    z0: Math.min(...zs),
    z1: Math.max(...zs),
    y0: baseY + fp.y0,
    y1: baseY + fp.y1,
  }
}

/** Near enough to be a host: footprints meet or nearly meet in XZ, and the parts are at similar height. */
function inContact(a: WorldBox, b: WorldBox): boolean {
  const xzTouch =
    a.x0 - CONTACT_XZ < b.x1 && b.x0 - CONTACT_XZ < a.x1 && a.z0 - CONTACT_XZ < b.z1 && b.z0 - CONTACT_XZ < a.z1
  if (!xzTouch) return false
  // vertical: overlapping ranges, or a gap small enough to read as "resting on"
  const gap = Math.max(a.y0 - b.y1, b.y0 - a.y1)
  return gap < CONTACT_Y
}

/** The guest kinds this part's package declares, or an empty array. */
function guestKinds(part: PartInstance): (typeof GUEST_SNAPS)[number][] {
  if (part.type !== 'part' || typeof part.packageId !== 'string') return []
  const snap = getPackage(part.packageId)?.snap
  if (!snap) return []
  return GUEST_SNAPS.filter((k) => snap[k] !== undefined)
}

/**
 * Can this part be a host? Two exclusions, both found against the real demo scene:
 *
 * The building encloses the whole scene, so with it eligible nothing is ever reported (a blade stop displaced
 * 20 m from its conveyor came back clean). Cargo is passing traffic: a sensor isn't seated because a box slid
 * under it.
 *
 * Everything else is eligible, including parts that declare nothing: requiring `snap.surfaces` flagged demo
 * sensors seated at zero gap on posts built from `oip.shape`. The declaration says what the guest needs, not
 * what may carry it.
 */
function canHost(part: PartInstance): boolean {
  if (part.type === 'building') return false
  return cargoView(part) === null
}

export interface LayoutCheckOptions {
  /** Tags something drives: the program's outputs and parts' `out` tags (plc/wiring.ts `WiredTag` writers /
   *  programWrites). Given, the box-feed check runs; omitted, it is skipped, since a belt's run tag gates it only
   *  once driven and without this a merely-named tag would read as a stopping belt. */
  drivenTags?: ReadonlySet<string>
  /** Was the program seen driving `feedTag` on while `beltTag` was off? True is evidence ({@link exerciseProgram},
   *  as scripts/check-layout.mjs runs it); false or undefined says nothing was seen. A feed gated by
   *  its own tag, different from its belt's, is reported only on that evidence: its tag may well imply the belt's
   *  (the demo's `LoadFlex` is on only while the line, and so the flex, runs), which no static read can tell. */
  feedRunsWithoutBelt?: (feedTag: string, beltTag: string) => boolean | undefined
}

/** What {@link exerciseProgram} drives: a compiled program's link (plc/link/plcLink.ts LocalPlcLink), structurally. */
export interface ExercisableProgram {
  readonly inputs: readonly string[]
  /** the program's variables by the scene's tag names */
  readonly tagView: Readonly<Record<string, unknown>>
  step(inputs: Readonly<Record<string, boolean | number>>, dt: number): unknown
}

/**
 * Run a program for `scans` scans with its BOOL and numeric inputs flipped at random (seeded, so a run repeats; each
 * input changes about every 3 s of scans, so timers get to run out between changes) and answer, from what was seen,
 * whether it ever drove tag `a` on while tag `b` was off: the {@link LayoutCheckOptions.feedRunsWithoutBelt}
 * evidence. A "no" means nothing was seen, not that it cannot happen. Mutates the program's state: give it a link of
 * its own.
 */
export function exerciseProgram(link: ExercisableProgram, scanSeconds: number, scans = 4000): (a: string, b: string) => boolean {
  let seed = 0x2545f491
  const rnd = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296
  const inputs: Record<string, boolean | number> = {}
  for (const name of link.inputs) {
    const v = link.tagView[name]
    if (typeof v === 'boolean' || typeof v === 'number') inputs[name] = v
  }
  const names = Object.keys(inputs)
  const seen: Readonly<Record<string, unknown>>[] = []
  for (let i = 0; i < scans; i++) {
    for (const name of names) {
      if (rnd() >= 0.03) continue
      inputs[name] = typeof inputs[name] === 'boolean' ? !inputs[name] : Math.round(rnd() * 100) / 10
    }
    link.step(inputs, scanSeconds)
    seen.push({ ...link.tagView })
  }
  const memo = new Map<string, boolean>()
  return (a, b) => {
    const key = `${a}\u0000${b}`
    let hit = memo.get(key)
    if (hit === undefined) memo.set(key, (hit = seen.some((w) => w[a] === true && w[b] === false)))
    return hit
  }
}

/**
 * Report every part that declares it seats onto a host and has none (and, given `drivenTags`, every box feed that
 * is not held with the driven belt it drops onto).
 *
 * A part's own children/parent are not excluded: soft parenting follows a mount rather than replacing
 * it, so a mounted sensor is still expected to be geometrically near the thing it is parented to.
 */
export function checkLayout(parts: readonly PartInstance[], options: LayoutCheckOptions = {}): LayoutFinding[] {
  const boxes: WorldBox[] = []
  for (const p of parts) {
    const b = worldBox(p)
    if (b) boxes.push(b)
  }

  const findings: LayoutFinding[] = []
  for (const box of boxes) {
    const kinds = guestKinds(box.part)
    if (kinds.length === 0) continue // guestKinds already proved this is a package part
    const hosted = boxes.some((other) => other !== box && canHost(other.part) && inContact(box, other))
    if (hosted) continue
    const name = typeof box.part.name === 'string' && box.part.name !== '' ? box.part.name : undefined
    findings.push({
      partId: box.part.id,
      ...(name !== undefined ? { partName: name } : {}),
      packageId: (box.part as { packageId: string }).packageId,
      kind: 'unseated',
      severity: 'error',
      detail: `${EXPECTED[kinds[0]!]}, but nothing is within reach of it`,
    })
  }
  findings.push(...columnFindings(parts))
  findings.push(...endJoinSideFindings(parts))
  if (options.drivenTags) findings.push(...feedFindings(parts, options.drivenTags, options.feedRunsWithoutBelt))
  return findings.sort((a, b) => a.partId.localeCompare(b.partId) || a.kind.localeCompare(b.kind))
}

/** a part must clear a column face by more than this to be reported; touching is not standing in it */
const COLUMN_TOUCH = 0.01
/** thinner than this (m) and a part is flat on the floor - a marking under a column is not a clash */
const FLAT = 0.05

/**
 * Every part whose footprint an interior column passes through. Tested in the part's frame, not with
 * axis-aligned world boxes: a conveyor run diagonally across a bay has a world box covering most of the bay
 * and would otherwise be reported against columns it passes metres away from.
 */
function columnFindings(parts: readonly PartInstance[]): LayoutFinding[] {
  const building = parts.find((p) => p.type === 'building')
  if (!building || building.type !== 'building') return []
  const cols = interiorColumns(building)
  if (cols.length === 0) return []
  const baseY = building.position[1]
  const topY = baseY + interiorColumnHeight(building)
  const world = cols.map((c) => toWorldXZ(building, c.x, c.z))
  const half = INTERIOR_COLUMN_SIZE / 2 - COLUMN_TOUCH
  const out: LayoutFinding[] = []
  for (const part of parts) {
    if (part.type === 'building' || cargoView(part) !== null) continue
    let fp: ReturnType<typeof partFootprint>
    try {
      fp = partFootprint(part)
    } catch {
      continue
    }
    if (!fp || fp.y1 - fp.y0 < FLAT) continue
    const py = part.position?.[1] ?? 0
    if (py + fp.y1 <= baseY || py + fp.y0 >= topY) continue
    const cx = fp.cx ?? 0
    const cz = fp.cz ?? 0
    // separating-axis test of two rectangles in the part's frame: the footprint, and the column square
    // turned by the difference of the two yaws
    const th = building.rotationY - part.rotationY
    const c = Math.abs(Math.cos(th))
    const sn = Math.abs(Math.sin(th))
    const colReach = half * (c + sn) // the column's half-extent along either part axis
    const hit = world.find((w) => {
      const l = toLocalXZ(part, w.x, w.z)
      const dx = l.x - cx
      const dz = l.z - cz
      if (Math.abs(dx) >= fp.hx + colReach || Math.abs(dz) >= fp.hz + colReach) return false
      // ...and along the column's own axes, where the footprint's reach depends on the turn
      const ca = Math.cos(th)
      const sa = Math.sin(th)
      const du = dx * ca - dz * sa
      const dv = dx * sa + dz * ca
      return Math.abs(du) < half + fp.hx * c + fp.hz * sn && Math.abs(dv) < half + fp.hx * sn + fp.hz * c
    })
    if (!hit) continue
    const name = typeof part.name === 'string' && part.name !== '' ? part.name : undefined
    out.push({
      partId: part.id,
      ...(name !== undefined ? { partName: name } : {}),
      packageId: part.type === 'part' ? part.packageId : part.type,
      kind: 'column',
      severity: 'error',
      detail: `stands in the building column at (${hit.x.toFixed(1)}, ${hit.z.toFixed(1)})`,
    })
  }
  return out
}

/** an end faces into a bed's side when its outward direction is within this of the side's inward normal (cos 45°) */
const FACING = Math.SQRT1_2

/**
 * Conveyor ends placed against the side of a bed that takes end joins only (ConveyorBed.endJoinsOnly: a spur, which is
 * itself a merge). Its guard stays closed where another conveyor's end meets its side (guardOpenings.ts), and cargo
 * fed there stops at the guard. The snap engine never seats a side merge there, so this is a part placed by hand or
 * by a script. A warning, since the layout may be meant as a sketch.
 */
function endJoinSideFindings(parts: readonly PartInstance[]): LayoutFinding[] {
  const out: LayoutFinding[] = []
  for (const spur of parts) {
    const bed = bedOf(spur)
    if (!bed?.endJoinsOnly) continue
    const host = bed.guardHost(spur)
    if (!host) continue
    for (const other of parts) {
      if (other === spur || !isConveyorLike(other)) continue
      const meets = conveyorEndsOf(other).some((e) => {
        const at = toLocalXZ(spur, e.x, e.z)
        const side = at.z < 0 ? -1 : 1
        if (Math.abs(Math.abs(at.z) - host.hw) > CONTACT_XZ) return false
        const [lo, hi] = side < 0 ? host.sides.left : host.sides.right
        if (at.x / host.slope < lo - CONTACT_XZ || at.x / host.slope > hi + CONTACT_XZ) return false
        if (Math.abs(e.y - spur.position[1]) > CONTACT_Y) return false
        // the end points into the bed, across its side, not along it (a bed parked alongside)
        const tip = toLocalXZ(spur, e.x + e.outX, e.z + e.outZ)
        return (tip.z - at.z) * side < -FACING
      })
      if (!meets) continue
      const name = typeof other.name === 'string' && other.name !== '' ? other.name : undefined
      const spurName = typeof spur.name === 'string' && spur.name !== '' ? `${spur.name} (${spur.id})` : spur.id
      out.push({
        partId: other.id,
        ...(name !== undefined ? { partName: name } : {}),
        packageId: other.type === 'part' ? other.packageId : other.type,
        kind: 'endJoinSide',
        severity: 'warning',
        detail: `its end meets the side of ${spurName}, a ${bed.kind} conveyor that takes end joins only, so its guard stays closed there: merge onto a straight or a belt instead`,
      })
    }
  }
  return out
}

/** A param's value on the instance, else its package default. */
function paramOf(part: PartInstance, key: string): unknown {
  if (part.type !== 'part') return undefined
  const v = (part.params as Record<string, unknown> | undefined)?.[key]
  if (v !== undefined) return v
  return (getPackage(part.packageId)?.params[key] as { default?: unknown } | undefined)?.default
}

/** The run tag a part's program gate reads, when its comms are on and it names one; else ''. */
function runTagOf(part: PartInstance): string {
  const t = paramOf(part, 'runTag')
  return typeof t === 'string' && commsOn(part) ? t.trim() : ''
}

/** how far above a belt's top a feed may sit and still be dropping onto it (m) */
const DROP_REACH = 3

/**
 * The conveyor a feed drops onto: the highest conveyor-like part whose footprint (tested in its own frame) holds the
 * feed's XZ and whose top is at or below the feed. A box falls straight down from the feed's pose (the spawner's
 * spawn offset is vertical only).
 */
function dropTarget(feed: PartInstance, parts: readonly PartInstance[]): PartInstance | null {
  const [fx, fy, fz] = feed.position
  let best: PartInstance | null = null
  let bestTop = -Infinity
  for (const c of parts) {
    // isConveyorLike is the snap engine's set, which leaves out a flex conveyor; a declared `conveyor` block covers it
    if (c === feed || c.type !== 'part' || !(isConveyorLike(c) || getPackage(c.packageId)?.conveyor)) continue
    let fp: ReturnType<typeof partFootprint>
    try {
      fp = partFootprint(c)
    } catch {
      continue
    }
    const l = toLocalXZ(c, fx, fz)
    if (Math.abs(l.x - (fp.cx ?? 0)) > fp.hx || Math.abs(l.z - (fp.cz ?? 0)) > fp.hz) continue
    const top = c.position[1] + fp.y1
    if (top > fy + 0.05 || fy - top > DROP_REACH || top <= bestTop) continue
    best = c
    bestTop = top
  }
  return best
}

/**
 * Box feeds that drop onto a belt something drives (so the belt stops and starts) without being held with it.
 * The box spawner holds while its `conveyorId` conveyor is stopped, or while a driven `runTag` is off; while held,
 * `keepSpacing` off lets its interval run down to zero, so the first box after the hold drops at once. Three cases:
 *
 *   - nothing holds it (no `conveyorId`, no driven `runTag`): boxes stack on the belt whenever it stops;
 *   - its own `runTag` differs from the belt's and the program was seen driving it on with the belt off: the same,
 *     whenever that happens (an agent's merge: feed = Running, belt = Running AND NOT eye);
 *   - held with the belt explicitly (`conveyorId` = the belt, or the belt's own run tag) but `keepSpacing` off: the
 *     first box after a restart lands on the one the stopped belt still carries under the drop. Explicit pairing
 *     only: through program logic (a copy, an implication) this check cannot tell a belt stopped every cycle from
 *     one stopped by an E-stop, and the box spawner's own doc names this pairing as where keepSpacing belongs.
 *     Not while `keepSpacing` is switched out (the spawner's On each enable release, which drops at every enable on
 *     purpose and ignores it): then it is neither the cause nor the fix.
 */
function feedFindings(parts: readonly PartInstance[], driven: ReadonlySet<string>, seen: LayoutCheckOptions['feedRunsWithoutBelt']): LayoutFinding[] {
  const byId = new Map(parts.map((p) => [p.id, p]))
  const out: LayoutFinding[] = []
  for (const feed of parts) {
    if (feed.type !== 'part') continue
    const pkg = getPackage(feed.packageId)
    if (!pkg || !('keepSpacing' in pkg.params)) continue
    if (paramOf(feed, 'disable') === true || paramOf(feed, 'boxesPerMinute') === 0) continue
    const belt = dropTarget(feed, parts)
    if (!belt) continue
    const beltTag = runTagOf(belt)
    if (beltTag === '' || !driven.has(beltTag)) continue // a belt nobody drives runs on its own params
    const beltName = typeof belt.name === 'string' && belt.name !== '' ? `${belt.name} (${belt.id})` : belt.id
    const refId = paramOf(feed, 'conveyorId')
    const ref = typeof refId === 'string' && refId !== '' ? byId.get(refId) : undefined
    // its interlock names this belt, or a conveyor switched by the same tag
    const interlocked = ref !== undefined && (ref.id === belt.id || runTagOf(ref) === beltTag)
    const feedTag = runTagOf(feed)
    const gated = feedTag !== '' && driven.has(feedTag) // a merely-named tag gates nothing (the spawner's runTag doc)
    // keepSpacing counts only while its switch shows it, the rule the Inspector shows it by
    const specs = packageParamSpecs(pkg)
    const vw = specs.find((s) => s.key === 'keepSpacing')?.visibleWhen
    const spacing = visibleWhenHolds(vw, vw ? switchValue(specs, feed.params, vw.param) : undefined)
    const keep = paramOf(feed, 'keepSpacing') === true
    const fix = spacing
      ? `Fix: conveyorId = "${belt.id}"${keep ? '' : ' and keepSpacing = true'} (holds the feed while the belt is stopped, and keeps one pitch between boxes across the stop)`
      : `Fix: conveyorId = "${belt.id}" (holds the feed while the belt is stopped)`
    let detail: string
    if (interlocked || (gated && feedTag === beltTag)) {
      if (keep || !spacing) continue
      detail =
        `holds with ${beltName} (${interlocked ? `conveyorId "${ref!.id}"` : `runTag "${beltTag}"`}) but keepSpacing is off: ` +
        'while held its interval runs down, so the first box after the belt restarts drops at once, onto the box ' +
        'still under the drop. Fix: keepSpacing = true'
    } else if (!gated) {
      detail = `drops boxes onto ${beltName}, whose runTag "${beltTag}" is driven, and nothing holds it (no conveyorId, no driven runTag): whenever the belt stops, boxes stack at the drop point. ${fix}`
    } else if (seen?.(feedTag, beltTag) === true) {
      detail = `drops boxes onto ${beltName} but runs on its own runTag "${feedTag}", which the program drives on while the belt's "${beltTag}" is off: whenever it does, boxes stack at the drop point. ${fix}`
    } else continue
    const name = typeof feed.name === 'string' && feed.name !== '' ? feed.name : undefined
    out.push({ partId: feed.id, ...(name !== undefined ? { partName: name } : {}), packageId: feed.packageId, kind: 'feed', severity: 'warning', detail })
  }
  return out
}

/** One finding as a CLI line. */
export function formatLayoutFinding(f: LayoutFinding): string {
  const who = f.partName !== undefined ? `${f.partName} (${f.partId})` : f.partId
  return `${who} [${f.packageId}]: ${f.detail}`
}
