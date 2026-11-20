import { describe, expect, it } from 'vitest'
import { isUsdFile, materialName, usdRootCandidates } from './usdImport'

describe('usdImport', () => {
  it('knows the USD file kinds', () => {
    for (const name of ['a.usd', 'a.USDA', 'b.usdc', 'c.usdz']) expect(isUsdFile(name)).toBe(true)
    for (const name of ['a.glb', 'a.step', 'usd', 'a.usd.txt']) expect(isUsdFile(name)).toBe(false)
  })

  it("picks a folder's root layer from the USD files nearest the top", () => {
    // a SimReady folder: the root beside the folders of the layers it pulls in, and images that are not layers
    const simready = [
      'box/simready_usd/sm_box_01.usd',
      'box/simready_usd/payloads/base.usda',
      'box/simready_usd/payloads/geometries.usd',
      'box/simready_usd/payloads/PhysX/enabled.usda',
      'box/simready_usd/Textures/albedo.png',
      'box/simready_usd/.thumbs/256x256/sm_box_01.usd.png',
    ]
    expect(usdRootCandidates(simready)).toEqual(['box/simready_usd/sm_box_01.usd'])
  })

  it('offers every file at that depth, sorted, when there are several', () => {
    expect(usdRootCandidates(['m/variant_b.usda', 'm/variant_a.usda', 'm/layers/x.usda'])).toEqual(['m/variant_a.usda', 'm/variant_b.usda'])
    expect(usdRootCandidates(['m\\a.usdz'])).toEqual(['m/a.usdz'])
  })

  it("names a material by its path's last segment, without an opacity class in front", () => {
    expect(materialName('/RootNode/Geometry/obj/VisualMaterials/opaque__paper__decals_black_a')).toBe('paper_decals_black_a')
    expect(materialName('/Looks/translucent__glass__clear')).toBe('glass_clear')
    expect(materialName('/Looks/Steel')).toBe('Steel')
    expect(materialName('/Looks/opaque__')).toBe('opaque__')
    expect(materialName('')).toBe('material')
  })

  it('finds nothing in a folder without USD', () => {
    expect(usdRootCandidates(['m/readme.txt', 'm/a.png'])).toEqual([])
  })
})
