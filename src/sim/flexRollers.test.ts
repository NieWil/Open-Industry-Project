/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flexStations } from '../core/conveyor/flexPath'
import { flexHingeLimit, flexPathOf, flexPull, withFlexPose } from '../core/parts/partGeometry'
import type { FlexGrip } from '../core/parts/partGeometry'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartInstance } from '../core/types'
import { buildPackage } from './buildPackage'

// The Flex Conveyor's rollers never clip into each other, however it is pulled. Its rollers are drawn fanned across
// each rigid section (examples/parts/flex-conveyor geometry: section i's rollers turned from half its infeed hinge
// back to half its discharge hinge forward), and the handle's `scissor` limit (core flexHingeLimit) keeps every gap
// between the spacing fully collapsed and fully extended. This lays the rollers out exactly as the geometry does,
// in plan, and measures the real gap between each neighbouring pair after every pull.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const N = 16
const K = 8 // rollers a section (the generator's ROLLERS)
const ROLLER_D = 0.048 // the generator's ROLLER_R x 2

function registerFlex(): string {
  const dir = join(repo, 'examples', 'parts', 'flex-conveyor')
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as { id: string; name: string; geometry: never; materials?: never }
  const pkg = buildPackage({ id: rig.id, name: rig.name, geometry: rig.geometry, materials: rig.materials }, readFileSync(join(dir, 'behavior.ts'), 'utf8'))
  registerPackage(pkg)
  return pkg.id
}

let pkgId = ''
function flex(length: number, width: number): PartInstance {
  const points: [number, number][] = [[length / 3, 0], [(2 * length) / 3, 0], [length, 0]]
  return { id: 'f', type: 'part', packageId: pkgId, position: [0, 0.8, 0], rotationY: 0, params: { points, length, width } } as unknown as PartInstance
}

/** every roller of `part` in plan, part-local: its two ends, laid out exactly as the part's geometry fans them */
function rollers(part: PartInstance): { a: [number, number]; b: [number, number] }[] {
  const p = part.params as unknown as { points: [number, number][]; width: number }
  const fit = flexStations(p.points, N)
  const hw = p.width / 2
  const s = fit.pitch / K
  const turn: number[] = []
  for (let h = 0; h <= N; h++) {
    let d = h === N ? 0 : fit.headings[h]! - (h === 0 ? 0 : fit.headings[h - 1]!)
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    turn.push(d)
  }
  const out: { a: [number, number]; b: [number, number] }[] = []
  for (let i = 0; i < N; i++) {
    const [sx, sz] = fit.stations[i]!
    const h = fit.headings[i]!
    for (let k = 0; k < K; k++) {
      const f = (k + 0.5) / K
      const yaw = h + (-turn[i]! / 2 + (turn[i]! / 2 + turn[i + 1]! / 2) * f)
      // the section's +X is (cos h, -sin h) (yaw positive toward -Z); a roller's axis is its local +Z turned by its yaw
      const cx = sx + Math.cos(h) * (k + 0.5) * s, cz = sz - Math.sin(h) * (k + 0.5) * s
      const ax = Math.sin(yaw), az = Math.cos(yaw)
      out.push({ a: [cx - ax * hw, cz - az * hw], b: [cx + ax * hw, cz + az * hw] })
    }
  }
  return out
}

/** the closest two roller axes come, sampled along both */
function closest(r: { a: [number, number]; b: [number, number] }, q: { a: [number, number]; b: [number, number] }): number {
  let best = Infinity
  for (let i = 0; i <= 20; i++) {
    const t = i / 20
    const px = r.a[0] + (r.b[0] - r.a[0]) * t, pz = r.a[1] + (r.b[1] - r.a[1]) * t
    for (let j = 0; j <= 20; j++) {
      const u = j / 20
      best = Math.min(best, Math.hypot(px - (q.a[0] + (q.b[0] - q.a[0]) * u), pz - (q.a[1] + (q.b[1] - q.a[1]) * u)))
    }
  }
  return best
}

const tightestGap = (part: PartInstance): number => {
  const rs = rollers(part)
  let min = Infinity
  for (let i = 1; i < rs.length; i++) min = Math.min(min, closest(rs[i - 1]!, rs[i]!))
  return min
}

/** a small deterministic generator, so a failure replays */
function rng(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 2 ** 32
  }
}

describe('Flex Conveyor rollers never clip', () => {
  beforeEach(() => { pkgId = registerFlex() })
  afterEach(() => clearPackages())

  it('the hinge limit follows the stretch: none fully collapsed or extended, most mid-stretch, less when wider', () => {
    const at = (length: number, width: number) => {
      const part = flex(length, width)
      return flexHingeLimit(part, flexPathOf(part)!, length)
    }
    const lr = { min: 7.43, max: 24 }
    expect(at(lr.min, 0.6)).toBe(0)
    expect(at(lr.max, 0.6)).toBe(0)
    expect(at(8, 0.6)).toBeGreaterThan(0.08) // ~7 degrees a hinge at the default length
    expect(at(8, 0.6)).toBeLessThan(0.14)
    expect(at(15.7, 0.6)).toBeCloseTo(40 * (Math.PI / 180), 6) // the hinge's own 40 degrees caps it mid-stretch
    expect(at(8, 1.2)).toBeLessThan(at(8, 0.6))
  })

  it('a fully collapsed bed cannot be bent', () => {
    const part = flex(7.43, 0.6)
    const pose = flexPull(part, 1, 7.43 * (2 / 3), -1)
    const points = (pose ? pose.params.points : (part.params as unknown as { points: unknown }).points) as [number, number][]
    const fit = flexStations(points, N)
    expect(fit.maxHinge).toBeLessThan(1e-3)
  })

  it('the measurement sees clipping: a bend past the limit, forced in, puts rollers inside each other', () => {
    // a U at about the default length: 40-degree hinges, as a fixed 40-degree limit would allow, far past what 8 m can take
    const points: [number, number][] = [[3, 0], [4.2, -1.2], [3, -2.4]]
    const length = flexStations(points, N).pitch * N
    const part = { ...flex(8, 0.6), params: { points, length, width: 0.6 } } as unknown as PartInstance
    expect(flexStations(points, N).maxHinge).toBeGreaterThan(flexHingeLimit(part, flexPathOf(part)!, length))
    expect(tightestGap(part)).toBeLessThan(ROLLER_D)
  })

  it('across random pulls, editor and walk, no two rollers ever come closer than a roller diameter', () => {
    let worst = Infinity
    let bentMost = 0
    for (const [seed, length, width] of [[1, 8, 0.6], [2, 12, 0.6], [3, 16, 0.6], [4, 23.5, 0.6], [5, 10, 1.2], [6, 14, 0.3]] as const) {
      const r = rng(seed)
      let part = flex(length, width)
      expect(tightestGap(part)).toBeGreaterThan(ROLLER_D) // the straight bed it starts as
      for (let step = 0; step < 150; step++) {
        const g = flexPathOf(part)!
        const walk = r() < 0.5
        // the walk pulls an end (and may drag the unit); the editor may take any point
        const grip: FlexGrip = walk ? (r() < 0.5 ? 'infeed' : 'discharge') : Math.floor(r() * g.points.length)
        const idx = grip === 'infeed' ? -1 : grip === 'discharge' ? g.points.length - 1 : grip
        const cur = part.params as unknown as { points: [number, number][] }
        const [lx, lz] = idx < 0 ? [0, 0] : cur.points[idx]!
        // a step of up to half a metre in any direction, in the part's frame (it sits unrotated at the origin at first)
        const c = Math.cos(part.rotationY), sn = Math.sin(part.rotationY)
        const wx = part.position[0] + lx * c + lz * sn, wz = part.position[2] - lx * sn + lz * c
        const pose = flexPull(part, grip, wx + (r() - 0.5), wz + (r() - 0.5), walk ? { dragAlong: true } : undefined)
        if (pose) part = withFlexPose(part, pose)
        worst = Math.min(worst, tightestGap(part))
        bentMost = Math.max(bentMost, flexStations((part.params as unknown as { points: [number, number][] }).points, N).maxHinge)
        expect(worst, `seed ${seed} step ${step}`).toBeGreaterThan(ROLLER_D)
      }
    }
    expect(bentMost).toBeGreaterThan(0.2) // the pulls really bent it: this is not a straight bed passing
  })
})
