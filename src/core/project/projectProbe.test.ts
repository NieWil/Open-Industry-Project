import { describe, expect, it } from 'vitest'
import { CARGO_KIND_BOX, CARGO_KIND_PALLET } from '../frame'
import type { BoxFrame } from '../frame'
import { quatFromYXZ } from '../math'
import { CargoSnapshots, cargoColorName, cargoRows, ProbeSampler } from './projectProbe'
import { operandProbeKey, probeKey } from './projectTest'
import type { TestCheck } from './projectTest'

// The probes are pure over a BoxFrame, so every case here is a hand-built frame: no Jolt, no
// scene, no runner. See projectTestRunner.test.ts for the end-to-end proof against real physics.

interface Body {
  part?: string | null
  pos: [number, number, number]
  kind?: number
  quat?: [number, number, number, number]
  /** frame id (default: its index + 1, as the sim never reuses one) */
  id?: number
  /** sRGB 0..1 tint (default black) */
  color?: [number, number, number]
}

function frame(bodies: Body[], extra: Partial<BoxFrame> = {}): BoxFrame {
  const count = bodies.length
  const positions = new Float32Array(count * 3)
  const quats = new Float32Array(count * 4)
  const kinds = new Uint8Array(count)
  const partIds: (string | null)[] = []
  const ids = new Uint32Array(count)
  const colors = new Float32Array(count * 3)
  bodies.forEach((b, i) => {
    ids[i] = b.id ?? i + 1
    colors.set(b.color ?? [0, 0, 0], i * 3)
    positions.set(b.pos, i * 3)
    quats.set(b.quat ?? [0, 0, 0, 1], i * 4)
    kinds[i] = b.kind ?? CARGO_KIND_BOX
    partIds.push(b.part ?? null)
  })
  return {
    count,
    ids,
    positions,
    quats,
    halfExtents: new Float32Array(count * 3),
    colors,
    kinds,
    partIds,
    simTime: 0,
    ...extra,
  }
}

/** Feed one check's probe through a sampler over a sequence of frames; return the last reading. */
function read(check: TestCheck, ...frames: BoxFrame[]): number | boolean | undefined {
  const sampler = new ProbeSampler([check])
  let last: Record<string, number | boolean> = {}
  for (const f of frames) last = sampler.values(f)
  return last[probeKey(0)]
}

const ZONE = { min: [2, 0, -1] as [number, number, number], max: [6, 2, 1] as [number, number, number] }

describe('ProbeSampler - count', () => {
  it('counts every live cargo body when unfiltered', () => {
    const f = frame([{ pos: [0, 0, 0] }, { pos: [9, 9, 9] }, { part: 'p1', pos: [1, 1, 1] }])
    expect(read({ probe: { count: {} }, at: 0, min: 0 }, f)).toBe(3)
  })

  it('counts only bodies inside the zone, inclusive of its faces', () => {
    const f = frame([
      { pos: [4, 1, 0] }, // inside
      { pos: [2, 0, -1] }, // exactly on the min corner: inside
      { pos: [6, 2, 1] }, // exactly on the max corner: inside
      { pos: [6.01, 1, 0] }, // just past x
      { pos: [4, 1, 1.5] }, // just past z
    ])
    expect(read({ probe: { count: { zone: ZONE } }, at: 0, min: 0 }, f)).toBe(3)
  })

  it('filters by cargo kind', () => {
    const f = frame([{ pos: [0, 0, 0] }, { pos: [0, 0, 0], kind: CARGO_KIND_PALLET }, { pos: [0, 0, 0], kind: CARGO_KIND_PALLET }])
    expect(read({ probe: { count: { kind: 'pallet' } }, at: 0, min: 0 }, f)).toBe(2)
    expect(read({ probe: { count: { kind: 'box' } }, at: 0, min: 0 }, f)).toBe(1)
  })

  it('is the existence idiom for one authored part: 1 while it lives, 0 once it is gone', () => {
    const check: TestCheck = { probe: { count: { part: 'pallet-1' } }, always: true, equals: 1 }
    expect(read(check, frame([{ part: 'pallet-1', pos: [0, 0, 0] }]))).toBe(1)
    expect(read(check, frame([{ part: 'other', pos: [0, 0, 0] }]))).toBe(0)
  })

  it('excludes transient spawner boxes (null partId) from a part filter but not from a bare count', () => {
    const f = frame([{ pos: [0, 0, 0] }, { pos: [0, 0, 0] }, { part: 'p1', pos: [0, 0, 0] }])
    expect(read({ probe: { count: {} }, at: 0, min: 0 }, f)).toBe(3)
    expect(read({ probe: { count: { part: 'p1' } }, at: 0, min: 0 }, f)).toBe(1)
  })

  it('reports 0 rather than absent when nothing matches - an empty zone is a real answer', () => {
    const v = read({ probe: { count: { zone: ZONE } }, at: 0, min: 0 }, frame([{ pos: [-50, 0, 0] }]))
    expect(v).toBe(0) // present in the table, so it never trips the "never appeared" guard
  })
})

describe('ProbeSampler - pose', () => {
  it('reads an authored cargo body position per axis', () => {
    const f = frame([{ part: 'box-1', pos: [1.5, 0.8, -2.25] }])
    expect(read({ probe: { pose: { part: 'box-1', axis: 'x' } }, at: 0, min: 0 }, f)).toBeCloseTo(1.5, 5)
    expect(read({ probe: { pose: { part: 'box-1', axis: 'y' } }, at: 0, min: 0 }, f)).toBeCloseTo(0.8, 5)
    expect(read({ probe: { pose: { part: 'box-1', axis: 'z' } }, at: 0, min: 0 }, f)).toBeCloseTo(-2.25, 5)
  })

  it('derives yaw from a cargo body quaternion', () => {
    const f = frame([{ part: 'box-1', pos: [0, 0, 0], quat: quatFromYXZ(0, Math.PI / 4, 0) }])
    expect(read({ probe: { pose: { part: 'box-1', axis: 'yaw' } }, at: 0, min: 0 }, f)).toBeCloseTo(Math.PI / 4, 4)
  })

  it('reads a driven mobile base, preferring it over the cargo scan', () => {
    const f = frame([], { basePoses: { 'agv-1': { pos: [12.5, 0, 3], yaw: 1.2 } } })
    expect(read({ probe: { pose: { part: 'agv-1', axis: 'x' } }, at: 0, min: 0 }, f)).toBeCloseTo(12.5, 5)
    expect(read({ probe: { pose: { part: 'agv-1', axis: 'yaw' } }, at: 0, min: 0 }, f)).toBeCloseTo(1.2, 5)
  })

  it('latches the last base pose: an AGV that arrives and stops driving is still readable', () => {
    // basePoses only carries a part that drove this step, so without the latch an arrival check at
    // the end of the run reads absent.
    const moving = frame([], { basePoses: { 'agv-1': { pos: [12.5, 0, 3], yaw: 1.2 } } })
    const stopped = frame([]) // no basePoses at all
    expect(read({ probe: { pose: { part: 'agv-1', axis: 'x' } }, at: 0, min: 0 }, moving, stopped)).toBeCloseTo(12.5, 5)
  })

  it('is absent for a part that is not in the scene, so the evaluator flags it instead of reading 0', () => {
    const f = frame([{ part: 'box-1', pos: [0, 0, 0] }])
    expect(read({ probe: { pose: { part: 'typo-1', axis: 'x' } }, at: 0, min: 0 }, f)).toBeUndefined()
  })
})

describe('ProbeSampler - wiring', () => {
  it('keys each probe by its check index, leaving tag checks alone', () => {
    const sampler = new ProbeSampler([
      { tag: 'Run', at: 0, equals: true },
      { probe: { count: {} }, at: 0, min: 1 },
    ])
    const v = sampler.values(frame([{ pos: [0, 0, 0] }]))
    expect(Object.keys(v)).toEqual([probeKey(1)])
  })

  it('reports `empty` for a spec with no probes so the runner can skip sampling', () => {
    expect(new ProbeSampler([{ tag: 'Run', at: 0, equals: true }]).empty).toBe(true)
    expect(new ProbeSampler([{ probe: { count: {} }, at: 0, min: 0 }]).empty).toBe(false)
  })
})

// The spawner's tints in the colour-sort benchmark line: #e01010, #10c020, #1030e0
const RED: [number, number, number] = [0xe0 / 255, 0x10 / 255, 0x10 / 255]
const GREEN: [number, number, number] = [0x10 / 255, 0xc0 / 255, 0x20 / 255]
const BLUE: [number, number, number] = [0x10 / 255, 0x30 / 255, 0xe0 / 255]

describe('count probe - colour filter', () => {
  it('counts by colour name, the way the colour sensor part calls it, and by exact #rrggbb', () => {
    const f = frame([
      { pos: [0, 0, 0], color: RED },
      { pos: [1, 0, 0], color: GREEN },
      { pos: [2, 0, 0], color: RED },
      { pos: [3, 0, 0], color: [0.9, 0.9, 0.9] }, // white: no primary
    ])
    expect(read({ probe: { count: { color: 'red' } }, at: 0, min: 0 }, f)).toBe(2)
    expect(read({ probe: { count: { color: 'green' } }, at: 0, min: 0 }, f)).toBe(1)
    expect(read({ probe: { count: { color: '#e01010' } }, at: 0, min: 0 }, f)).toBe(2)
    expect(read({ probe: { count: { color: 'red', zone: { min: [-0.5, -1, -1], max: [0.5, 1, 1] } } }, at: 0, min: 0 }, f)).toBe(1)
  })

  it('is absent until cargo of that colour has existed, so a colour no box has cannot pass a max 0', () => {
    const noBlue = frame([{ pos: [0, 0, 0], color: RED }])
    expect(read({ probe: { count: { color: 'blue' } }, at: 0, max: 0 }, noBlue)).toBeUndefined()
    expect(read({ probe: { count: { color: '#e01011' } }, at: 0, max: 0 }, noBlue)).toBeUndefined() // one digit off
    // once a blue has existed it answers, 0 included, for the rest of the run
    const s = new ProbeSampler([{ probe: { count: { color: 'blue' } }, always: true, max: 5 }])
    expect(s.values(noBlue)).toEqual({})
    expect(s.values(frame([{ pos: [0, 0, 0], color: BLUE }]))[probeKey(0)]).toBe(1)
    expect(s.values(frame([]))[probeKey(0)]).toBe(0)
  })

  it('names a tint only when it is a saturated primary', () => {
    expect(cargoColorName(...RED)).toBe('red')
    expect(cargoColorName(...GREEN)).toBe('green')
    expect(cargoColorName(...BLUE)).toBe('blue')
    expect(cargoColorName(1, 1, 1)).toBeUndefined()
    expect(cargoColorName(0.1, 0.05, 0.05)).toBeUndefined() // too dark
    expect(cargoColorName(1, 0.9, 0)).toBe('yellow')
    expect(cargoColorName(0, 1, 1)).toBeUndefined() // cyan
  })
})

describe('passed probe - cargo that went through a place, cumulative', () => {
  const gate = { min: [4, 0, -1], max: [4.2, 2, 1] } as { min: [number, number, number]; max: [number, number, number] }
  const at = (id: number, x: number, color = RED): Body => ({ id, pos: [x, 1, 0], color })

  it('counts each body once when it enters, keeps it after it leaves or is despawned', () => {
    const check: TestCheck = { probe: { passed: { zone: gate } }, always: true, min: 0 }
    const s = new ProbeSampler([check])
    const v = (...bodies: Body[]): number | boolean | undefined => s.values(frame(bodies))[probeKey(0)]
    expect(v(at(1, 3.9))).toBeUndefined() // nothing has entered yet: absent, not 0
    expect(v(at(1, 4.1))).toBe(1)
    expect(v(at(1, 4.1))).toBe(1) // standing in it counts once
    expect(v(at(1, 4.5), at(2, 3.9))).toBe(1)
    expect(v(at(2, 4.15))).toBe(2) // body 1 despawned: still counted
  })

  it('catches a body that crossed the zone between two steps (swept, not sampled)', () => {
    const s = new ProbeSampler([{ probe: { passed: { zone: gate } }, always: true, min: 0 }])
    s.values(frame([at(1, 3.5)]))
    expect(s.values(frame([at(1, 4.8)]))[probeKey(0)]).toBe(1) // jumped clean over the 0.2 m gate
    // negative control: moving past the gate's side does not count
    const t = new ProbeSampler([{ probe: { passed: { zone: gate } }, always: true, min: 0 }])
    t.values(frame([{ id: 1, pos: [3.5, 1, 2], color: RED }]))
    expect(t.values(frame([{ id: 1, pos: [4.8, 1, 2], color: RED }]))[probeKey(0)]).toBeUndefined()
  })

  it('filters by colour, and the gate is witnessed by any cargo, so 0 is an answer once something passed', () => {
    const s = new ProbeSampler([{ probe: { passed: { zone: gate, color: 'red' } }, always: true, max: 0 }])
    expect(s.values(frame([at(1, 4.1, GREEN)]))).toEqual({}) // a green passed, but no red cargo has existed: absent
    expect(s.values(frame([at(1, 4.5, GREEN), at(2, 1, RED)]))[probeKey(0)]).toBe(0) // a red exists, has not passed
    expect(s.values(frame([at(2, 4.1, RED)]))[probeKey(0)]).toBe(1)
  })

  it('stays absent when no cargo ever enters the zone, so a gate off the path cannot pass a max 0', () => {
    expect(read({ probe: { passed: { zone: gate, color: 'red' } }, always: true, max: 0 }, frame([at(1, 1)]), frame([at(1, 2)]))).toBeUndefined()
  })
})

describe('square probe - how far the cargo in a zone is turned off a heading', () => {
  const yawed = (id: number, x: number, deg: number, color = RED): Body => ({ id, pos: [x, 1, 0], color, quat: quatFromYXZ(0, (deg * Math.PI) / 180, 0) })
  const v = (heading: number, ...bodies: Body[]): number | boolean | undefined => read({ probe: { square: { zone: ZONE, heading } }, always: true, max: 10 }, frame(bodies))

  it('reads the worst body in the zone, in degrees off square, and ignores bodies outside it', () => {
    expect(v(30, yawed(1, 3, 30))).toBeCloseTo(0, 3)
    expect(v(30, yawed(1, 3, 38), yawed(2, 4, 25))).toBeCloseTo(8, 3)
    expect(v(30, yawed(1, 3, 33), yawed(2, 9, 70))).toBeCloseTo(3, 3) // body 2 is past the zone
  })

  it('folds by 90, so any edge parallel to the heading is square, and the most a box can be off is 45', () => {
    expect(v(30, yawed(1, 3, 120))).toBeCloseTo(0, 3)
    expect(v(30, yawed(1, 3, -60))).toBeCloseTo(0, 3)
    expect(v(0, yawed(1, 3, 45))).toBeCloseTo(45, 3)
    expect(v(30, yawed(1, 3, 67))).toBeCloseTo(37, 3) // the 45-degree build's worst box, against a 30-degree spur
    expect(v(45, yawed(1, 3, 67))).toBeCloseTo(22, 3)
  })

  it('is absent with no matching body in the zone, so a zone off the path fails as never appeared', () => {
    expect(v(30, yawed(1, 9, 30))).toBeUndefined()
    expect(read({ probe: { square: { zone: ZONE, heading: 30, color: 'green' } }, always: true, max: 10 }, frame([yawed(1, 3, 60)]))).toBeUndefined()
  })
})

describe('ProbeSampler - a probe on the right-hand side of a predicate', () => {
  it('reads it under the operand key, beside the source', () => {
    const s = new ProbeSampler([{ tag: 'Sorted1', always: true, min: { probe: { count: {} } } }])
    expect(s.values(frame([{ pos: [0, 0, 0] }, { pos: [1, 0, 0] }]))).toEqual({ [operandProbeKey(0)]: 2 })
  })
})

describe('cargoRows', () => {
  it('lists each body: id, part, kind, tint and its name, centre to the millimetre, tilt', () => {
    const rows = cargoRows(frame([{ id: 7, part: 'p1', pos: [1.23456, 1, -0.5], color: RED, kind: CARGO_KIND_PALLET }, { id: 8, pos: [0, 0, 0], color: [1, 1, 1] }]))
    expect(rows).toEqual([
      { id: 7, part: 'p1', kind: 'pallet', color: '#e01010', colorName: 'red', pos: [1.235, 1, -0.5], tiltDeg: 0, yawDeg: 0 },
      { id: 8, part: null, kind: 'box', color: '#ffffff', pos: [0, 0, 0], tiltDeg: 0, yawDeg: 0 },
    ])
  })

  it('yaw of a case resting on a cross slope is the way its edges run in plan, not its rolled cross edge', () => {
    // a 24 degree slide falling toward -Z, the case's X edge along a 30 degree run: X lies in the slide, Y is its normal
    const t = Math.tan((24 * Math.PI) / 180)
    const unit = (v: number[]): number[] => v.map((c) => c / Math.hypot(...v))
    const X = unit([Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6) * t, -Math.sin(Math.PI / 6)])
    const Y = unit([0, 1, -t]) // the normal of y = t z
    expect(Math.abs(X[0]! * Y[0]! + X[1]! * Y[1]! + X[2]! * Y[2]!)).toBeLessThan(1e-12) // a real rotation: X in the slide
    const Z = [X[1]! * Y[2]! - X[2]! * Y[1]!, X[2]! * Y[0]! - X[0]! * Y[2]!, X[0]! * Y[1]! - X[1]! * Y[0]!]
    // the rotation whose columns are X, Y, Z, as a quaternion (the trace is positive here)
    const w = Math.sqrt(1 + X[0]! + Y[1]! + Z[2]!) / 2
    const quat: [number, number, number, number] = [(Y[2]! - Z[1]!) / (4 * w), (Z[0]! - X[2]!) / (4 * w), (X[1]! - Y[0]!) / (4 * w), w]
    const [row] = cargoRows(frame([{ pos: [0, 0, 0], quat }]))
    expect(row!.yawDeg).toBe(30)
    expect(row!.tiltDeg).toBe(24)
  })

  it('yaw is the heading about +Y as rotationY measures it, kept apart from a tilt, and a half turn reads 180', () => {
    const rows = cargoRows(frame([{ pos: [0, 0, 0], quat: quatFromYXZ(0, Math.PI / 4, 0) }, { pos: [0, 0, 0], quat: quatFromYXZ(0, -Math.PI / 2, 0) }, { pos: [0, 0, 0], quat: quatFromYXZ(0, 0.7, Math.PI / 6) }, { pos: [0, 0, 0], quat: quatFromYXZ(0, -Math.PI, 0) }]))
    expect(rows.map((r) => r.yawDeg)).toEqual([45, -90, 40, 180])
  })

  it('tilt is the up axis from vertical: a yaw leaves it upright, a roll onto its side is 90', () => {
    const rows = cargoRows(frame([{ pos: [0, 0, 0], quat: quatFromYXZ(0, 1.2, 0) }, { pos: [0, 0, 0], quat: quatFromYXZ(Math.PI / 2, 0, 0) }, { pos: [0, 0, 0], quat: quatFromYXZ(0, 0.7, Math.PI / 6) }]))
    expect(rows.map((r) => r.tiltDeg)).toEqual([0, 90, 30])
  })
})

describe('CargoSnapshots', () => {
  it('keeps the rows at the first step reaching each time, in time order, and names the times the run never reached', () => {
    const snaps = new CargoSnapshots([0.5, 0.1, 9])
    for (const t of [0, 1 / 60, 0.1, 0.25, 0.5000001, 0.6]) snaps.onFrame(frame([{ pos: [t, 0, 0] }], { simTime: t }))
    expect(snaps.snapshots.map((s) => [s.at, s.t, s.bodies[0]!.pos[0]])).toEqual([
      [0.1, 0.1, 0.1],
      [0.5, 0.5000001, 0.5],
    ])
    expect(snaps.missed()).toEqual([9])
  })

  it("gives each body its velocity over the step before, and none to a body that step spawned", () => {
    const snaps = new CargoSnapshots([0.5])
    snaps.onFrame(frame([{ id: 1, pos: [1, 0.5, 0] }], { simTime: 0.4 }))
    snaps.onFrame(frame([{ id: 1, pos: [1.2, 0.3, 0] }, { id: 2, pos: [0, 0, 0] }], { simTime: 0.5 }))
    const [a, b] = snaps.snapshots[0]!.bodies
    expect(a!.vel).toEqual([2, -2, 0])
    expect(b!.vel).toBeUndefined()
  })

  it('asks the runner what each body touches only at a snapshot, and leaves it out when the runner cannot say', () => {
    const snaps = new CargoSnapshots([0.2])
    let asked = 0
    const contacts = (): ReadonlyMap<number, readonly string[]> => (asked++, new Map([[1, ['belt', 'cargo 2']]]))
    for (const t of [0, 0.1, 0.2, 0.3]) snaps.onFrame(frame([{ id: 1, pos: [t, 0, 0] }, { id: 2, pos: [t + 1, 0, 0] }], { simTime: t }), { contacts })
    expect(asked).toBe(1)
    expect(snaps.snapshots[0]!.bodies.map((b) => b.touching)).toEqual([['belt', 'cargo 2'], undefined])
  })
})

describe('ProbeSampler - the marked filter', () => {
  const bodies = frame([{ pos: [3, 1, 0] }, { pos: [4, 1, 0] }, { pos: [5, 1, 0] }])
  const marks = [{ sealed: true, code: 2 }, { sealed: false, code: 'A' }, null]
  const count = (marked: unknown): number | boolean | undefined => {
    const sampler = new ProbeSampler([{ probe: { count: { zone: ZONE, marked } }, at: 0, min: 0 } as TestCheck])
    expect(sampler.needsMarks).toBe(true)
    return sampler.values(bodies, marks)[probeKey(0)]
  }
  it('counts the bodies whose mark is truthy, or has the value given', () => {
    expect(count('sealed')).toBe(1)
    expect(count({ code: 2 })).toBe(1)
    expect(count({ code: 'A' })).toBe(1)
    expect(count({ code: 3 })).toBe(0)
  })
  it('judges a passed probe as the body enters the zone', () => {
    const gate = { min: [2, 0, -1] as [number, number, number], max: [2.5, 2, 1] as [number, number, number] }
    const sampler = new ProbeSampler([{ probe: { passed: { zone: gate, marked: 'sealed' } }, eventually: true, min: 1 } as TestCheck])
    const before = frame([{ pos: [1, 1, 0], id: 1 }, { pos: [1, 1, 0.5], id: 2 }])
    const after = frame([{ pos: [3, 1, 0], id: 1 }, { pos: [3, 1, 0.5], id: 2 }])
    sampler.values(before, [{ sealed: true }, null])
    expect(sampler.values(after, [{ sealed: true }, null])[probeKey(0)]).toBe(1)
  })
  it('needs no marks when no probe filters on them', () => {
    expect(new ProbeSampler([{ probe: { count: {} }, at: 0, min: 0 }]).needsMarks).toBe(false)
  })
})
