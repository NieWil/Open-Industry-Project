import type { PackageManifest } from '../core/parts/partPackage'
// The tote's collider is hollow and stacks on its foot (core/tote.ts toteCollider, bodyFactory.ts buildToteShape).
// These pin what that is for: cargo put in a tote stays in it and rides with it, and a stack of totes locates
// itself, ledge on rim, at its height less the foot per level.

import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { TOTE_FLOOR_T, TOTE_FOOT_H, TOTE_SIZE } from '../core/tote'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SdkPart } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
// the tote is a Containers library part (libraries/containers/tote), the rest are built-ins
const TOTE_MANIFEST = import.meta.glob('../../libraries/containers/tote/manifest.json', { eager: true, import: 'default' }) as typeof RIGS
const TOTE_BEHAVIOR = import.meta.glob('../../libraries/containers/tote/behavior.js', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const manifest = dir === 'tote' ? Object.values(TOTE_MANIFEST)[0] : RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = dir === 'tote' ? Object.values(TOTE_BEHAVIOR)[0] : BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part for ${dir}`)
  const pkg = buildPackage(
    { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...((manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) },
    behavior.replace(/\r\n/g, '\n'),
  )
  registerPackage(pkg)
  return pkg
}

interface LiveBody {
  partId: string | null
  body: { GetPosition(): { GetX(): number; GetY(): number; GetZ(): number } }
}
const posOf = (w: SimWorld, id: string): [number, number, number] => {
  const b = (w as unknown as { boxes: LiveBody[] }).boxes.find((x) => x.partId === id)!
  const p = b.body.GetPosition()
  return [p.GetX(), p.GetY(), p.GetZ()]
}

const [L, H, W] = TOTE_SIZE
/** the tote's floor top above its centre */
const FLOOR = -H / 2 + TOTE_FOOT_H + TOTE_FLOOR_T
const CASE = 0.2

describe('the tote collider', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('holds a case put in it, which rides along with it on a running belt', { timeout: 60000 }, () => {
    const belt = loadPkg('belt-conveyor')
    const tote = loadPkg('tote')
    const box = loadPkg('box')
    const conveyor = createSdkPart(belt, 'belt', [0, 1, 0], 0) as SdkPart
    Object.assign(conveyor.params, { segments: [[4, 0]], speed: 0.5 })
    const ty = 1 + H / 2 + 0.01
    const parts: PartInstance[] = [
      conveyor,
      createSdkPart(tote, 'tote', [0.6, ty, 0], 0),
      Object.assign(createSdkPart(box, 'case', [0.6, ty + FLOOR + CASE / 2 + 0.005, 0], 0), { params: { length: CASE, width: CASE, height: CASE, mass: 2 } }),
    ]
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages: [belt, tote, box] }, { hz: 60 })
    for (let i = 0; i < 60 * 4; i++) world.step()
    const t = posOf(world, 'tote')
    const c = posOf(world, 'case')
    // measured: the tote travels ~1.9 m in 4 s at 0.5 m/s, and the case with it, resting on its floor
    expect(t[0] - 0.6).toBeGreaterThan(1.5)
    expect(Math.abs(c[0] - t[0])).toBeLessThan(L / 2 - CASE / 2)
    expect(Math.abs(c[2] - t[2])).toBeLessThan(W / 2 - CASE / 2)
    expect(c[1] - t[1]).toBeCloseTo(FLOOR + CASE / 2, 2)
  })

  it('stacks ledge on rim, at its height less the foot per level, and nothing slides off', { timeout: 60000 }, () => {
    const tote = loadPkg('tote')
    const n = 5
    const pitch = H - TOTE_FOOT_H
    const parts: PartInstance[] = Array.from({ length: n }, (_, i) => createSdkPart(tote, `t${i}`, [0, H / 2 + pitch * i + 0.003 * i, 0], 0))
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages: [tote] }, { hz: 60 })
    for (let i = 0; i < 60 * 10; i++) world.step()
    const ps = Array.from({ length: n }, (_, i) => posOf(world!, `t${i}`))
    expect(ps[0]![1]).toBeCloseTo(H / 2, 2)
    for (let i = 1; i < n; i++) expect(ps[i]![1] - ps[i - 1]![1]).toBeCloseTo(pitch, 2)
    expect(Math.max(...ps.map((p) => Math.hypot(p[0], p[2])))).toBeLessThan(0.005)
  })

  it('keeps a stacked tote located: a sideways shove stops at the foot instead of pushing it off', { timeout: 60000 }, () => {
    const tote = loadPkg('tote')
    const parts: PartInstance[] = [
      createSdkPart(tote, 'low', [0, H / 2, 0], 0),
      // set down 2 cm off centre: its foot lands on the rim and slides in, or it is held off by the foot against the rim
      createSdkPart(tote, 'high', [0.002, H / 2 + H - TOTE_FOOT_H + 0.003, 0.002], 0),
    ]
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages: [tote] }, { hz: 60 })
    for (let i = 0; i < 60; i++) world.step()
    const w = world as unknown as { boxes: { partId: string | null; body: { GetID(): unknown } }[]; bodyInterface: { AddLinearVelocity(id: unknown, v: unknown): void } }
    const J = Jolt as unknown as { Vec3: new (x: number, y: number, z: number) => unknown; destroy(o: unknown): void }
    const v = new J.Vec3(0.3, 0, 0)
    w.bodyInterface.AddLinearVelocity(w.boxes.find((b) => b.partId === 'high')!.body.GetID(), v)
    J.destroy(v)
    for (let i = 0; i < 60 * 2; i++) world.step()
    const low = posOf(world, 'low')
    const high = posOf(world, 'high')
    // the foot's clearance inside the rim is 3 mm a side; the shove moves the pair, not one off the other
    expect(Math.abs(high[0] - low[0])).toBeLessThan(0.006)
    expect(high[1] - low[1]).toBeCloseTo(H - TOTE_FOOT_H, 2)
  })
})
