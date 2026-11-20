import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MeshStandardMaterial } from 'three'
import { acquireBeltBankMaterial, beltBankMaterialCount, releaseBeltBankMaterial } from './beltFabricBank'

// A bank material is shared while any bank holds it and freed by the last release, so a colour drag that commits
// on every slider move leaves only the colours still in use.

describe('belt bank materials', () => {
  // the weave texture loads an image; node has none
  beforeAll(() => { vi.stubGlobal('Image', class { src = ''; addEventListener(): void {} }) })
  afterAll(() => { vi.unstubAllGlobals() })

  it('shares one material per (variant, colour) and disposes it at the last release', () => {
    const base = beltBankMaterialCount()
    const a = acquireBeltBankMaterial('standard', '#123456')
    const b = acquireBeltBankMaterial('standard', '#123456')
    expect(b).toBe(a)
    expect(beltBankMaterialCount()).toBe(base + 1)
    let disposed = 0
    a.addEventListener('dispose', () => { disposed++ })
    releaseBeltBankMaterial(a)
    expect(disposed).toBe(0)
    releaseBeltBankMaterial(b)
    expect(disposed).toBe(1)
    expect(beltBankMaterialCount()).toBe(base)
    releaseBeltBankMaterial(a) // already gone: ignored
    expect(disposed).toBe(1)
    const c = acquireBeltBankMaterial('standard', '#123456')
    expect(c).not.toBe(a) // a fresh one after the free
    releaseBeltBankMaterial(c)
  })

  it('ignores a material it did not make', () => {
    const base = beltBankMaterialCount()
    releaseBeltBankMaterial(new MeshStandardMaterial())
    releaseBeltBankMaterial(undefined)
    expect(beltBankMaterialCount()).toBe(base)
  })
})
