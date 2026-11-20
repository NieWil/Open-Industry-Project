import { describe, it, expect } from 'vitest'
import { BoxGeometry, Group, MeshBasicMaterial } from 'three'
import type { InstanceTransform } from '../../core/parts/partApi'
import { growBank, InstanceBank, makeBankMesh } from './instanceBank'
import { bucketCapacity } from './instanceCapacity'

// Capacities are expressed through bucketCapacity, never as literals: the ladder's floor is a tuning
// knob (high enough that structurally identical banks declare the same WGSL instance
// array and share a compiled shader), and a literal here would fail the suite every time it moves.
// ABOVE is past the floor so the grow/mint tests still exercise a real reallocation.
const ABOVE = bucketCapacity(0) + 1

const t = (x: number): InstanceTransform => ({ position: [x, 0, 0] })

describe('makeBankMesh', () => {
  it('sizes the buffer to a bucket, starts at live count 0', () => {
    const mesh = makeBankMesh(new BoxGeometry(), new MeshBasicMaterial(), 5)
    expect(mesh.instanceMatrix.count).toBe(bucketCapacity(5)) // bucketed, not exact-fit
    expect(mesh.count).toBe(0)
    expect(mesh.castShadow).toBe(true)
    // and the ladder still rounds up past the floor, rather than the floor swallowing everything
    const big = makeBankMesh(new BoxGeometry(), new MeshBasicMaterial(), ABOVE)
    expect(big.instanceMatrix.count).toBeGreaterThanOrEqual(ABOVE)
    expect(Number.isInteger(Math.log2(big.instanceMatrix.count))).toBe(true)
  })
})

describe('growBank - the one grow/mint/carry-state mechanism', () => {
  const setup = () => {
    const parent = new Group()
    const bank = new InstanceBank(parent, new BoxGeometry(), new MeshBasicMaterial(), 4)
    return { parent, bank }
  }

  it('is a no-op while the buffer still holds `needed` (mesh identity stable → warm pipeline)', () => {
    const { bank } = setup()
    const first = bank.mesh
    growBank(bank, 8) // bucketed cap is 8, so 8 fits
    expect(bank.mesh).toBe(first)
  })

  it('mints a fresh mesh past capacity and swaps it under the parent', () => {
    const { parent, bank } = setup()
    const first = bank.mesh
    growBank(bank, ABOVE)
    expect(bank.mesh).not.toBe(first)
    expect(bank.mesh.instanceMatrix.count).toBeGreaterThanOrEqual(ABOVE)
    expect(parent.children).toContain(bank.mesh)
    expect(parent.children).not.toContain(first)
  })

  it('grows with doubling headroom so a continuous climb crosses few bucket boundaries', () => {
    const { bank } = setup() // at the capacity floor
    const cap0 = bank.mesh.instanceMatrix.count
    growBank(bank, cap0 + 1) // needs cap0+1; policy takes max(needed, cap0*2) -> one bucket up, not a tight fit
    expect(bank.mesh.instanceMatrix.count).toBe(bucketCapacity(cap0 * 2))
    expect(bank.mesh.instanceMatrix.count).toBeGreaterThanOrEqual(cap0 * 2)
  })

  it('carries layer mask and shadow flag across the mint', () => {
    const { bank } = setup()
    bank.mesh.layers.set(5) // e.g. OVERLAY_LAYER
    bank.mesh.castShadow = false
    const mask = bank.mesh.layers.mask
    growBank(bank, 20)
    expect(bank.mesh.layers.mask).toBe(mask)
    expect(bank.mesh.castShadow).toBe(false)
  })
})

describe('InstanceBank', () => {
  it('write() sets the live count and reuses the buffer within a bucket', () => {
    const parent = new Group()
    const bank = new InstanceBank(parent, new BoxGeometry(), new MeshBasicMaterial(), 8)
    const mesh0 = bank.mesh
    bank.write([t(0), t(1), t(2), t(3), t(4)])
    expect(bank.mesh).toBe(mesh0) // 5 <= cap 8 → no mint
    expect(bank.mesh.count).toBe(5) // exact draw count
    bank.write([t(0), t(1), t(2), t(3), t(4), t(5), t(6), t(7)]) // grow to 8, still within the bucket
    expect(bank.mesh).toBe(mesh0)
    expect(bank.mesh.count).toBe(8)
  })

  it('setMaterial swaps the draw material without touching the buffer', () => {
    const bank = new InstanceBank(new Group(), new BoxGeometry(), new MeshBasicMaterial(), 8)
    const mesh = bank.mesh
    const mat = new MeshBasicMaterial()
    bank.setMaterial(mat)
    expect(bank.mesh).toBe(mesh)
    expect(bank.mesh.material).toBe(mat)
  })

  it('dispose removes the mesh from its parent', () => {
    const parent = new Group()
    const bank = new InstanceBank(parent, new BoxGeometry(), new MeshBasicMaterial(), 8)
    expect(parent.children).toContain(bank.mesh)
    bank.dispose()
    expect(parent.children).not.toContain(bank.mesh)
  })
})
