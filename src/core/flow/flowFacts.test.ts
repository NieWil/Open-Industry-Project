import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CARGO_KIND_BOX, CARGO_KIND_PALLET, CARGO_KIND_TOTE } from '../frame'
import { DROP_CONFIRM, FlowFactTracker, MAX_FACTS, STALL_MERGE_GAP, STALL_TIME, summarizeFlowFacts } from './flowFacts'
import type { FlowBeamReading, FlowFact, FlowStepInput } from './flowFacts'
import { PACKAGE_FORMAT } from '../parts/partPackage'
import type { PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { PartInstance, SdkPart } from '../types'

// The flow-fact tracker, fed by hand: each case is a short scripted motion, and each fact kind has the case that must
// not raise it beside the one that must (an accumulating stopped box, a box on the floor from the start, a pallet,
// a normal gap between boxes at an eye, a box rocking but upright).

const DT = 1 / 60
const H = 0.15 // the boxes' half size (m)
const DECK = 0.9 // the roller's conveying surface height (m)

// a straight SDK roller, 3 m along x, centred on the origin at the deck height (as conveyorSurface.test.ts builds one)
function rollerPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.roller',
    name: 'Acme Roller',
    conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 3, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [3, 0.04, 0.6] }, conveys: true }], joints: [], bounds: { length: 3, width: 0.6, top: 0.9 } },
  } as unknown as PartPackage
}
const roller = (): SdkPart => ({ id: 'r', name: 'Lane', type: 'part', packageId: 'acme.roller', position: [0, DECK, 0], rotationY: 0, params: { length: 3, width: 0.6, speed: 1 } }) as unknown as SdkPart
const eye = (): PartInstance => ({ id: 'eye', name: 'Eye 1', type: 'part', packageId: 'acme.eye', position: [1, 1, 0.4], rotationY: 0, params: {} }) as unknown as PartInstance

interface Body {
  id: number
  pos: [number, number, number]
  quat?: [number, number, number, number]
  kind?: number
}
interface Step {
  bodies: Body[]
  held?: number[]
  speed?: number
  beam?: FlowBeamReading
  /** the body the beam is blocked by, as the sim would find it */
  target?: number
  tags?: Record<string, boolean>
}

/** feed `steps` to the tracker, one per DT from `t0`; returns the time after the last */
function feed(tr: FlowFactTracker, steps: Step[], t0 = 0): number {
  let t = t0
  // the body that last blocked the beam: the sim finds it at the clear edge from where the beam was blocked last
  let lastTarget: number | undefined
  for (const s of steps) {
    if (s.target !== undefined) lastTarget = s.target
    const target = s.target ?? lastTarget
    const poses: number[] = []
    for (const b of s.bodies) poses.push(...b.pos, ...(b.quat ?? [0, 0, 0, 1]))
    const input: FlowStepInput = {
      t,
      count: s.bodies.length,
      bodies: s.bodies.map((b) => ({ id: b.id, hx: H, hy: H, hz: H, kind: b.kind ?? CARGO_KIND_BOX, partId: null })),
      poses,
      isHeld: (id) => s.held?.includes(id) ?? false,
      speeds: new Map([['r', s.speed ?? 1]]),
      ...(s.beam
        ? {
            beamHits: new Map([['eye', { beam: s.beam }]]),
            partTags: new Map([['eye', { ...(s.tags ?? {}) }]]),
            beamTarget: () => ({ cargo: target, at: [1, 1, 0] as [number, number, number] }),
          }
        : {}),
    }
    tr.step(input)
    t += DT
  }
  return t
}

const repeat = (n: number, f: (i: number) => Step): Step[] => Array.from({ length: n }, (_, i) => f(i))
/** a quaternion turning by `deg` about x */
const tilt = (deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360
  return [Math.sin(h), 0, 0, Math.cos(h)]
}
const kinds = (tr: FlowFactTracker): string[] => tr.facts().map((f) => f.kind)

/** a box resting on the roller for `rest` s, then falling to the floor at gravity and lying there for `after` s */
function fallOff(id: number, rest: number, after: number): Step[] {
  const steps: Step[] = repeat(Math.round(rest / DT), () => ({ bodies: [{ id, pos: [1.4, DECK + H, 0] }] }))
  let y = DECK + H
  let v = 0
  while (y > H) {
    v += 9.81 * DT
    y = Math.max(H, y - v * DT)
    steps.push({ bodies: [{ id, pos: [1.8, y, 0] }] })
  }
  steps.push(...repeat(Math.round(after / DT), () => ({ bodies: [{ id, pos: [1.8, H, 0] }] })))
  return steps
}

beforeEach(() => registerPackage(rollerPkg()))
afterEach(() => clearPackages())

describe('dropped', () => {
  it('a box that falls off a conveyor to the floor, naming the conveyor and the height it fell from', () => {
    const tr = new FlowFactTracker([roller()])
    feed(tr, fallOff(1, 0.5, 0.5))
    const f = tr.facts()
    expect(f.map((x) => x.kind)).toEqual(['dropped'])
    expect(f[0]!.part).toBe('r')
    expect(f[0]!.cargo).toBe(1)
    expect(f[0]!.from).toBeCloseTo(DECK, 1)
    expect(f[0]!.message).toContain("'Lane' (r)")
  })

  it('not a box that starts on the floor, nor one that is only ever on it', () => {
    const tr = new FlowFactTracker([roller()])
    feed(tr, repeat(120, (i) => ({ bodies: [{ id: 1, pos: [3 + i * 0.01, H, 2] }] })))
    expect(tr.facts()).toEqual([])
  })

  it('not a pallet', () => {
    const tr = new FlowFactTracker([roller()])
    feed(tr, fallOff(1, 0.5, 0.5).map((s) => ({ bodies: s.bodies.map((b) => ({ ...b, kind: CARGO_KIND_PALLET })) })))
    expect(tr.facts()).toEqual([])
  })

  it('not a box a holder sets down on the floor', () => {
    const tr = new FlowFactTracker([roller()])
    // held from the conveyor down to just above the floor, then let go
    const carried = repeat(60, (i) => ({ bodies: [{ id: 1, pos: [1.6, DECK + H - (i / 59) * (DECK - 0.01), 0] as [number, number, number] }], held: [1] }))
    feed(tr, [...repeat(30, () => ({ bodies: [{ id: 1, pos: [1.6, DECK + H, 0] as [number, number, number] }] })), ...carried, ...repeat(60, () => ({ bodies: [{ id: 1, pos: [1.6, H, 0] as [number, number, number] }] }))])
    expect(tr.facts()).toEqual([])
  })

  it('not a box a sink on the floor takes as it lands', () => {
    const tr = new FlowFactTracker([roller()])
    const steps = fallOff(1, 0.5, DROP_CONFIRM / 2)
    feed(tr, [...steps, ...repeat(30, () => ({ bodies: [] }))])
    expect(tr.facts()).toEqual([])
  })
})

describe('lost', () => {
  it('a body culled below the world is lost, not dropped, and names what it was last on', () => {
    const tr = new FlowFactTracker([roller()])
    // falls past the floor's level (off the ground's edge) and on down
    const steps: Step[] = repeat(30, () => ({ bodies: [{ id: 1, pos: [1.4, DECK + H, 0] }] }))
    let y = DECK + H
    let v = 0
    while (y > -5) {
      v += 9.81 * DT
      y -= v * DT
      steps.push({ bodies: [{ id: 1, pos: [1.8, y, 0] }] })
    }
    const t = feed(tr, steps)
    tr.lost(1, t, 1.8, y, 0, null)
    expect(kinds(tr)).toEqual(['lost'])
    expect(tr.facts()[0]!.part).toBe('r')
    expect(tr.facts()[0]!.message).toMatch(/^box 1 fell off the world/)
  })

  it('names a lost tote a tote, and a body it never saw cargo', () => {
    const tr = new FlowFactTracker([roller()])
    const t = feed(tr, repeat(10, () => ({ bodies: [{ id: 1, pos: [1.4, DECK + H, 0], kind: CARGO_KIND_TOTE }] })))
    tr.lost(1, t, 1.4, -5, 0, null)
    tr.lost(9, t, 1.4, -5, 0, null)
    expect(tr.facts().map((f) => f.message.split(' fell')[0])).toEqual(['tote 1', 'cargo 9'])
  })
})

describe('tipped', () => {
  it('a box whose up axis passes 40 degrees, once, and again only after it rights itself', () => {
    const tr = new FlowFactTracker([roller()])
    // (the roller stopped: a box that sits still on a running one is a stall, which is not this case)
    const at = (deg: number): Step => ({ bodies: [{ id: 1, pos: [0, DECK + H, 0], quat: tilt(deg) }], speed: 0 })
    feed(tr, [...repeat(10, () => at(0)), ...repeat(20, (i) => at(i * 4)), ...repeat(20, () => at(80)), ...repeat(20, () => at(0)), ...repeat(10, () => at(90))])
    expect(kinds(tr)).toEqual(['tipped', 'tipped'])
    expect(tr.facts()[0]!.angle).toBeGreaterThan(40)
    expect(tr.facts()[0]!.part).toBe('r')
  })

  it('not a box rocking but right side up, nor one that starts on its side', () => {
    const tr = new FlowFactTracker([roller()])
    feed(tr, repeat(240, (i) => ({ bodies: [{ id: 1, pos: [0, DECK + H, 0], quat: tilt(25 * Math.sin(i / 5)) }, { id: 2, pos: [1, DECK + H, 0], quat: tilt(90) }], speed: 0 })))
    expect(tr.facts()).toEqual([])
  })
})

describe('stalled', () => {
  it('a box still on a running conveyor: one fact from when it stopped, with its duration once it moves', () => {
    const tr = new FlowFactTracker([roller()])
    const still = repeat(180, () => ({ bodies: [{ id: 1, pos: [0.5, DECK + H, 0] as [number, number, number] }] }))
    const moving = repeat(60, (i) => ({ bodies: [{ id: 1, pos: [0.5 + (i + 1) * 0.02, DECK + H, 0] as [number, number, number] }] }))
    feed(tr, [...still, ...moving])
    tr.finish()
    const f = tr.facts()
    expect(f.map((x) => x.kind)).toEqual(['stalled'])
    expect(f[0]!.part).toBe('r')
    expect(f[0]!.t).toBeLessThan(0.3)
    expect(f[0]!.duration).toBeCloseTo(3, 0)
    expect(f[0]!.ongoing).toBeUndefined()
  })

  it('not a box held still on a stopped conveyor (an accumulating line holding product)', () => {
    const tr = new FlowFactTracker([roller()])
    feed(tr, repeat(300, () => ({ bodies: [{ id: 1, pos: [0.5, DECK + H, 0] }, { id: 2, pos: [0.85, DECK + H, 0] }], speed: 0 })))
    tr.finish()
    expect(tr.facts()).toEqual([])
  })

  it('not a box still for less than the stall time, nor one riding the belt', () => {
    const tr = new FlowFactTracker([roller()])
    const pause = repeat(Math.round((STALL_TIME * 0.8) / DT), () => ({ bodies: [{ id: 1, pos: [0.5, DECK + H, 0] as [number, number, number] }] }))
    const ride = repeat(120, (i) => ({ bodies: [{ id: 1, pos: [0.5 + i * 0.01, DECK + H, 0] as [number, number, number] }] }))
    feed(tr, [...pause, ...ride])
    tr.finish()
    expect(tr.facts()).toEqual([])
  })

  it("boxes backing up one after another on one conveyor are one fact, counting them, and a run that ends with them still there says so", () => {
    const tr = new FlowFactTracker([roller()])
    // three boxes arrive at a stop 0.5 s apart and stay
    const steps = repeat(300, (i) => {
      const bodies: Body[] = []
      for (let k = 0; k < 3; k++) {
        const arrive = 30 * k
        bodies.push({ id: k + 1, pos: [1.2 - k * 0.32 - (i < arrive ? (arrive - i) * 0.02 : 0), DECK + H, 0] })
      }
      return { bodies }
    })
    feed(tr, steps)
    tr.finish()
    const f = tr.facts()
    expect(f.map((x) => x.kind)).toEqual(['stalled'])
    expect(f[0]!.boxes).toBe(3)
    expect(f[0]!.ongoing).toBe(true)
  })

  it('a conveyor that holds a box again after a long gap is a second fact', () => {
    const tr = new FlowFactTracker([roller()])
    const still = (n: number): Step[] => repeat(n, () => ({ bodies: [{ id: 1, pos: [0.5, DECK + H, 0] as [number, number, number] }] }))
    const gone = repeat(Math.round((STALL_MERGE_GAP + 0.5) / DT), () => ({ bodies: [] as Body[] }))
    feed(tr, [...still(120), ...gone, ...still(120).map((s) => ({ bodies: [{ ...s.bodies[0]!, id: 2 }] }))])
    tr.finish()
    expect(kinds(tr)).toEqual(['stalled', 'stalled'])
  })
})

describe('flicker', () => {
  const box = (id: number): Body => ({ id, pos: [1, DECK + H, 0] })
  const blocked = (id: number, n: number): Step[] => repeat(n, () => ({ bodies: [box(id)], beam: { hit: true, distance: 0.3 }, target: id, tags: { Eye: true } }))
  const clear = (n: number, bodies: Body[] = [box(1)]): Step[] => repeat(n, () => ({ bodies, beam: { hit: false, distance: 1 }, tags: { Eye: false } }))

  it('a beam clear for under 100 ms between two blocked periods by the same box, naming the tag that toggled', () => {
    const tr = new FlowFactTracker([roller(), eye()])
    feed(tr, [...blocked(1, 30), ...clear(3), ...blocked(1, 30)])
    const f = tr.facts()
    expect(f.map((x) => x.kind)).toEqual(['flicker'])
    expect(f[0]).toMatchObject({ part: 'eye', link: 'beam', cargo: 1, tags: ['Eye'] })
    expect(f[0]!.gap).toBeCloseTo(3 * DT, 3)
    expect(f[0]!.message).toContain("'Eye 1' (eye)")
  })

  it('not a short gap between two different boxes, nor a real gap', () => {
    const tr = new FlowFactTracker([roller(), eye()])
    feed(tr, [...blocked(1, 30), ...clear(3), ...blocked(2, 30), ...clear(30, []), ...blocked(3, 30)])
    expect(tr.facts()).toEqual([])
  })

  it('repeats on one beam close together are one record, counted', () => {
    const tr = new FlowFactTracker([roller(), eye()])
    feed(tr, [...blocked(1, 10), ...clear(2), ...blocked(1, 10), ...clear(2), ...blocked(1, 10), ...clear(1), ...blocked(1, 10)])
    expect(kinds(tr)).toEqual(['flicker'])
    expect(tr.facts()[0]!.count).toBe(3)
  })
})

describe('the record', () => {
  it('is deterministic: the same steps give the same facts', () => {
    const run = (): FlowFact[] => {
      const tr = new FlowFactTracker([roller(), eye()])
      const t = feed(tr, fallOff(1, 0.5, 0.5))
      feed(tr, repeat(120, () => ({ bodies: [{ id: 2, pos: [0.5, DECK + H, 0] }] })), t)
      tr.finish()
      return [...tr.facts()]
    }
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
  })

  it('drain hands each new or updated fact once, and a stall twice: when it starts and when it ends', () => {
    const tr = new FlowFactTracker([roller()])
    feed(tr, repeat(120, () => ({ bodies: [{ id: 1, pos: [0.5, DECK + H, 0] }] })))
    const first = tr.drain()
    expect(first.map((f) => [f.kind, f.duration])).toEqual([['stalled', undefined]])
    expect(tr.drain()).toEqual([])
    tr.finish()
    const second = tr.drain()
    expect(second.map((f) => [f.id, f.ongoing])).toEqual([[first[0]!.id, true]])
  })

  it('keeps at most MAX_FACTS and counts the rest', () => {
    const tr = new FlowFactTracker([])
    const n = MAX_FACTS + 25
    const row = (deg: number): Step => ({ bodies: Array.from({ length: n }, (_, i) => ({ id: i + 1, pos: [i, 5, 0] as [number, number, number], quat: tilt(deg) })), held: [] })
    feed(tr, [row(0), row(80)])
    expect(tr.facts().length).toBe(MAX_FACTS)
    expect(tr.overflow).toBe(25)
    expect(summarizeFlowFacts(tr.facts(), tr.overflow)).toBe(`${MAX_FACTS} tipped, 25 more not kept`)
  })
})
