import { beforeEach, describe, expect, it } from 'vitest'
import { Group, InstancedMesh, Matrix4, Mesh, Scene, Vector3 } from 'three'
import type { Object3D } from 'three'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart } from '../../core/types'
import { createCustomVisual } from './sdkPart'
import { InstancePoolManager } from '../viewport/instancePool'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// Pool eligibility is decided per link (rig.ts mobileLink / poolableLink), not per rig. A jointed rig's
// hardware that nothing moves (a turntable's legs, feet and base frame) pools; the jointed link and every
// link parented under it (the turntable's deck-mounted motor) stays live, because the pool bakes world
// matrices and a merged copy would sit at the last-baked angle while the deck turns.

const pkg = (behavior = 'definePart({ step(){} })'): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: 'acme.table',
    name: 'Table', conveyor: { bed: 'turntable', surface: 'roller' },
    params: {},
    behavior,
    geometry: {
      kind: 'rig',
      links: [
        { name: 'leg', shape: { kind: 'box', size: [0.1, 0.9, 0.1] }, offset: [0.5, -0.5, 0], color: [0.5, 0.5, 0.5] },
        { name: 'foot', parent: 'leg', shape: { kind: 'box', size: [0.2, 0.02, 0.2] }, offset: [0, -0.45, 0], color: [0.5, 0.5, 0.5] },
        { name: 'deck', shape: { kind: 'cylinder', radius: 0.7, height: 0.05 }, offset: [0, 0, 0], color: [0.3, 0.3, 0.3] },
        { name: 'motor', parent: 'deck', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0.6, 0.05, 0], color: [0.1, 0.1, 0.1] },
      ],
      joints: [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI }],
    },
  }) as PartPackage

const part = (id: string, x = 0): SdkPart => ({ id, type: 'part', packageId: 'acme.table', position: [x, 0, 0], rotationY: 0, params: {} })
const linkMesh = (root: Object3D, name: string): Mesh => {
  let g: Object3D | undefined
  root.traverse((o) => { if (o.userData.linkName === name) g = o })
  const m = g!.children.find((c) => (c as Mesh).isMesh) as Mesh
  return m
}
const mobileAncestor = (o: Object3D): boolean => {
  for (let cur: Object3D | null = o; cur; cur = cur.parent) if (cur.userData.poolMobile === true) return true
  return false
}

beforeEach(() => clearPackages())

describe('rig pool eligibility is per link', () => {
  it('tags the static links of a jointed rig and fences off the moving subtree', () => {
    registerPackage(pkg())
    const v = createCustomVisual(part('a'))
    for (const name of ['leg', 'foot']) {
      const m = linkMesh(v.object, name)
      expect(m.userData.poolUnit, name).toBe(true)
      expect(mobileAncestor(m), name).toBe(false)
    }
    // the jointed link and the static-by-itself link riding it are both under a poolMobile group
    expect(mobileAncestor(linkMesh(v.object, 'deck'))).toBe(true)
    expect(mobileAncestor(linkMesh(v.object, 'motor'))).toBe(true)
    v.dispose()
  })

  it('the pool merges two tables\' legs and feet, and leaves the deck and its motor live', () => {
    registerPackage(pkg())
    const scene = new Scene()
    const parts = new Group()
    scene.add(parts)
    const a = createCustomVisual(part('a'))
    const b = createCustomVisual(part('b', 3))
    for (const v of [a, b]) {
      v.object.userData.partId = v === a ? 'a' : 'b'
      parts.add(v.object)
    }
    scene.updateMatrixWorld(true)
    new InstancePoolManager(scene, [parts]).rebuild(new Set())
    for (const v of [a, b]) {
      expect(linkMesh(v.object, 'leg').userData.poolHidden).toBe(true)
      expect(linkMesh(v.object, 'foot').userData.poolHidden).toBe(true)
      expect(linkMesh(v.object, 'deck').userData.poolHidden).toBeUndefined()
      expect(linkMesh(v.object, 'motor').userData.poolHidden).toBeUndefined()
    }
    a.dispose()
    b.dispose()
  })

  it('a setSubPose name still keeps that link out, as in a jointless rig', () => {
    registerPackage(pkg("definePart({ step(ctx){ ctx.setSubPose('leg', { y: 0.1 }) } })"))
    const v = createCustomVisual(part('a'))
    expect(linkMesh(v.object, 'leg').userData.poolUnit).toBeUndefined()
    expect(mobileAncestor(linkMesh(v.object, 'foot'))).toBe(true)
    v.dispose()
  })
})

// ...and what the pool can't take (decoration riding a moving link) banks under that link instead (linkBank.ts)
const bankPkg = (): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: 'acme.table',
    name: 'Table', conveyor: { bed: 'turntable', surface: 'roller' },
    params: { width: { type: 'number', default: 1 } },
    behavior: 'definePart({ step(){} })',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'deck', shape: { kind: 'cylinder', radius: 0.7, height: 0.05 }, offset: [0, 0, 0], color: [0.3, 0.3, 0.3] },
        { name: 'pivot', parent: 'deck', shape: { kind: 'frame' }, offset: [0.5, 0.1, 0] },
        { name: 'finA', parent: 'pivot', shape: { kind: 'box', size: [0.1, 0.01, 0.01], sizeParams: [{ axis: 0, param: 'width', scale: 0.1 }] }, offset: [0, 0, 0], color: [0.1, 0.2, 0.3], collision: 'none' },
        { name: 'finB', parent: 'pivot', shape: { kind: 'box', size: [0.1, 0.01, 0.01] }, offset: [0, 0.05, 0], rotation: [0.5, 0, 0], color: [0.1, 0.2, 0.3], collision: 'none' },
        { name: 'finC', parent: 'pivot', shape: { kind: 'box', size: [0.1, 0.01, 0.01] }, offset: [0, -0.05, 0], color: [0.1, 0.2, 0.3], collision: 'none' },
        { name: 'cap', parent: 'pivot', shape: { kind: 'box', size: [0.1, 0.01, 0.01] }, offset: [0.2, 0, 0], color: [0.9, 0.9, 0.9], collision: 'none' }, // lone look
        { name: 'solid', parent: 'pivot', shape: { kind: 'box', size: [0.1, 0.01, 0.01] }, offset: [0.3, 0, 0], color: [0.1, 0.2, 0.3] }, // collides
        { name: 'gated', parent: 'pivot', shape: { kind: 'box', size: [0.1, 0.01, 0.01] }, offset: [0.4, 0, 0], color: [0.1, 0.2, 0.3], collision: 'none', showParam: 'x' },
      ],
      joints: [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI }],
    },
  }) as PartPackage

const group = (root: Object3D, name: string): Object3D => {
  let g: Object3D | undefined
  root.traverse((o) => { if (o.userData.linkName === name) g = o })
  return g!
}
const bankOf = (root: Object3D): InstancedMesh => group(root, 'pivot').children.find((c) => (c as InstancedMesh).isInstancedMesh) as InstancedMesh

describe('link banks: decoration riding a moving link', () => {
  it('draws the same-look plain pieces as one instanced mesh under their moving parent', () => {
    registerPackage(bankPkg())
    const v = createCustomVisual(part('a'))
    const bank = bankOf(v.object)
    expect(bank).toBeTruthy()
    expect(bank.count).toBe(3)
    expect(bank.userData.bankLinks).toEqual(['finA', 'finB', 'finC'])
    for (const name of ['finA', 'finB', 'finC']) {
      expect(group(v.object, name).children.some((c) => (c as Mesh).isMesh)).toBe(false) // no own mesh drawn
      expect(group(v.object, name).userData.drawnBy).toBe(bank)
    }
    // a lone look, a collider and a visibility-gated link all keep their own mesh
    for (const name of ['cap', 'solid', 'gated']) expect(group(v.object, name).children.some((c) => (c as Mesh).isMesh), name).toBe(true)
    v.dispose()
  })

  it('each instance sits where the link mesh would, and rides the joint', () => {
    registerPackage(bankPkg())
    const v = createCustomVisual(part('a'))
    const bank = bankOf(v.object)
    const applyJoints = v.object.userData.applyJoints as (j: Record<string, number>) => void
    const check = (): void => {
      v.object.updateMatrixWorld(true)
      const got = new Matrix4()
      const want = new Matrix4()
      bank.userData.bankLinks.forEach((name: string, i: number) => {
        bank.getMatrixAt(i, got)
        got.premultiply(bank.matrixWorld)
        // the reference: the member's group world matrix times its unit mesh's size scale (all three are
        // 0.1 x 0.01 x 0.01 at width 1)
        want.copy(group(v.object, name).matrixWorld).multiply(new Matrix4().makeScale(0.1, 0.01, 0.01))
        for (let k = 0; k < 16; k++) expect(got.elements[k]).toBeCloseTo(want.elements[k]!, 6)
      })
    }
    check()
    applyJoints({ rotate: 1.2 })
    check() // the bank hangs off the pivot, so the deck's turn carries every instance with it
    v.dispose()
  })

  it('a size param re-places its instance on refresh', () => {
    registerPackage(bankPkg())
    const p = part('a')
    const v = createCustomVisual(p)
    const bank = bankOf(v.object)
    const m = new Matrix4()
    const s = new Vector3()
    bank.getMatrixAt(0, m)
    expect(s.setFromMatrixScale(m).x).toBeCloseTo(0.1, 6) // width 1 → 0.1
    v.update({ ...p, params: { width: 3 } })
    bankOf(v.object).getMatrixAt(0, m)
    expect(s.setFromMatrixScale(m).x).toBeCloseTo(0.3, 6)
    v.dispose()
  })
})

// ...and a rig's geometry() dressing (rigProcedural.ts procSlots): static submeshes pool, a lamp and one riding a moving link don't
const dressPkg = (): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: 'acme.dressed',
    name: 'Dressed',
    params: {},
    behavior: `definePart({
      step(){},
      geometry(g) {
        return [
          { desc: g.box([0.2, 0.2, 0.2], [0, 0.5, 0]), finish: 'frame' },
          { desc: g.box([0.1, 0.1, 0.1], [0, 0.8, 0]), lamps: [{ name: 'led', emissive: [1, 1, 1] }] },
          { desc: g.box([0.1, 0.1, 0.1], [0, 0.1, 0]), finish: 'frame', link: 'arm' },
        ]
      },
    })`,
    geometry: {
      kind: 'rig',
      links: [
        { name: 'base', shape: { kind: 'box', size: [0.4, 0.1, 0.4] }, offset: [0, 0, 0], color: [0.5, 0.5, 0.5] },
        { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.5] }, offset: [0, 0.3, 0], color: [0.5, 0.5, 0.5] },
      ],
      joints: [{ name: 'swing', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
    },
  }) as PartPackage

describe('rig geometry() dressing joins the pool', () => {
  it('tags the static dressing, not the lamp; dressing on a moving link sits under its poolMobile group', () => {
    registerPackage(dressPkg())
    const v = createCustomVisual({ id: 'd', type: 'part', packageId: 'acme.dressed', position: [0, 0, 0], rotationY: 0, params: {} })
    const dressing = v.object.children.filter((c) => (c as Mesh).isMesh && typeof c.userData.linkName !== 'string') as Mesh[]
    expect(dressing).toHaveLength(2) // the frame piece + the lamp, both on the root
    const [frame, lamp] = [...dressing].sort((a, b) => Number(!!b.userData.poolUnit) - Number(!!a.userData.poolUnit))
    expect(frame!.userData.poolUnit).toBe(true)
    expect(lamp!.userData.poolUnit).toBeUndefined()
    const onArm = group(v.object, 'arm').children.find((c) => (c as Mesh).isMesh && (c as Mesh).geometry.type === 'BufferGeometry') as Mesh
    expect(onArm).toBeTruthy()
    expect(mobileAncestor(onArm)).toBe(true)
    v.dispose()
  })
})
