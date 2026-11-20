import { beforeEach, describe, expect, it } from 'vitest'
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { InstancedBufferAttribute, InstancedMesh, Mesh, Object3D } from 'three'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart } from '../../core/types'
import { createCustomVisual } from './sdkPart'
import { examplePart, type RigGeo } from './examplePart'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// A rig's primitive lamp links that share a unit geometry + parent draw as one InstancedMesh (lampBank.ts),
// with paintLamp's two states carried per instance: albedo in instanceColor, glow + opacity in `lampGlow`.
// The stack light is the main case: without the bank its 8 lens tiers are 8 materials and 8 draws.

const { behavior, geometry } = examplePart<RigGeo>('oip.stack-light')
const stackLight = (): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: 'oip.stack-light',
    name: 'Stack Light',
    params: { segments: { type: 'number', default: 3, min: 1, max: 8, step: 1 } },
    behavior,
    geometry,
  }) as PartPackage
const part = (segments?: number): SdkPart => ({ id: 's', type: 'part', packageId: 'oip.stack-light', position: [0, 0, 0], rotationY: 0, params: segments === undefined ? {} : { segments } })
const TIERS = ['seg1', 'seg2', 'seg3', 'seg4', 'seg5', 'seg6', 'seg7', 'seg8']

const drawables = (root: Object3D): Mesh[] => {
  const out: Mesh[] = []
  root.traverseVisible((o) => { if ((o as Mesh).isMesh) out.push(o as Mesh) })
  return out
}
const bankOf = (root: Object3D): InstancedMesh => {
  const banks = drawables(root).filter((m) => m.userData.lampBank === true)
  expect(banks).toHaveLength(1)
  return banks[0] as unknown as InstancedMesh
}
const glowOf = (bank: InstancedMesh, i: number): number[] => {
  const a = bank.geometry.getAttribute('lampGlow') as InstancedBufferAttribute
  return [a.getX(i), a.getY(i), a.getZ(i), a.getW(i)]
}
const applyLampsOf = (root: Object3D) => root.userData.applyLamps as (l: Record<string, boolean>) => void
const tierY = (bank: InstancedMesh, i: number): { y: number; h: number } => {
  const m = new Matrix4()
  bank.getMatrixAt(i, m)
  const p = new Vector3(), s = new Vector3()
  m.decompose(p, new Quaternion(), s)
  return { y: p.y, h: s.y }
}

beforeEach(() => clearPackages())

describe('lamp bank: a stack light draws its tiers as one instanced mesh', () => {
  it('folds all 8 tier links into one bank, in link order, and leaves no per-tier mesh drawn', () => {
    registerPackage(stackLight())
    const v = createCustomVisual(part())
    const bank = bankOf(v.object)
    expect(bank.count).toBe(8)
    // no tier link draws a mesh of its own any more
    v.object.traverse((o) => {
      if (TIERS.includes(o.userData.linkName as string)) expect(o.children.filter((c) => (c as Mesh).isMesh)).toEqual([])
    })
    v.dispose()
  })

  it('paints per instance exactly what paintLamp painted per material: lit = hue + glow + lens opacity, off = unlit tint', () => {
    registerPackage(stackLight())
    const v = createCustomVisual(part())
    const bank = bankOf(v.object)
    const link = (n: string) => geometry.links.find((l) => l.name === n)!
    // at rest every tier is dark: its authored unlit colour, no glow, opaque
    const off = link('seg2').lamps![0]!.offColor!
    expect(bank.instanceColor!.getX(1)).toBeCloseTo(off[0], 5)
    expect(glowOf(bank, 1)).toEqual([0, 0, 0, 1])
    applyLampsOf(v.object)({ seg2: true })
    const hue = link('seg2').lamps![0]!.emissive
    for (let k = 0; k < 3; k++) {
      expect([bank.instanceColor!.getX(1), bank.instanceColor!.getY(1), bank.instanceColor!.getZ(1)][k]).toBeCloseTo(hue[k]!, 5)
      expect(glowOf(bank, 1)[k]).toBeCloseTo(hue[k]!, 5)
    }
    expect(glowOf(bank, 1)[3]).toBeCloseTo(link('seg2').lamps![0]!.opacity!, 5)
    // its neighbours stayed dark
    expect(glowOf(bank, 0)).toEqual([0, 0, 0, 1])
    expect(glowOf(bank, 2)).toEqual([0, 0, 0, 1])
    applyLampsOf(v.object)({ seg2: false })
    expect(glowOf(bank, 1)).toEqual([0, 0, 0, 1])
    v.dispose()
  })

  it('re-places the instances when the segment count changes (param offsets + sizes reach the bank)', () => {
    registerPackage(stackLight())
    const v = createCustomVisual(part(3))
    const LENS_BOTTOM = 0.196 + 0.025, SEG = 0.05
    let bank = bankOf(v.object)
    expect(tierY(bank, 2).h).toBeCloseTo(SEG, 6) // tier 3 used
    expect(tierY(bank, 2).y).toBeCloseTo(LENS_BOTTOM + 2.5 * SEG, 6)
    expect(tierY(bank, 4).h).toBeLessThan(0.001) // tier 5 parked as a sliver
    v.update(part(5))
    bank = bankOf(v.object)
    expect(tierY(bank, 4).h).toBeCloseTo(SEG, 6)
    expect(tierY(bank, 4).y).toBeCloseTo(LENS_BOTTOM + 4.5 * SEG, 6)
    v.dispose()
  })

  it('a lone lamp link keeps its own mesh (a bank of one saves no draw)', () => {
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'acme.led',
      name: 'LED',
      params: {},
      behavior: 'definePart({ lamps: [\'led\'], step(){} })',
      geometry: { kind: 'rig', joints: [], links: [{ name: 'led', shape: { kind: 'box', size: [0.01, 0.01, 0.01] }, offset: [0, 0, 0], lamps: [{ emissive: [1, 0, 0] }] }] },
    } as PartPackage)
    const v = createCustomVisual({ ...part(), packageId: 'acme.led' })
    expect(drawables(v.object).some((m) => m.userData.lampBank === true)).toBe(false)
    expect(drawables(v.object)).toHaveLength(1)
    v.dispose()
  })
})
