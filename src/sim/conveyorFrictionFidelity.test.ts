import type { PackageManifest } from '../core/parts/partPackage'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { conveyorEndsOf } from '../core/parts/partGeometry'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { BOX_FRICTION, DEFAULT_SIM_HZ, SCENE_VERSION } from '../core/types'
import type { PartInstance, SdkPart } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// How faithfully a conveyor's friction param (ConveyorDecl.frictionParam, the grip against a carton) reproduces
// Coulomb friction, measured against the closed forms:
//   - breakaway: a carton on a stopped incline holds below atan(mu) and slides above it, at any mass;
//   - sliding: past breakaway it accelerates down the slope at g (sin t - mu cos t);
//   - catch-up: dropped on a running flat belt it accelerates at mu g until it matches the belt;
//   - other cargo: a body of friction f grips the same surface at mu sqrt(f / BOX_FRICTION), Jolt's pair rule.
// Cargo is set down on a stopped deck and the deck then started, so no landing impulse adds to the pickup. Run at
// the app's default rate. Each case runs through both contact listeners, and the last ones through the
// shipped belt and roller parts, whose decks are built by different paths (a drawn path bed, a rig link).
//
// The cargo is measured as the app builds it, with no linear damping (bodyFactory makeCargoBody). Jolt's default of
// 0.05 per second would read here as 2 to 5% too little acceleration, so these bounds also keep it out. Measured at
// 60 Hz, sliding and catch-up match the closed forms to 0.1%, and breakaway lies within 0.5 to 1 degree of atan(mu):
// half a degree below it a carton creeps 2 to 9 cm in 2 s, one degree below it holds.

const Jolt = await initJolt()
const HZ = DEFAULT_SIM_HZ
const G = 9.81
const RAD = Math.PI / 180
/** seconds cargo is left to settle on a stopped deck before a catch-up measurement */
const SETTLE = 1

/** a belt of one straight run tilted `tiltDeg` that declares its friction param, standing still for the first `SETTLE`
 *  seconds and then driven at `speed` m/s, so cargo set on it starts from rest rather than landing on a moving surface */
function beltPkg(tiltDeg: number, speed: number): PartPackage {
  const params = {
    segments: { type: 'numberList', arity: 2, default: [[6, tiltDeg]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
    width: { type: 'number', default: 1 },
    height: { type: 'number', default: 0.17 },
    friction: { type: 'number', default: 0.59 },
  }
  return {
    format: PACKAGE_FORMAT,
    id: 'test.fid-belt',
    name: 'Fidelity Belt',
    conveyor: { bed: 'path', surface: 'belt', frictionParam: 'friction' },
    params,
    behavior: `var t = 0
      definePart({ params: ${JSON.stringify(params)}, step(ctx) {
        t += ctx.dt
        var s = t > ${SETTLE} ? ${speed} : 0
        ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
      } })`,
    geometry: { kind: 'drawn', bounds: { length: 6, width: 1, top: 0.17 }, conveys: true },
  } as unknown as PartPackage
}

const belt = (id: string, pos: [number, number, number], friction: number): SdkPart =>
  ({ id, type: 'part', packageId: 'test.fid-belt', position: pos, rotationY: 0, params: { friction } }) as unknown as SdkPart

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[]; conveyor?: PackageManifest['conveyor'] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function shippedPkg(dir: string): PartPackage {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const pkg = buildPackage(
    { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...(manifest.conveyor ? { conveyor: manifest.conveyor } : {}) },
    behavior.replace(/\r\n/g, '\n'),
  )
  registerPackage(pkg)
  return pkg
}

interface Opts {
  /** the ContactListenerJS fallback instead of the forked build's native listener */
  js: boolean
}

/** the world's cargo bodies, in spawn order */
const cargoBodies = (w: SimWorld): { body: { SetFriction(f: number): void } }[] => (w as unknown as { boxes: { body: { SetFriction(f: number): void } }[] }).boxes

/** each cargo's x, sampled every step for `seconds` */
function track(w: SimWorld, seconds: number): number[][] {
  const xs: number[][] = []
  for (let i = 0; i < HZ * seconds; i++) {
    w.step()
    const p = w.frame().positions
    xs.push(Array.from({ length: p.length / 3 }, (_, k) => p[k * 3]!))
  }
  return xs
}

/** a carton set down 3 m up a stopped belt tilted `tiltDeg`: how far it slid back over the 2 s after a 1 s settle */
function slideOnIncline(tiltDeg: number, mu: number, o: Opts, mass = 5): number {
  registerPackage(beltPkg(tiltDeg, 0))
  const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [belt('b', [0, 2, 0], mu)] }, { forceJsListener: o.js })
  try {
    const t = tiltDeg * RAD
    w.spawnBoxAt(3 * Math.cos(t), 2 + 3 * Math.sin(t) + 0.16, 0, 0.2, 0.15, 0.2, 0, mass)
    const xs = track(w, 3)
    return (xs[HZ - 1]![0]! - xs[xs.length - 1]![0]!) / Math.cos(t)
  } finally {
    w.dispose()
    clearPackages()
  }
}

/** a carton sliding down a stopped belt tilted `tiltDeg`: its acceleration along the slope, once sliding */
function slideAcceleration(tiltDeg: number, mu: number, o: Opts): number {
  registerPackage(beltPkg(tiltDeg, 0))
  const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [belt('b', [0, 2, 0], mu)] }, { forceJsListener: o.js })
  try {
    const t = tiltDeg * RAD
    w.spawnBoxAt(5 * Math.cos(t), 2 + 5 * Math.sin(t) + 0.16, 0, 0.2, 0.15, 0.2, 0)
    const along = track(w, 1.4).map((r) => r[0]! / Math.cos(t))
    // velocity by central difference at 0.6 s and 1.2 s, after the landing has settled into a steady slide
    const v = (i: number): number => ((along[i + 1]! - along[i - 1]!) * HZ) / 2
    const i1 = Math.round(0.6 * HZ)
    const i2 = Math.round(1.2 * HZ)
    return -(v(i2) - v(i1)) / ((i2 - i1) / HZ)
  } finally {
    w.dispose()
    clearPackages()
  }
}

/** the acceleration of cargo `k` resting on a deck that starts at `speed`, fitted between 15% and 75% of it */
function catchUp(xs: number[][], k: number, speed: number): number {
  const v = xs.map((r, i) => (i === 0 ? 0 : (r[k]! - xs[i - 1]![k]!) * HZ))
  const a = v.findIndex((x) => x > 0.15 * speed)
  const b = v.findIndex((x) => x > 0.75 * speed)
  expect(a, 'the cargo never picked up speed').toBeGreaterThan(0)
  expect(b, 'the cargo never got near the deck speed').toBeGreaterThan(a)
  return (v[b]! - v[a]!) / ((b - a) / HZ)
}

/** a carton resting near the tail of a flat belt that starts at 2 m/s, its friction `cargoFriction`: its catch-up rate */
function catchUpOnBelt(mu: number, o: Opts, cargoFriction = BOX_FRICTION): number {
  registerPackage(beltPkg(0, 2))
  const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [belt('b', [0, 2, 0], mu)] }, { forceJsListener: o.js })
  try {
    w.spawnBoxAt(0.5, 2.2, 0, 0.2, 0.15, 0.2, 0)
    cargoBodies(w)[0]!.body.SetFriction(cargoFriction)
    track(w, SETTLE)
    return catchUp(track(w, 1.5), 0, 2)
  } finally {
    w.dispose()
    clearPackages()
  }
}

const near = (measured: number, expected: number, rel: number, what: string): void => {
  expect(Math.abs(measured - expected) / expected, `${what}: measured ${measured.toFixed(3)}, expected ${expected.toFixed(3)}`).toBeLessThan(rel)
}

describe('conveyor friction fidelity', () => {
  afterEach(() => clearPackages())

  for (const js of [false, true]) {
    const o: Opts = { js }
    const listener = js ? 'JS listener' : 'native listener'

    it(`a carton breaks away within 1 degree of atan(mu), at any mass (${listener})`, () => {
      for (const mu of [0.2, 0.4, 0.59, 0.9]) {
        const critical = Math.atan(mu) / RAD
        for (const mass of [1, 5, 50]) {
          expect(slideOnIncline(critical - 1, mu, o, mass), `mu ${mu}, ${mass} kg, 1 deg below`).toBeLessThan(0.02)
          expect(slideOnIncline(critical + 1, mu, o, mass), `mu ${mu}, ${mass} kg, 1 deg above`).toBeGreaterThan(0.5)
        }
      }
    })

    it(`a sliding carton accelerates at g (sin t - mu cos t) (${listener})`, () => {
      for (const [mu, deg] of [[0.2, 35], [0.4, 35], [0.59, 45], [0.9, 55]] as const) {
        const t = deg * RAD
        near(slideAcceleration(deg, mu, o), G * (Math.sin(t) - mu * Math.cos(t)), 0.01, `mu ${mu} at ${deg} deg`)
      }
    })

    it(`a carton on a belt that starts catches up at mu g (${listener})`, () => {
      for (const mu of [0.2, 0.4, 0.59, 0.9]) near(catchUpOnBelt(mu, o), mu * G, 0.01, `mu ${mu}`)
    })

    it(`other cargo grips at mu sqrt(f / carton), Jolt's pair rule (${listener})`, () => {
      for (const f of [0.25, 1]) near(catchUpOnBelt(0.59, o, f), 0.59 * Math.sqrt(f / BOX_FRICTION) * G, 0.01, `cargo friction ${f}`)
    })

    it(`each member of a merged deck grips at its own mu (${listener})`, () => {
      registerPackage(beltPkg(0, 2))
      const a = belt('a', [0, 2, 0], 0.2)
      const head = conveyorEndsOf(a).find((e) => e.outX > 0)!
      const tail = conveyorEndsOf(belt('b', [0, 0, 0], 0.9)).find((e) => e.outX < 0)!
      const b = belt('b', [head.x - tail.x, head.y - tail.y, head.z - tail.z], 0.9)
      const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [a, b] }, { forceJsListener: js })
      try {
        const groups = (w as unknown as { partGroups: Map<string, { bodies: unknown[] }> }).partGroups
        expect(groups.get('b')?.bodies.length ?? 0, "b's deck is inside a's body").toBe(0)
        w.spawnBoxAt(0.5, 2.2, 0, 0.2, 0.15, 0.2, 0)
        w.spawnBoxAt(b.position[0] + 0.5, 2.2, 0, 0.2, 0.15, 0.2, 0)
        track(w, SETTLE)
        const xs = track(w, 1.5)
        near(catchUp(xs, 0, 2), 0.2 * G, 0.01, 'on the 0.2 member')
        near(catchUp(xs, 1, 2), 0.9 * G, 0.01, 'on the 0.9 member')
      } finally {
        w.dispose()
      }
    })
  }

  // the shipped parts' own decks: the belt's drawn path bed and the roller's rig deck link
  for (const [dir, mu] of [['belt-conveyor', 0.3], ['roller-conveyor', 0.3], ['belt-conveyor', 0.8]] as const) {
    it(`the shipped ${dir} at friction ${mu} catches a carton up at mu g`, () => {
      const pkg = shippedPkg(dir)
      const conveyor = createSdkPart(pkg, 'c', [0, 1, 0], 0) as SdkPart
      // held still by its speed tag while the carton settles, then started with no ramp
      Object.assign(conveyor.params, { fpmUnits: false, speed: 2, speedTag: 'sp', accelTime: 0, friction: mu })
      // a tail-origin belt starts at x 0, a centre-origin roller bed at minus half its length
      const x = dir === 'roller-conveyor' ? -1.5 : 0.5
      const parts: PartInstance[] = [conveyor]
      const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts })
      try {
        w.spawnBoxAt(x, 1.6, 0, 0.2, 0.15, 0.2, 0)
        w.setBehaviorInputTags({ sp: 0 })
        track(w, SETTLE)
        w.setBehaviorInputTags({ sp: 2 })
        near(catchUp(track(w, 1.5), 0, 2), mu * G, 0.01, dir)
      } finally {
        w.dispose()
      }
    })
  }
})
