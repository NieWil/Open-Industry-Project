import initJoltST from 'jolt-physics/wasm-compat'
import initJoltMT from 'jolt-physics/wasm-compat-multithread'
import { afterAll, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON } from '../core/types'
import { SimWorld } from './world'
import type { JoltModule } from './world'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

// Gate for defaulting ?joltthreads on: the multithreaded Jolt build must produce bit-identical
// simulation to the single-threaded build. The validation surfaces (project tests, node goldens) run
// single-threaded while a threaded browser would run MT, so any divergence would let a scene
// "validate" on one engine and behave differently on the other. Jolt documents determinism
// independent of thread count; this pins that promise through our builds and workload (native
// ConveyorContactListener, linear + arc carry, box-box contacts). e2e/mt-determinism.mjs is the
// browser twin of this check.
//
// Node can run the MT build on the fork, and on upstream from the commit the fork is based on.
// Upstream 1.1.0 and earlier (incl. that npm release) hang at init under node: their pthread
// workers never identify themselves. Pool constraint: the pthread pool is sized to the machine
// (at most 9) and one MT world takes most of it, so never hold two MT worlds at once (deadlock);
// the repeat check runs sequentially over recorded checkpoints.

const JoltST = (await initJoltST()) as unknown as JoltModule
const JoltMT = (await initJoltMT()) as unknown as JoltModule

// ---------- fixtures (the inline-package pattern of sdkConveyorParity.test.ts / frame.test.ts) ----------

function cargoPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.box',
    name: 'Box',
    params: {
      length: { type: 'number', default: 0.6 },
      height: { type: 'number', default: 0.4 },
      width: { type: 'number', default: 0.4 },
      mass: { type: 'number', default: 10 },
      color: { type: 'color', default: '#ffffff' },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } },
  } as unknown as PartPackage
}

/** linear carry: a belt-like part driving setSurfaceVelocity each tick (exercises the facet-table sync) */
function beltPkg(): PartPackage {
  const params = {
    segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
    width: { type: 'number', default: 0.6 },
    height: { type: 'number', default: 0.5 },
    speed: { type: 'number', default: 1.5 },
  }
  return {
    format: PACKAGE_FORMAT,
    id: 'test.belt',
    name: 'SDK Belt',
    conveyor: { bed: 'path', surface: 'belt' },
    params,
    behavior: `definePart({
      params: ${JSON.stringify(params)},
      step(ctx) { var s = ctx.params.speed; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s }) },
    })`,
    geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}

/** arc carry: a curved conveyor driving setArcSurfaceVelocity (exercises the arc facet path) */
function curvedPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.curve',
    name: 'SDK Curve', conveyor: { bed: 'arc', surface: 'belt', speedParam: 'speed' },
    params: {
      innerRadius: { type: 'number', default: 0.5 },
      width: { type: 'number', default: 1.524 },
      sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width' } },
      speed: { type: 'number', default: 2 },
    },
    behavior: `definePart({
      params: {
        innerRadius: { type: 'number', default: 0.5 },
        width: { type: 'number', default: 1.524 },
        sweepDeg: { type: 'number', default: 90 },
        speed: { type: 'number', default: 2 },
      },
      geometry(g) { return [{ desc: g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], [[0, 0, 0], [1, 0, 0]]), finish: 'belt' }] },
      step(ctx) {
        var rc = ctx.params.innerRadius + ctx.params.width / 2
        ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega: ctx.params.speed / rc })
      },
    })`,
    geometry: { kind: 'drawn', bounds: { length: 2.274, width: 2.274, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}

function part(id: string, packageId: string, pos: [number, number, number], params: Record<string, unknown>): PartInstance {
  return { id, type: 'part', packageId, position: pos, rotationY: 0, params } as unknown as PartInstance
}

function box(id: string, pos: [number, number, number]): PartInstance {
  return part(id, 'test.box', pos, { length: 0.6, height: 0.4, width: 0.4, mass: 10, color: '#e0a030' })
}

/** belt with a TOUCHING box train (box-box contacts) + a curve with boxes scattered over its annulus
 *  (whichever land on the arc deck ride it; the rest settle on the ground - all deterministic work) */
function testScene(): SceneJSON {
  const parts: PartInstance[] = [
    part('belt', 'test.belt', [0, 1, 0], { segments: [[4, 0]], width: 0.6, height: 0.5, speed: 1.5 }),
    part('curve', 'test.curve', [6, 1, 0], { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 }),
  ]
  for (let i = 0; i < 4; i++) parts.push(box(`b${i}`, [-1.6 + i * 0.6, 1.35, 0]))
  for (let i = 0; i < 6; i++) parts.push(box(`c${i}`, [6 + 0.9 * Math.cos(i), 1.35, 0.9 * Math.sin(i)]))
  return { version: SCENE_VERSION, parts }
}

// ---------- bitwise frame comparison ----------

const STEPS = 360
const CHECK_EVERY = 60

function bits(a: Float32Array): Uint32Array {
  return new Uint32Array(a.buffer, a.byteOffset, a.length)
}

type Snap = { count: number; positions: Uint32Array; quats: Uint32Array }

function snap(w: SimWorld): Snap {
  const f = w.frame()
  return { count: f.count, positions: bits(f.positions).slice(), quats: bits(f.quats).slice() }
}

/** run a world for STEPS steps, snapshotting every CHECK_EVERY */
function record(w: SimWorld): Snap[] {
  const snaps: Snap[] = []
  for (let s = 1; s <= STEPS; s++) {
    w.step()
    if (s % CHECK_EVERY === 0) snaps.push(snap(w))
  }
  return snaps
}

function expectSnapsIdentical(a: Snap[], b: Snap[], label: string): void {
  expect(b.length, `${label}: checkpoint count`).toBe(a.length)
  for (let k = 0; k < a.length; k++) {
    const sa = a[k]
    const sb = b[k]
    if (!sa || !sb) throw new Error(`${label}: missing checkpoint ${k}`)
    expect(sb.count, `${label} @checkpoint ${k}: body count`).toBe(sa.count)
    for (const key of ['positions', 'quats'] as const) {
      const va = sa[key]
      const vb = sb[key]
      for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) throw new Error(`${label} @checkpoint ${k}: ${key} bits[${i}] diverged`)
      }
    }
  }
}

// ---------- specs ----------

describe('multithreaded Jolt determinism (gate for threads-by-default)', () => {
  registerPackage(cargoPkg())
  registerPackage(beltPkg())
  registerPackage(curvedPkg())
  afterAll(() => clearPackages())

  it('MT build is bit-identical to the ST build over 6 s of conveyor carry', () => {
    // ST world has no job threads, so one live MT world fits the pthread pool
    const wst = new SimWorld(JoltST, testScene())
    const wmt = new SimWorld(JoltMT, testScene())
    try {
      const a = record(wst)
      const b = record(wmt)
      expectSnapsIdentical(a, b, 'ST vs MT')
      // sanity: the sim did real work (belt carried the train), so equality isn't vacuous
      const f = wst.frame()
      expect(f.count).toBeGreaterThan(0)
      expect(Math.max(...f.positions.filter((_, i) => i % 3 === 0))).toBeGreaterThan(0.5)
    } finally {
      wst.dispose()
      wmt.dispose()
    }
  })

  it('MT build is run-to-run repeatable (thread scheduling does not leak into results)', () => {
    // sequential - two live MT worlds would exceed the pthread pool and deadlock
    const wa = new SimWorld(JoltMT, testScene())
    let a: Snap[]
    try {
      a = record(wa)
    } finally {
      wa.dispose()
    }
    const wb = new SimWorld(JoltMT, testScene())
    try {
      expectSnapsIdentical(a, record(wb), 'MT vs MT')
    } finally {
      wb.dispose()
    }
  })
})
