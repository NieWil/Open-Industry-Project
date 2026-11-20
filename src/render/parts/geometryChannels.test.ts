import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Matrix4, Mesh, Quaternion, Vector3 } from 'three'
import type { InstancedMesh } from 'three'
import type { MeshStandardMaterial, Texture } from 'three'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import { createCustomVisual } from './sdkPart'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// The geometry() animation channels (MeshPart.scroll / MeshPart.spin): a part's own texture moves along its U, and a
// submesh turns about an axis, at a speed the behavior reports while the sim runs (the same live value the
// Inspector shows, so a program-commanded speed drives them), falling back to the param of that name. Stopped,
// nothing moves. Animated submeshes stay out of the cross-part instance pool.

const behavior = `definePart({
  params: { speed: { type: 'number', default: 1 }, fan: { type: 'number', default: 0.5 } },
  geometry(g) {
    return [
      { desc: g.box([1, 0.1, 0.1], [0, 0, 0]), material: 'links', scroll: { tilesPerMeter: 16, speed: 'speed' } },
      { desc: g.box([0.1, 0.1, 0.1], [0, 1, 0]), material: 'plain', spin: { axis: [0, 0, 2], radius: 0.25, center: [0, 1, 0], speed: 'fan' } },
      { desc: g.box([0.2, 0.2, 0.2], [2, 0, 0]), material: 'plain' },
    ]
  },
  step(ctx) {},
})`

const pkg = (): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: 'acme.animated',
    name: 'Animated',
    params: { speed: { type: 'number', default: 1 }, fan: { type: 'number', default: 0.5 } },
    behavior,
    assets: [{ id: 'tex', mime: 'image/webp', url: '/textures/ChainLink.webp' }],
    materials: [{ id: 'links', albedo: 'tex', metalness: 0, roughness: 1 }, { id: 'plain', color: [0.5, 0.5, 0.5] }],
    geometry: { kind: 'rig', links: [{ name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] }], joints: [] },
  }) as PartPackage

type Hooks = { tick: (dt: number, running: boolean) => boolean; applyValues: (v: Record<string, number | boolean>) => void }
const build = () => {
  const v = createCustomVisual({ id: 'a', type: 'part', packageId: 'acme.animated', position: [0, 0, 0], rotationY: 0, params: {} })
  const dressing = v.object.children.filter((c) => (c as Mesh).isMesh && typeof c.userData.linkName !== 'string') as Mesh[]
  const scroller = dressing.find((m) => !!(m.material as MeshStandardMaterial).map)!
  const spinner = dressing.find((m) => m !== scroller && m.geometry.boundingBox === null ? m.position.length() === 0 && Math.abs(m.geometry.getAttribute('position').getY(0) - 1) < 0.2 : Math.abs(m.geometry.getAttribute('position').getY(0) - 1) < 0.2)!
  const still = dressing.find((m) => m !== scroller && m !== spinner)!
  const hooks = v.object.userData as unknown as Hooks
  return { v, scroller, spinner, still, hooks, tex: (scroller.material as MeshStandardMaterial).map as Texture }
}

describe('geometry() animation channels', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}) // node has no image decoder: the albedo falls back, harmlessly
    registerPackage(pkg())
  })
  afterEach(() => {
    clearPackages()
    vi.restoreAllMocks()
  })

  it('builds the hooks, gives the scroll its own texture copy, and keeps both animated submeshes out of the pool', () => {
    const { v, scroller, spinner, still, hooks, tex } = build()
    expect(typeof hooks.tick).toBe('function')
    expect(typeof hooks.applyValues).toBe('function')
    expect(tex).toBeTruthy()
    expect(scroller.userData.poolUnit).toBeUndefined()
    expect(spinner.userData.poolUnit).toBeUndefined()
    expect(still.userData.poolUnit).toBe(true)
    v.dispose()
  })

  it('scrolls toward +U at speed × tilesPerMeter, from the reported speed while running, else the param', () => {
    const { v, hooks, tex } = build()
    hooks.tick(0.1, true) // no report yet: the param, 1 m/s → 1.6 tiles in 0.1 s
    expect(tex.offset.x).toBeCloseTo(-0.6, 9) // offset is kept % 1
    hooks.applyValues({ speed: 0.25 }) // a program slows it: 0.25 m/s × 16 = 4 tiles/s
    tex.offset.x = 0
    hooks.tick(0.05, true)
    expect(tex.offset.x).toBeCloseTo(-0.2, 9)
    tex.offset.x = 0
    hooks.tick(1, false) // stopped: frozen, and the stale report is dropped
    expect(tex.offset.x).toBe(0)
    v.dispose()
  })

  it('spins about its axis through its centre at speed ÷ radius, right-handed', () => {
    const { v, spinner, hooks } = build()
    hooks.applyValues({ fan: Math.PI / 4 }) // π/4 m/s at r 0.25 → π rad/s
    hooks.tick(0.5, true) // → a quarter turn about +z
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2)
    expect(spinner.quaternion.angleTo(q)).toBeCloseTo(0, 6)
    // the centre (0, 1, 0) stays put: position = c − q·c
    const c = new Vector3(0, 1, 0)
    const moved = c.clone().applyQuaternion(spinner.quaternion).add(spinner.position)
    expect(moved.distanceTo(c)).toBeCloseTo(0, 9)
    const before = spinner.quaternion.clone()
    hooks.tick(1, false) // stopped: holds its pose
    expect(spinner.quaternion.angleTo(before)).toBeCloseTo(0, 9)
    v.dispose()
  })

  it('turns a drawn part\'s spinning submesh the same way, its mesh and not its grain, and keeps it out of the pool', () => {
    registerPackage({ ...pkg(), id: 'acme.animated-drawn', geometry: { kind: 'drawn' } } as PartPackage)
    const v = createCustomVisual({ id: 'd', type: 'part', packageId: 'acme.animated-drawn', position: [0, 0, 0], rotationY: 0, params: {} })
    const meshes = v.object.children.filter((c) => (c as Mesh).isMesh) as Mesh[]
    const spinner = meshes.find((m) => Math.abs(m.geometry.getAttribute('position').getY(0) - 1) < 0.2)!
    expect(spinner.userData.poolUnit).toBeUndefined()
    const hooks = v.object.userData as unknown as Hooks
    hooks.tick(0.5, true) // the fan param, 0.5 m/s at r 0.25 → 2 rad/s → 1 rad
    expect(spinner.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1))).toBeCloseTo(0, 6)
    const c = new Vector3(0, 1, 0)
    expect(c.clone().applyQuaternion(spinner.quaternion).add(spinner.position).distanceTo(c)).toBeCloseTo(0, 9)
    v.dispose()
  })
})

// MeshPart.instances + MeshPart.spin: a spinning bank (a roller bed) turns every instance about its own local Z by
// turning its material's object-space grain (sdk/bankSpin.ts) - the engine roller's mechanism, so an SDK-drawn
// roller spins like one. Both tiers: a rig's geometry() hangs the bank on a link; a function part on its root.
const bankBehavior = `definePart({
  params: { speed: { type: 'number', default: 0.5 } },
  geometry(g) {
    var rollers = [], bolts = []
    for (var i = 0; i < 4; i++) {
      rollers.push({ position: [i * 0.1, 0, 0], scale: [0.02, 0.02, 0.5] })
      bolts.push({ position: [i * 0.1, -0.1, 0], scale: [0.01, 0.01, 0.01] })
    }
    return [
      { desc: g.lathe([[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]], { axis: 'z', segments: 12 }), finish: 'roller', link: 'bed', instances: rollers, spin: { axis: [0, 0, -1], radius: 0.02, speed: 'speed' } },
      { desc: g.box([1, 1, 1], [0, 0, 0]), finish: 'bolt', link: 'bed', instances: bolts },
    ]
  },
  step(ctx) {},
})`
const bankPkg = (kind: 'rig' | 'drawn'): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: `acme.bank-${kind}`,
    name: 'Bank',
    params: { speed: { type: 'number', default: 0.5 } },
    behavior: bankBehavior,
    geometry: kind === 'rig' ? { kind: 'rig', links: [{ name: 'bed', shape: { kind: 'frame' }, offset: [0, 0.3, 0] }], joints: [] } : { kind: 'drawn' },
  }) as PartPackage

describe('geometry() instanced banks + bank spin', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerPackage(bankPkg('rig'))
    registerPackage(bankPkg('drawn'))
  })
  afterEach(() => {
    clearPackages()
    vi.restoreAllMocks()
  })
  type BankHooks = { tick: (dt: number, running: boolean) => boolean; applyValues?: (v: Record<string, number | boolean>) => void; applyConveyorSpeed?: (v: number) => void }
  const banks = (kind: 'rig' | 'drawn') => {
    const v = createCustomVisual({ id: kind, type: 'part', packageId: `acme.bank-${kind}`, position: [0, 0, 0], rotationY: 0, params: {} })
    const found: InstancedMesh[] = []
    v.object.traverse((o) => { if ((o as InstancedMesh).isInstancedMesh && (o as InstancedMesh).count > 0) found.push(o as InstancedMesh) })
    const roller = found.find((m) => spinOf(m) !== null)!
    const bolt = found.find((m) => m !== roller)!
    return { v, roller, bolt, hooks: v.object.userData as unknown as BankHooks }
  }
  const spinOf = (m: InstancedMesh): { value: number } | null => ((m.material as MeshStandardMaterial).userData.spinUniform as { value: number } | undefined) ?? null

  for (const kind of ['rig', 'drawn'] as const) {
    it(`${kind}: draws each bank as one InstancedMesh at its transforms${kind === 'rig' ? ', on its link' : ''}`, () => {
      const { v, roller, bolt } = banks(kind)
      expect(roller.count).toBe(4)
      expect(bolt.count).toBe(4)
      const m = new Matrix4(), p = new Vector3(), q = new Quaternion(), s = new Vector3()
      roller.getMatrixAt(2, m); m.decompose(p, q, s)
      expect(p.x).toBeCloseTo(0.2, 6)
      expect(s.toArray()).toEqual([0.02, 0.02, 0.5].map((x) => expect.closeTo(x, 6)))
      if (kind === 'rig') expect(roller.parent?.userData.linkName ?? roller.parent?.parent?.userData.linkName).toBe('bed')
      v.dispose()
    })

    it(`${kind}: a spinning bank turns its grain at speed ÷ radius, in the engine roller's sense; stopped, it holds`, () => {
      const { v, roller, bolt, hooks } = banks(kind)
      const u = spinOf(roller)!
      expect(spinOf(bolt)).toBeNull() // the static bank keeps an ordinary material
      hooks.tick(0.01, true) // the param: 0.5 m/s at r 0.02 → 25 rad/s → 0.25 rad
      // axis -Z: the uniform runs +angle, which is what the engine roller (rollerSpinTick) writes for a +speed
      expect(u.value).toBeCloseTo(0.25, 9)
      const held = u.value
      hooks.tick(1, false)
      expect(u.value).toBe(held)
      v.dispose()
    })
  }

  it('rig: a reported speed drives the bank (applyValues), like any channel', () => {
    const { v, roller, hooks } = banks('rig')
    hooks.applyValues!({ speed: 0.2 })
    hooks.tick(0.01, true) // 0.2 / 0.02 × 0.01 = 0.1 rad
    expect(spinOf(roller)!.value).toBeCloseTo(0.1, 9)
    v.dispose()
  })
})

// MeshPart.squash: a geometry() submesh compresses along its link's Y off a lamp, anchored at its lowest point (a bank
// of suction cups collapsing as the vacuum grips, the lips staying on the load), and relaxes when the sim stops.
const squashBehavior = `definePart({
  lamps: ['vac'],
  geometry(g) {
    var cups = []
    for (var i = 0; i < 3; i++) cups.push({ position: [i * 0.1, -0.1, 0] })
    return [{ desc: g.box([0.05, 0.05, 0.05], [0, -0.025, 0]), material: 'plain', link: 'tool', instances: cups, squash: { amount: 0.2, lamp: 'vac' } }]
  },
  step(ctx) {},
})`

describe('geometry() squash', () => {
  beforeEach(() => {
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'acme.squash',
      name: 'Squash',
      params: {},
      behavior: squashBehavior,
      materials: [{ id: 'plain', color: [0.5, 0.5, 0.5] }],
      geometry: { kind: 'rig', links: [{ name: 'tool', shape: { kind: 'frame' }, offset: [0, 1, 0] }], joints: [] },
    } as PartPackage)
  })
  afterEach(() => clearPackages())

  it('compresses toward the lamp about its lowest point while running, relaxes when stopped, and stays out of the pool', () => {
    const v = createCustomVisual({ id: 's', type: 'part', packageId: 'acme.squash', position: [0, 0, 0], rotationY: 0, params: {} })
    let bank: InstancedMesh | undefined
    v.object.traverse((o) => { if ((o as InstancedMesh).isInstancedMesh) bank = o as InstancedMesh })
    const hooks = v.object.userData as unknown as { tick: (dt: number, running: boolean) => boolean; applyLamps: (l: Record<string, boolean>) => void }
    expect(bank!.userData.poolMobile).toBe(true)
    // the rim: the lowest point of every cup, which must not move as they compress
    const rim = -0.15
    const rimNow = (): number => bank!.position.y + rim * bank!.scale.y
    hooks.applyLamps({ vac: true })
    expect(hooks.tick(10, true)).toBe(true)
    expect(bank!.scale.y).toBeCloseTo(0.8, 6)
    expect(rimNow()).toBeCloseTo(rim, 9)
    hooks.tick(10, false) // stopped: relaxes, whatever the lamp last said
    expect(bank!.scale.y).toBe(1)
    expect(rimNow()).toBeCloseTo(rim, 9)
    v.dispose()
  })
})
