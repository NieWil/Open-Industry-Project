// Golden table for the two "a neighbour cuts this part" systems, to hold while they are generalized into one
// (an SDK review: `railing` / `stairFoot` / `stairMount` and the conveyor guard openings are two
// parallel mechanisms, each tied to one pairing). Whatever replaces them must reproduce this file.
//
//   1. Structure: a staircase meeting a platform. Per scenario, what computeStructureConnections derives (railing
//      openings per edge, deck notches, each stair's lift) and what structureCutGeo hands the sim and the walking
//      pilot as the cut rig (the links that changed, were added or were removed). The renderer cuts the railing in
//      place from the same openings (rig.ts); its gates are verify-stairs-* / verify-platform-*.
//   2. Guards: a conveyor end (or a guard-mounted pusher) meeting another conveyor's side. Per scenario, the
//      host's guard openings (deriveGuardOpenings) and the mover's own guard extents (deriveGuardExtents).
//
// Real bundled parts, placed by hand at fixed poses (not through the snap engine or the demo scene, so the table
// moves only when these two systems do). Every scenario that is meant to connect is asserted to, so the table
// can never quietly pin a set of empty results. To accept an intended change: `npx vitest run -u <this file>`,
// then read the diff.

import { beforeAll, describe, expect, it } from 'vitest'
import { deriveGuardExtents, hostSurfaceY } from '../core/guards/guardExtents'
import { deriveGuardOpenings, isOpener } from '../core/guards/guardOpenings'
import type { PartPackage, RigLink } from '../core/parts/partPackage'
import { conveyorEndsOf, guardPusherContacts, isConveyorLike, toWorldXZ } from '../core/parts/partGeometry'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import { computeStructureConnections } from '../core/structureConnections'
import type { StructureConnections } from '../core/structureConnections'
import { structureCutGeo } from '../core/structureCuts'
import type { PartInstance } from '../core/types'
import { STAIRS_STANDARD_TREAD } from '../core/types'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledManifests } from './parts/bundledExamples'

type RigGeo = Extract<PartPackage['geometry'], { kind: 'rig' }>

const byId = new Map<string, PartPackage>()
const pkg = (id: string): PartPackage => {
  const p = byId.get(id)
  if (!p) throw new Error(`structure golden: no bundled package ${id}`)
  return p
}

beforeAll(() => {
  clearPackages()
  const behaviors = bundledBehaviors()
  for (const m of bundledManifests()) {
    const p = buildPackage(m, behaviors.get(m.id)!)
    byId.set(p.id, p)
    registerPackage(p)
  }
})

// ---- formatting: fixed precision, sorted keys, so the table is stable text ------------------------------------

const fx = (n: number): string => (Math.abs(n) < 5e-5 ? '0' : n.toFixed(4))
function fmt(v: unknown): string {
  if (typeof v === 'number') return fx(v)
  if (Array.isArray(v)) return `[${v.map(fmt).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${k}:${fmt((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return String(v)
}

const PI = Math.PI

function place(id: string, partId: string, position: [number, number, number], rotationY: number, params: Record<string, unknown> = {}): PartInstance {
  const inst = createSdkPart(pkg(id), partId, position, rotationY)
  Object.assign(inst.params, params)
  return inst as unknown as PartInstance
}

// ---- 1. structure: staircase meets platform -------------------------------------------------------------------

const DECK_Y = 2 // a default platform's deck top sits at its origin: its height param is 2

/** a staircase whose seat (the top of its run, the point that butts a deck edge: its edgeMount `at`) sits at world (x, z) */
function stairSeatedAt(partId: string, seat: { x: number; z: number }, rotationY: number, params: { numSteps?: number; width?: number } = {}, footY = 0): PartInstance {
  const steps = params.numSteps ?? 11
  const probe = place('oip.stairs', partId, [0, footY, 0], rotationY, params)
  const off = toWorldXZ(probe, steps * STAIRS_STANDARD_TREAD, 0)
  return place('oip.stairs', partId, [seat.x - off.x, footY, seat.z - off.z], rotationY, params)
}

/** what the sim is handed for one part: its cut rig, reported as the links that differ from the package's */
function cutDiff(part: PartInstance, conn: StructureConnections): string[] {
  const geo = pkg((part as { packageId: string }).packageId).geometry as RigGeo
  const cut = structureCutGeo(geo, part.id, part.params as Record<string, unknown>, conn)
  const before = new Map(geo.links.map((l) => [l.name, fmt(l)]))
  const after = new Map(cut.links.map((l: RigLink) => [l.name, fmt(l)]))
  const out: string[] = []
  for (const [name, desc] of after) {
    if (!before.has(name)) out.push(`  + ${desc}`)
    else if (before.get(name) !== desc) out.push(`  ~ ${desc}`)
  }
  for (const name of before.keys()) if (!after.has(name)) out.push(`  - ${name}`)
  return out
}

interface StructureCase {
  name: string
  parts: () => PartInstance[]
  /** false for the negative cases: nothing may connect */
  connects: boolean
}

const platform = (rotationY = 0, params: Record<string, unknown> = {}): PartInstance => place('oip.platform', 'plat', [0, DECK_Y, 0], rotationY, params)

const STRUCTURE: StructureCase[] = [
  // edge-flush: the landing's far end on each edge centre, the flight outside the deck rising toward it
  { name: 'stair onto +X edge', connects: true, parts: () => [platform(), stairSeatedAt('s1', { x: 2, z: 0 }, PI)] },
  { name: 'stair onto -X edge', connects: true, parts: () => [platform(), stairSeatedAt('s1', { x: -2, z: 0 }, 0)] },
  { name: 'stair onto +Z edge', connects: true, parts: () => [platform(), stairSeatedAt('s1', { x: 0, z: 2 }, PI / 2)] },
  { name: 'stair onto -Z edge', connects: true, parts: () => [platform(), stairSeatedAt('s1', { x: 0, z: -2 }, -PI / 2)] },
  // off-centre along the edge, far enough that the gap clamps at the corner
  { name: 'stair at the +X edge corner (gap clamped)', connects: true, parts: () => [platform(), stairSeatedAt('s1', { x: 2, z: 1.7 }, PI)] },
  // two flights on one edge whose gaps overlap: the openings merge
  { name: 'two stairs, overlapping gaps on one edge', connects: true, parts: () => [platform(), stairSeatedAt('s1', { x: 2, z: -0.4 }, PI), stairSeatedAt('s2', { x: 2, z: 0.4 }, PI)] },
  // a wider flight, and a different step count (a different lift residual)
  { name: 'wide stair (2.5 m)', connects: true, parts: () => [platform(), stairSeatedAt('s1', { x: 2, z: 0 }, PI, { width: 2.5 })] },
  { name: 'platform at 1.8 m, 10 steps', connects: true, parts: () => [place('oip.platform', 'plat', [0, 1.8, 0], 0, { height: 1.8 }), stairSeatedAt('s1', { x: 2, z: 0 }, PI, { numSteps: 10 })] },
  // a rotated platform, and a flight meeting an edge at an angle
  { name: 'platform turned 90 degrees', connects: true, parts: () => [platform(PI / 2), stairSeatedAt('s1', { x: 2, z: 0 }, PI)] },
  { name: 'stair at 30 degrees to the edge', connects: true, parts: () => [platform(), stairSeatedAt('s1', { x: 2, z: 0 }, PI + PI / 6)] },
  // a flight rising through the deck from the floor: the deck is notched (the stairwell)
  { name: 'stair through the deck (notch)', connects: true, parts: () => [platform(0, { length: 6, width: 6 }), place('oip.stairs', 's1', [-2.5, 0, 0], 0)] },
  // negatives: the top misses the deck height; the seat is nowhere near an edge
  { name: 'NEGATIVE: top well below the deck', connects: false, parts: () => [platform(), stairSeatedAt('s1', { x: 2, z: 0 }, PI, { numSteps: 7 })] },
  { name: 'NEGATIVE: seat far from every edge', connects: false, parts: () => [platform(), stairSeatedAt('s1', { x: 4, z: 0 }, PI)] },
]

function structureTable(): string {
  const lines: string[] = []
  for (const c of STRUCTURE) {
    const parts = c.parts()
    const conn = computeStructureConnections(parts)
    lines.push(`## ${c.name}`)
    for (const [id, p] of [...conn.platform].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`platform ${id}: openings ${fmt(p.openings)} notches ${fmt(p.notches)}`)
    }
    for (const [id, lift] of [...conn.stairTopConnected].sort(([a], [b]) => a.localeCompare(b))) lines.push(`stair ${id}: lift ${fx(lift)}`)
    const connected = conn.platform.size + conn.stairTopConnected.size > 0
    if (connected !== c.connects) throw new Error(`structure golden: "${c.name}" ${c.connects ? 'did not connect' : 'connected'}: fix the scenario`)
    for (const part of parts) {
      const diff = cutDiff(part, conn)
      if (diff.length) lines.push(`cut ${part.id}:`, ...diff)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---- 2. guards: a conveyor end meets another conveyor's side ---------------------------------------------------

const HOST_LENGTH = 6

/** a mover whose end facing -Z (or +Z) butts the host's side at host-local x, at the host's surface height */
function butted(id: string, partId: string, host: PartInstance, x: number, side: 'left' | 'right', params: Record<string, unknown> = {}, pusher = false): PartInstance {
  // the end has to point into the host: from the left (-Z) side it points +Z, from the right it points -Z
  const want = side === 'left' ? 1 : -1
  for (const yaw of [0, PI / 2, PI, -PI / 2]) {
    const probe = place(id, partId, [0, 0, 0], yaw, params)
    const ends = pusher ? guardPusherContacts(probe) : conveyorEndsOf(probe)
    const end = ends.find((e) => Math.abs(e.outX) < 1e-6 && Math.sign(e.outZ) === want)
    if (!end) continue
    const hw = hostHalfWidth(host)
    const z = side === 'left' ? -hw : hw
    const y = hostSurfaceY(host, x) - end.y
    return place(id, partId, [x - end.x, y, z - end.z], yaw, params)
  }
  throw new Error(`guard golden: ${id} has no end that can face the host's ${side} side`)
}

/** the host bed's half width, from its width param (both straight conveyors name it `width`) */
function hostHalfWidth(host: PartInstance): number {
  return (host.params as Record<string, unknown>).width as number / 2
}

interface GuardCase {
  name: string
  parts: () => { host: PartInstance; movers: PartInstance[] }
  /** the guards that must come out opened: every mover's side, so a mover that misses cannot hide behind another */
  opens: ('left' | 'right')[]
}

const belt = (params: Record<string, unknown> = {}): PartInstance => place('oip.belt-conveyor', 'host', [0, 0, 0], 0, { ...params })
// a roller bed's origin is its centre (a belt's is its tail), so its x runs -3..3 here
const roller = (params: Record<string, unknown> = {}): PartInstance => place('oip.roller-conveyor', 'host', [0, 0, 0], 0, { length: HOST_LENGTH, ...params })

const GUARDS: GuardCase[] = [
  { name: 'spur onto a belt, left side', opens: ['left'], parts: () => { const host = belt(); return { host, movers: [butted('oip.spur-conveyor', 'm1', host, 2, 'left')] } } },
  { name: 'spur onto a roller bed, right side', opens: ['right'], parts: () => { const host = roller(); return { host, movers: [butted('oip.spur-conveyor', 'm1', host, 0.5, 'right')] } } },
  { name: 'roller T into a roller bed, left side', opens: ['left'], parts: () => { const host = roller(); return { host, movers: [butted('oip.roller-conveyor', 'm1', host, 0, 'left', { length: 2 })] } } },
  { name: 'belt T into a roller bed, right side', opens: ['right'], parts: () => { const host = roller(); return { host, movers: [butted('oip.belt-conveyor', 'm1', host, -0.5, 'right')] } } },
  { name: 'two movers on opposite sides', opens: ['left', 'right'], parts: () => { const host = roller(); return { host, movers: [butted('oip.roller-conveyor', 'm1', host, -1.5, 'left', { length: 2 }), butted('oip.roller-conveyor', 'm2', host, 1.5, 'right', { length: 2 })] } } },
  // near the bed's end: the gap clamps at the end of the guard
  { name: 'roller T at the very end of a roller bed', opens: ['left'], parts: () => { const host = roller(); return { host, movers: [butted('oip.roller-conveyor', 'm1', host, 2.8, 'left', { length: 2 })] } } },
  // the host's own authored openings (the Side-Guards gizmo's rows, tail-relative): folded into the same result
  { name: 'authored opening on a roller bed', opens: ['left', 'right'], parts: () => ({ host: roller({ guardOpenings: [[1, 2, -1], [3.5, 4.5, 0]] }), movers: [] }) },
  { name: 'NEGATIVE: mover end short of the side', opens: [], parts: () => { const host = roller(); const m = butted('oip.roller-conveyor', 'm1', host, 0, 'left', { length: 2 }); m.position[2] -= 0.5; return { host, movers: [m] } } },
]

function guardTable(): string {
  const lines: string[] = []
  for (const c of GUARDS) {
    const { host, movers } = c.parts()
    const all = [host, ...movers]
    const openings = deriveGuardOpenings(host, all)
    lines.push(`## ${c.name}`)
    lines.push(`host ${(host as { packageId: string }).packageId}: openings ${fmt(openings)}`)
    for (const m of movers) {
      if (!isOpener(m)) throw new Error(`guard golden: ${m.id} is not an opener`)
      if (isConveyorLike(m)) lines.push(`mover ${m.id} ${(m as { packageId: string }).packageId}: extents ${fmt(deriveGuardExtents(m, all))}`)
    }
    const opened = (['left', 'right'] as const).filter((side) => openings[side].length > 0)
    if (fmt(opened) !== fmt(c.opens)) throw new Error(`guard golden: "${c.name}" opened ${fmt(opened)}, meant ${fmt(c.opens)}: fix the scenario`)
    lines.push('')
  }
  return lines.join('\n')
}

describe('neighbour-cut golden table (the baseline the generalized system must reproduce)', () => {
  it('staircase meets platform: openings, notches, lifts, and the cut rig the sim builds from', async () => {
    await expect(structureTable()).toMatchFileSnapshot('./__snapshots__/structureGolden.structure.txt')
  })
  it('conveyor meets conveyor: guard openings and the mover guard extents', async () => {
    await expect(guardTable()).toMatchFileSnapshot('./__snapshots__/structureGolden.guards.txt')
  })
})
