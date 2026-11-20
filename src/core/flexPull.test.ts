import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flexStations } from './conveyor/flexPath'
import { flexPull, toWorldXZ, withFlexPose } from './parts/partGeometry'
import type { FlexGrip, FlexPose } from './parts/partGeometry'
import { PACKAGE_FORMAT } from './parts/partPackage'
import { clearPackages, registerPackage } from './parts/partRegistry'
import type { PartInstance } from './types'

// Pulling a flex conveyor (core flexPull), the one rule behind the editor's path dots and the walking character's
// hands. The far end holds; a pull the part cannot take stops AT the limit; the walk's dragAlong rolls the whole unit
// once the bed is at full length. The package mirrors the flex conveyor's own handle (examples/parts/flex-conveyor).

const N = 16
const MAX_HINGE = 40 * (Math.PI / 180)

function flex(points: [number, number][], rotationY = 0, position: [number, number, number] = [0, 0.8, 0]): PartInstance {
  const length = flexStations(points, N).pitch * N
  return { id: 'f', type: 'part', packageId: 'acme.flex', position, rotationY, params: { points, length } } as unknown as PartInstance
}

const last = <T>(xs: T[]): T => xs[xs.length - 1]!
const pointsOf = (pose: FlexPose): [number, number][] => pose.params.points as [number, number][]
const lengthOf = (pose: FlexPose): number => pose.params.length as number
/** every control point of `part` in the world */
const worldPoints = (part: PartInstance): { x: number; z: number }[] =>
  ((part.params as unknown as { points: [number, number][] }).points).map(([x, z]) => toWorldXZ(part, x, z))

describe('flexPull', () => {
  beforeEach(() => {
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'acme.flex',
      name: 'flex',
      params: {
        points: {
          type: 'numberList', arity: 2, default: [[3, 0], [6, 0], [8, 0]],
          handle: { kind: 'flexPath', lengthParam: 'length', sections: N, maxHingeDeg: 40, infeedBrakeParam: 'inBrakes', dischargeBrakeParam: 'outBrakes' },
        },
        length: { type: 'number', default: 8, min: 4, max: 24 },
        inBrakes: { type: 'boolean', default: false },
        outBrakes: { type: 'boolean', default: false },
      },
      behavior: 'definePart(() => ({}))',
      geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] } }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
    } as never)
  })
  afterEach(() => clearPackages())

  it('moves the end where it is pulled, and holds the infeed', () => {
    const part = flex([[3, 0], [6, 0], [8, 0]])
    const pose = flexPull(part, 2, 12, 0)!
    expect(pointsOf(pose)[2]).toEqual([12, 0])
    expect(lengthOf(pose)).toBeCloseTo(12, 3)
    expect(pose.position).toEqual(part.position)
    expect(pose.rotationY).toBe(0)
  })

  it('stops at full length instead of refusing the pull', () => {
    const pose = flexPull(flex([[3, 0], [6, 0], [8, 0]]), 2, 40, 0)!
    expect(lengthOf(pose)).toBeCloseTo(24, 4)
    expect(pointsOf(pose)[2]![0]).toBeCloseTo(24, 3)
    expect(pose.position).toEqual([0, 0.8, 0])
  })

  it('stops at the hinge limit', () => {
    const part = flex([[3, 0], [6, 0], [8, 0]])
    // hard round to the side: far past what 40 degrees a hinge can take, but well inside the length range
    const pose = flexPull(part, 2, 6, -6)!
    expect(pose).not.toBeNull()
    const fit = flexStations(pointsOf(pose), N)
    expect(fit.maxHinge).toBeLessThanOrEqual(MAX_HINGE + 1e-9)
    expect(fit.maxHinge).toBeGreaterThan(MAX_HINGE - 0.01) // at the limit, not short of it
    expect(pose.position).toEqual(part.position)
  })

  it('with dragAlong, an end hauled round further than the bed can bend drags the unit round instead', () => {
    const part = flex([[3, 0], [6, 0], [8, 0]])
    const pose = flexPull(part, 'discharge', 6, -6, { dragAlong: true })!
    const moved = withFlexPose(part, pose)
    const end = last(worldPoints(moved))
    expect(end.x).toBeCloseTo(6, 6)
    expect(end.z).toBeCloseTo(-6, 6)
    expect(flexStations(pointsOf(pose), N).maxHinge).toBeLessThanOrEqual(MAX_HINGE + 1e-9)
    expect(lengthOf(pose)).toBeCloseTo(8, 2) // the length it had: nothing asked it to stretch
    expect(pose.position).not.toEqual(part.position)
  })

  it('walked round a circle, the end stays in the hands the whole way, every hinge in its limit', () => {
    const part = flex([[8, 0], [16, 0], [24, 0]])
    const circle = Array.from({ length: 400 }, (_, i) => ({ x: 24 + 6 * Math.sin((i + 1) / 60), z: -6 + 6 * Math.cos((i + 1) / 60) }))
    let prev = part
    let i = 0
    walk(part, 'discharge', circle, (p) => {
      const h = circle[i++]!
      const st = shape(p).stations.map(([x, z]) => toWorldXZ(p, x, z))
      expect(Math.hypot(st[N]!.x - h.x, st[N]!.z - h.z)).toBeLessThan(1e-6)
      expect(shape(p).maxHinge).toBeLessThanOrEqual(MAX_HINGE + 1e-9)
      // no hinge jumps: a 0.1 m step of the hands never throws any part of the bed further than a step and a bit
      const was = shape(prev).stations.map(([x, z]) => toWorldXZ(prev, x, z))
      for (let k = 0; k <= N; k++) expect(Math.hypot(st[k]!.x - was[k]!.x, st[k]!.z - was[k]!.z)).toBeLessThan(0.25)
      prev = p
    })
  })

  it('returns null when the grip is already at the limit and the pull goes further', () => {
    const atMax = withFlexPose(flex([[3, 0], [6, 0], [8, 0]]), flexPull(flex([[3, 0], [6, 0], [8, 0]]), 2, 40, 0)!)
    expect(flexPull(atMax, 2, 50, 0)).toBeNull()
  })

  it('past full length with dragAlong: the whole unit rolls after the hands', () => {
    const part = flex([[3, 0], [6, 0], [8, 0]])
    const pose = flexPull(part, 2, 30, 0, { dragAlong: true })!
    expect(lengthOf(pose)).toBeCloseTo(24, 2)
    expect(lengthOf(pose)).toBeLessThanOrEqual(24)
    const end = last(worldPoints(withFlexPose(part, pose)))
    expect(end.x).toBeCloseTo(30, 6)
    expect(end.z).toBeCloseTo(0, 6)
    expect(pose.position[0]).toBeCloseTo(6, 1) // the infeed came 6 m after it
    expect(pose.position[1]).toBe(0.8)
  })

  // the walk, frame by frame: the hands move in small steps and each pull starts from the shape the last one left
  const walk = (part: PartInstance, grip: FlexGrip, path: { x: number; z: number }[], each?: (p: PartInstance) => void): PartInstance => {
    let cur = part
    for (const h of path) {
      const pose = flexPull(cur, grip, h.x, h.z, { dragAlong: true })
      if (pose) cur = withFlexPose(cur, pose)
      each?.(cur)
    }
    return cur
  }
  const steps = (from: { x: number; z: number }, to: { x: number; z: number }, n: number) =>
    Array.from({ length: n }, (_, i) => ({ x: from.x + ((to.x - from.x) * (i + 1)) / n, z: from.z + ((to.z - from.z) * (i + 1)) / n }))
  const shape = (p: PartInstance) => flexStations((p.params as unknown as { points: [number, number][] }).points, N)

  it('the far end holds until the bed is at full length', () => {
    const part = flex([[3, 0], [6, 0], [8, 0]])
    walk(part, 'discharge', steps({ x: 8, z: 0 }, { x: 23.5, z: 0 }, 60), (p) => expect(p.position).toEqual(part.position))
  })

  it('a bed dragged round a corner at full stretch swings in to trail behind the hands, every hinge in its limit', () => {
    const part = flex([[8, 0], [16, 0], [24, 0]])
    // walk off at right angles (toward -z) for 20 m, holding the end
    const end = walk(part, 'discharge', steps({ x: 24, z: 0 }, { x: 24, z: -20 }, 200), (p) => {
      const fit = shape(p)
      expect(fit.maxHinge).toBeLessThanOrEqual(MAX_HINGE + 1e-9)
      expect(fit.pitch * N).toBeLessThanOrEqual(24)
    })
    const st = shape(end).stations.map(([x, z]) => toWorldXZ(end, x, z))
    const [a, b] = [st[N]!, st[N - 1]!] // the held end and the hinge behind it
    expect(a.x).toBeCloseTo(24, 6)
    expect(a.z).toBeCloseTo(-20, 6)
    // the last section now lies along the walk, trailing the hands (it started at right angles to it)
    expect(Math.abs(Math.atan2(b.x - a.x, b.z - a.z))).toBeLessThan(0.35)
    // ...and the infeed has been drawn off its spot toward the walk, though a chain's tail lags far behind its head
    expect(end.position[2]).toBeLessThan(-0.2)
  })

  it('a curved bed pulled straight away straightens out behind the hands', () => {
    const part = flex([[6, 0], [12, -6], [18, -6]])
    const start = walk(part, 'discharge', steps({ x: 18, z: -6 }, { x: 24, z: -6 }, 30))
    const pulled = walk(start, 'discharge', steps({ x: 24, z: -6 }, { x: 70, z: -6 }, 300))
    expect(shape(pulled).maxHinge).toBeLessThan(shape(start).maxHinge / 5)
    expect(shape(pulled).maxHinge).toBeLessThan(0.05) // under 3 degrees at any hinge
    expect(Math.abs(pulled.rotationY)).toBeLessThan(0.05) // lined up with the pull
  })

  it('pushed past fully collapsed, the unit is shoved ahead of the hands', () => {
    const part = flex([[4 / 3, 0], [8 / 3, 0], [4, 0]]) // collapsed: the package minimum is 4 m
    const pose = flexPull(part, 2, 3, 0, { dragAlong: true })!
    expect(lengthOf(pose)).toBeCloseTo(4, 2)
    expect(lengthOf(pose)).toBeGreaterThanOrEqual(4)
    expect(pose.position[0]).toBeCloseTo(-1, 1)
    expect(last(worldPoints(withFlexPose(part, pose))).x).toBeCloseTo(3, 6)
  })

  const braked = (p: PartInstance, which: 'inBrakes' | 'outBrakes'): PartInstance =>
    ({ ...p, params: { ...p.params, [which]: true } }) as unknown as PartInstance

  it('a braked end cannot be moved by hand, though the editor still places it', () => {
    const part = braked(flex([[3, 0], [6, 0], [8, 0]]), 'outBrakes')
    expect(flexPull(part, 'discharge', 10, 0, { dragAlong: true })).toBeNull()
    expect(pointsOf(flexPull(part, 'discharge', 10, 0)!)[2]).toEqual([10, 0])
    const inBraked = braked(flex([[3, 0], [6, 0], [8, 0]]), 'inBrakes')
    expect(flexPull(inBraked, 'infeed', -2, 0, { dragAlong: true })).toBeNull()
    // ...and the unbraked end of either still pulls
    expect(flexPull(inBraked, 'discharge', 10, 0, { dragAlong: true })).not.toBeNull()
  })

  it('with the far end braked, a pull past full length stops there instead of drawing the unit along', () => {
    const part = braked(flex([[3, 0], [6, 0], [8, 0]]), 'inBrakes')
    const pose = flexPull(part, 'discharge', 30, 0, { dragAlong: true })!
    expect(lengthOf(pose)).toBeCloseTo(24, 4)
    expect(pose.position).toEqual(part.position)
    // round a bend it cannot make, too
    const bent = flexPull(part, 'discharge', 6, -6, { dragAlong: true })!
    expect(bent.position).toEqual(part.position)
    expect(flexStations(pointsOf(bent), N).maxHinge).toBeLessThanOrEqual(MAX_HINGE + 1e-9)
  })

  it('held by a middle point, a pull past full length stops rather than dragging the unit', () => {
    const part = flex([[8, 0], [16, 0], [24, 0]])
    // the middle point hauled out to the side: far more bed than there is
    const pose = flexPull(part, 1, 16, -12, { dragAlong: true })
    expect(pose?.position ?? part.position).toEqual(part.position)
    expect(pose?.rotationY ?? 0).toBe(0)
  })

  it('pulls from the infeed: the part moves, every control point holds in the world', () => {
    for (const rotationY of [0, 0.7]) {
      const part = flex([[3, 0], [5, -2], [8, -2]], rotationY, [1, 0.8, 2])
      const before = worldPoints(part)
      const back = toWorldXZ(part, -2, 0.3) // behind the infeed and a little to the side
      const pose = flexPull(part, 'infeed', back.x, back.z)!
      expect(pose.position[0]).toBeCloseTo(back.x, 9)
      expect(pose.position[2]).toBeCloseTo(back.z, 9)
      expect(pose.position[1]).toBe(0.8)
      const after = worldPoints(withFlexPose(part, pose))
      for (let i = 0; i < before.length; i++) {
        expect(after[i]!.x).toBeCloseTo(before[i]!.x, 9)
        expect(after[i]!.z).toBeCloseTo(before[i]!.z, 9)
      }
      expect(lengthOf(pose)).toBeGreaterThan((part.params as unknown as { length: number }).length)
    }
  })

  it('an infeed pull swings the heading by the turn it makes, so a small pull is a small swing', () => {
    const part = flex([[3, 0], [6, 0], [8, 0]])
    const pose = flexPull(part, 'infeed', 0, 0.01)!
    expect(Math.abs(pose.rotationY)).toBeLessThan(0.01)
    // the heading follows the line to the first point: moved to (0, +1) the infeed aims up at (3, 0)
    const swung = flexPull(part, 'infeed', 0, 1)!
    expect(swung.rotationY).toBeCloseTo(Math.atan2(1, 3), 9)
  })

  it('an infeed pull past full length stops there, and with dragAlong draws the discharge end after it', () => {
    const part = flex([[3, 0], [6, 0], [8, 0]])
    const stopped = flexPull(part, 'infeed', -30, 0)!
    expect(lengthOf(stopped)).toBeCloseTo(24, 4)
    expect(stopped.position[0]).toBeCloseTo(-16, 3)
    const rolled = flexPull(part, 'infeed', -30, 0, { dragAlong: true })!
    expect(rolled.position[0]).toBeCloseTo(-30, 9)
    expect(rolled.position[2]).toBeCloseTo(0, 9)
    expect(Math.abs(rolled.rotationY)).toBeLessThan(1e-6)
    expect(last(worldPoints(withFlexPose(part, rolled))).x).toBeCloseTo(-6, 1)
  })
})
