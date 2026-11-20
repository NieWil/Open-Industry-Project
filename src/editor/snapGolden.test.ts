import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PartPackage } from '../core/parts/partPackage'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { isConveyorLike, partFootprint } from '../core/parts/partGeometry'
import { subtreeIds } from '../core/scene/hierarchy'
import { createSdkPart } from '../core/scene/scene'
import { findSnap } from '../core/snap/snapFeatures'
import type { SnapCandidate, SnapOptions, SnapPose } from '../core/snap/snapFeatures'
import type { PartInstance } from '../core/types'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledManifests } from './parts/bundledExamples'
import { createPlcDemoScene } from './demo/demoScenes'

// The snap golden table: what the snap engine (core/snap/snapFeatures.ts findSnap) answers for the real shipped parts,
// pinned in __snapshots__/snapGolden.{pairwise,demo}.txt.
//
// Why it exists. snapFeatures.test.ts proves each snap kind on synthetic packages, so it misses a real part that
// has lost its declaration while the engine still works, a bug that has shipped twice (docs in
// bundledPackageData.test.ts SNAP_KIND_OWNER). It is also the harness a rewrite of the engine is judged against: a
// refactor of the dispatch (the move to a connector model) must leave this file unchanged, and any line it does
// change is either a regression or a deliberate behaviour change that gets explained in the same commit.
//
// What it pins, over three sweeps:
//   1. Pairwise: every specimen (each bundled part at its defaults, plus the variants below that reach branches
//      the defaults don't) is dropped at ~180 probe poses around every specimen as host (see probes()). The host sits off-axis
//      (translated, yawed 0.4 rad) so every local/world transform is exercised. Only snaps are written; a
//      (mover, host) pair that never snaps is absent, so a pair that starts snapping shows up as new lines.
//   2. Demo scene: every snapping part of the shipped demo is nudged off its authored pose and re-snapped against
//      the whole scene (205 parts): target ranking, neighbour-resolved roller grids, groups in the list.
//   3. The option switch: an ambient `flush` mover with the face-snap toggle off must not snap at all.
//
// Synthetic specimens (id prefix `golden.`) cover the SDK-only paths no shipped part reaches: `edgeMount`, a
// declared `surfaces` rail on a non-conveyor host, and a device with two mounts of different kinds.
//
// Regenerate after a deliberate change: npx vitest run src/editor/snapGolden.test.ts -u, then read the diff.

const HOST_POS: [number, number, number] = [1.3, 0, -0.7]
const HOST_YAW = 0.4

interface Specimen {
  /** row label: the package id, plus the variant's name */
  name: string
  pkg: PartPackage
  params?: Record<string, unknown>
  /** host origin height (a platform's origin is its deck top) */
  y?: number
}

const fx = (n: number): string => {
  const s = n.toFixed(6)
  return s === '-0.000000' ? '0.000000' : s
}
const fv = (v: readonly number[]): string => `(${v.map(fx).join(',')})`
const fparams = (o: Record<string, unknown> | undefined): string =>
  o === undefined
    ? ''
    : '{' +
      Object.keys(o)
        .sort()
        .map((k) => `${k}=${typeof o[k] === 'number' ? fx(o[k] as number) : String(o[k])}`)
        .join(',') +
      '}'

function fmt(c: SnapCandidate | null): string {
  if (c === null) return 'null'
  let s = `-> ${c.targetId} p=${fv(c.pose.position)} yaw=${fx(c.pose.rotationY)} cost=${fx(c.cost)} j=${fv([c.junction.x, c.junction.y, c.junction.z])}`
  if (c.override) s += ' override'
  if (c.attach) s += ' attach'
  if (c.paramOverrides) s += ` fit=${fparams(c.paramOverrides)}`
  if (c.targetParamOverrides) s += ` hostFit=${fparams(c.targetParamOverrides)}`
  if (c.pose.rotationX !== undefined || c.pose.rotationZ !== undefined) s += ` tilt=${fx(c.pose.rotationX ?? 0)},${fx(c.pose.rotationZ ?? 0)}`
  return s
}

function instance(sp: Specimen, id: string, position: [number, number, number], rotationY: number): PartInstance {
  const inst = createSdkPart(sp.pkg, id, position, rotationY)
  if (sp.params) Object.assign(inst.params, sp.params)
  return inst as unknown as PartInstance
}

let pkgs: PartPackage[] = []
let specimens: Specimen[] = []

function synthetic(byId: Map<string, PartPackage>): PartPackage[] {
  const rail = byId.get('oip.guard-rail')!
  const shape = byId.get('oip.shape')!
  const sensor = byId.get('oip.diffuse-sensor')!
  return [
    // a barrier that seats along a deck rim (snap.edgeMount has no shipped declarer: SNAP_KIND_OWNER SDK_ONLY)
    { ...rail, id: 'golden.edge-mount-rail', snap: { edgeMount: { accepts: 'deck', alongParam: 'length', reach: 3, outwardOffset: 0.04 } } },
    // a non-conveyor host advertising a guard rail a sensor can land on (a stand / bracket)
    { ...shape, id: 'golden.guard-stand', snap: { surfaces: [{ kind: 'conveyorGuard', lengthParam: 'length', widthParam: 'width' }] } },
    // a device with two mounts of different kinds: every mount is tried, the best-fitting wins
    {
      ...sensor,
      id: 'golden.two-mount-sensor',
      snap: {
        mounts: [
          { at: [0, 0, 0.037], accepts: 'conveyorGuard', face: 'in', outwardOffset: 0.02, fitRangeParam: 'maxRange' },
          { at: [0, 0.05, -0.02], accepts: 'face', face: 'out', attach: true },
        ],
      },
    },
  ] as PartPackage[]
}

beforeAll(() => {
  clearPackages()
  // the shipped catalog, built the way the app builds it (bundledExamples is the sanctioned way to read the data)
  const behaviors = bundledBehaviors()
  const real = bundledManifests().map((m) => buildPackage(m, behaviors.get(m.id)!))
  const byId = new Map(real.map((p) => [p.id, p]))
  pkgs = [...real, ...synthetic(byId)]
  for (const p of pkgs) registerPackage(p)
  const get = (id: string): PartPackage => {
    const p = byId.get(id)
    if (!p) throw new Error(`golden: no bundled package ${id}`)
    return p
  }
  specimens = [
    ...pkgs.map((pkg) => ({ name: pkg.id, pkg, ...(pkg.id === 'oip.platform' ? { y: 2 } : {}) })),
    // branches the defaults never reach
    { name: 'oip.roller-conveyor~tilt12', pkg: get('oip.roller-conveyor'), params: { tiltDeg: 12 } },
    { name: 'oip.roller-conveyor~short-narrow', pkg: get('oip.roller-conveyor'), params: { length: 1.6, width: 0.8 } },
    { name: 'oip.belt-conveyor~incline', pkg: get('oip.belt-conveyor'), params: { segments: [[2, 0], [2, 15], [1.5, -15]] } },
    { name: 'oip.curved-conveyor~reversed', pkg: get('oip.curved-conveyor'), params: { reverse: true } },
    { name: 'oip.curved-roller-conveyor~sweep45', pkg: get('oip.curved-roller-conveyor'), params: { sweepDeg: 45, innerRadius: 1.2 } },
    { name: 'oip.spur-conveyor~splay', pkg: get('oip.spur-conveyor'), params: { angleFrontDeg: -20, angleBackDeg: 15 } },
    { name: 'oip.chain-transfer~4lanes', pkg: get('oip.chain-transfer'), params: { chains: 4, distance: 0.2 } },
    { name: 'oip.platform~tall', pkg: get('oip.platform'), params: { height: 3.5, length: 3, width: 2 }, y: 3.5 },
    { name: 'oip.floor-marking~small', pkg: get('oip.floor-marking'), params: { length: 3, width: 1 } },
    { name: 'oip.stairs~short', pkg: get('oip.stairs'), params: { numSteps: 4 } },
    { name: 'oip.guard-rail~2m', pkg: get('oip.guard-rail'), params: { length: 2 } },
    { name: 'oip.turntable-conveyor~turned', pkg: get('oip.turntable-conveyor'), params: { deckAngleDeg: 90 } },
  ]
  for (const sp of specimens) {
    for (const key of Object.keys(sp.params ?? {})) {
      if (!(key in createSdkPart(sp.pkg, 'k', [0, 0, 0]).params)) throw new Error(`golden: ${sp.name} sets unknown param ${key}`)
    }
  }
})

afterAll(() => clearPackages())

/**
 * The probe poses for one (mover, host) pair, in the host's frame:
 * - Fixed: 15 plan points (inside, on and past each face) x 2 heights x 4 yaws, the same for every mover.
 * - Adjacent: for each of the 4 yaws, the 8 spots where the mover's own footprint would sit just clear of the
 *   host (butting each face centrally, and alongside each end at a corner) x 2 heights. Without these a
 *   short-reach kind (a fence chains within 1 m) is never offered a pose near its mate and pins nothing.
 */
function probes(host: PartInstance, mover: PartInstance): SnapPose[] {
  const fp = partFootprint(host)
  const mfp = partFootprint(mover)
  const cx = fp.cx ?? 0
  // the host's top, its origin, and the world floor (a stair's foot stands there below a raised deck)
  const ys = [...new Set([host.position[1] + fp.y1, host.position[1], 0])]
  const c = Math.cos(host.rotationY)
  const s = Math.sin(host.rotationY)
  const out: SnapPose[] = []
  // local -> world with the scene's yaw convention (rotXZ: x' = x cos + z sin, z' = -x sin + z cos)
  const push = (lx: number, lz: number, k: number): void => {
    const wx = host.position[0] + lx * c + lz * s
    const wz = host.position[2] - lx * s + lz * c
    for (const y of ys) out.push({ position: [wx, y, wz], rotationY: host.rotationY + (k * Math.PI) / 2 + 0.1 })
  }
  for (const lx of [cx - fp.hx - 0.25, cx - fp.hx * 0.5, cx, cx + fp.hx * 0.5, cx + fp.hx + 0.25]) {
    for (const lz of [-fp.hz - 0.25, 0, fp.hz + 0.25]) {
      for (let k = 0; k < 4; k++) push(lx, lz, k)
    }
  }
  for (let k = 0; k < 4; k++) {
    // the mover's half-extents along the host's axes at this yaw (a quarter turn swaps them)
    const ax = (k % 2 === 0 ? mfp.hx : mfp.hz) + 0.15
    const az = (k % 2 === 0 ? mfp.hz : mfp.hx) + 0.15
    for (const sx of [-1, 1]) {
      push(cx + sx * (fp.hx + ax), 0, k)
      push(cx + sx * fp.hx, sx * (fp.hz + az), k)
    }
    for (const sz of [-1, 1]) {
      push(cx, sz * (fp.hz + az), k)
      push(cx - sz * fp.hx, sz * (fp.hz + az), k)
    }
  }
  return out
}

/** the pairwise sweep: every snapped probe's line, grouped by `<mover> onto <host>` (pairs that never snap are absent) */
function pairwise(opts?: SnapOptions, only?: (sp: Specimen) => boolean): Map<string, string[]> {
  const pairs = new Map<string, string[]>()
  for (const hs of specimens) {
    const host = instance(hs, 'host', [HOST_POS[0], hs.y ?? HOST_POS[1], HOST_POS[2]], HOST_YAW)
    for (const ms of specimens) {
      if (only && !only(ms)) continue
      const key = `${ms.name} onto ${hs.name}`
      probes(host, instance(ms, 'mover', [0, 0, 0], 0)).forEach((pose, i) => {
        const mover = instance(ms, 'mover', pose.position, pose.rotationY)
        const c = findSnap(mover, pose, [host], opts)
        if (c === null) return
        const lines = pairs.get(key) ?? []
        lines.push(`${key} #${i} ${fmt(c)}`)
        pairs.set(key, lines)
      })
    }
  }
  return pairs
}

/**
 * The committed form of the sweep. The full table is ~40k lines (6 MB), too big to review as a fixture, so each
 * pair is pinned as its snapped-probe count plus a hash of its exact lines, with a per-mover total on top. Any
 * change to any probe of a pair changes that pair's line. The detail is one command away: the failure message
 * names the changed pairs, and SNAP_GOLDEN_DETAIL=<file> writes every line of the current table there.
 */
function digest(pairs: Map<string, string[]>): string {
  const perMover = new Map<string, number>()
  const rows: string[] = []
  for (const [key, lines] of pairs) {
    const mover = key.slice(0, key.indexOf(' onto '))
    perMover.set(mover, (perMover.get(mover) ?? 0) + lines.length)
    rows.push(`${key}: ${lines.length} ${createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16)}`)
  }
  const summary = [...perMover.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, k]) => `# ${n}: ${k} snapped probes`)
  return [...summary, ...rows.sort()].join('\n') + '\n'
}

/** does this part take part in snapping as a mover at all (declares a mover-side kind, or is a conveyor)? */
function snapsAsMover(part: PartInstance): boolean {
  if (part.type !== 'part') return false
  const snap = pkgs.find((p) => p.id === part.packageId)?.snap
  return isConveyorLike(part) || !!(snap && (snap.mounts || snap.track || snap.tile || snap.chain || snap.edgeMount || snap.flush))
}

describe('snap golden table (real parts through the real engine)', () => {
  it('pairwise: every specimen dropped around every specimen', async () => {
    const pairs = pairwise()
    const table = digest(pairs)
    // non-vacuity: every mover-side kind, and conveyor ends, must produce snaps, or this table guards nothing
    for (const name of ['oip.roller-conveyor', 'oip.curved-conveyor', 'oip.spur-conveyor', 'oip.turntable-conveyor', 'oip.laser-sensor', 'oip.diverter',
      'oip.push-button', 'oip.blade-stop', 'oip.chain-transfer', 'oip.floor-marking', 'oip.platform', 'oip.fence', 'oip.guard-rail', 'oip.stairs',
      'oip.rack', 'golden.edge-mount-rail', 'golden.two-mount-sensor']) {
      expect(table, `${name} never snaps in the sweep`).toMatch(new RegExp(`^# ${name.replace(/\./g, '\\.')}: \\d+ snapped`, 'm'))
    }
    expect(table, 'a sensor must land on the declared guard stand').toMatch(/^oip\.laser-sensor onto golden\.guard-stand: /m)
    const detail = process.env.SNAP_GOLDEN_DETAIL
    if (detail) writeFileSync(detail, [...pairs.values()].flat().join('\n') + '\n')

    // say which pairs moved before the snapshot compare does (a digest diff alone reads as hashes)
    const file = fileURLToPath(new URL('./__snapshots__/snapGolden.pairwise.txt', import.meta.url))
    // (skipped under -u: vitest's own update mode, which the worker's argv doesn't carry)
    const updating = (expect.getState() as unknown as { snapshotState?: { _updateSnapshot?: string } }).snapshotState?._updateSnapshot === 'all'
    if (existsSync(file) && !updating) {
      const was = new Map(readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.lastIndexOf(': ')), l]))
      const now = new Map(table.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.lastIndexOf(': ')), l]))
      const changed = [...new Set([...was.keys(), ...now.keys()])].filter((k) => was.get(k) !== now.get(k)).sort()
      if (changed.length > 0) {
        const sample = changed.slice(0, 3).flatMap((k) => (pairs.get(k) ?? [`${k}: now snaps NOWHERE`]).slice(0, 4))
        expect.fail(
          `${changed.length} (mover, host) pair(s) snap differently than the golden table:\n  ${changed.slice(0, 40).join('\n  ')}` +
            `${changed.length > 40 ? `\n  ... and ${changed.length - 40} more` : ''}\n` +
            `first lines as they are NOW:\n  ${sample.join('\n  ')}\n` +
            `Full current table: SNAP_GOLDEN_DETAIL=<file> npx vitest run src/editor/snapGolden.test.ts. ` +
            `If the change is deliberate, regenerate with -u and say why in the commit.`,
        )
      }
    }
    await expect(table).toMatchFileSnapshot('./__snapshots__/snapGolden.pairwise.txt')
  })

  it('demo scene: every snapping part nudged off its pose re-snaps against the whole scene', async () => {
    const scene = createPlcDemoScene()
    const parts = scene.parts as PartInstance[]
    const nudges: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [0.3, 0, 0.2, 0.08],
      [-0.4, 0.1, -0.15, -0.12],
    ]
    const lines: string[] = []
    let movers = 0
    for (const part of parts) {
      if (!snapsAsMover(part)) continue
      movers++
      // against everything outside the part's own subtree, as a drag searches (its children ride along with it) and
      // the agent's snap tool does: a part never snaps to its own child
      const own = new Set(subtreeIds(parts, [part.id]))
      const others = parts.filter((p) => !own.has(p.id))
      for (const [dx, dy, dz, dyaw] of nudges) {
        const pose: SnapPose = { position: [part.position[0] + dx, part.position[1] + dy, part.position[2] + dz], rotationY: part.rotationY + dyaw }
        const c = findSnap({ ...part, position: pose.position, rotationY: pose.rotationY }, pose, others)
        lines.push(`${part.id} (${part.type === 'part' ? part.packageId : part.type}) nudge=${fv([dx, dy, dz, dyaw])} ${fmt(c)}`)
      }
    }
    expect(movers, 'the demo scene has snapping parts to test').toBeGreaterThan(30)
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/snapGolden.demo.txt')
  })

  it('the face-snap toggle off: an ambient flush mover snaps to nothing', () => {
    expect([...pairwise({ faceFlush: false }, (sp) => sp.pkg.snap?.flush === true).keys()]).toEqual([])
  })
})
