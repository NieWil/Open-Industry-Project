import { describe, expect, it } from 'vitest'
import type { PartAsset, PartPackageGeometry } from '../../core/parts/partPackage'

// Guards a prod-only bug. A custom-part rig whose links reference GLB nodes (shape.kind:'mesh' with a
// `node`) is rendered by sdkPart.prepareMeshInstance, which resets each such node's transform to identity
// so the rig link owns placement. The prod asset optimizer (scripts/optimize-assets.mjs) must therefore treat
// that GLB as TEXTURE_ONLY. Its default meshopt/quantize pass bakes a compensating scale+translation onto
// every node, which the reset then drops, mis-placing the links in prod only (dev serves public/ raw, so it
// looks fine). EOATSuction and the Diverter both hit this (the Diverter's telescoping arms rendered stuck
// extended because ~0.3–0.8 m of baked per-node offset was discarded). This checks every node-ref rig,
// including future ones. See scripts/optimize-assets.mjs.

interface Manifest { id: string; geometry: PartPackageGeometry; assets?: PartAsset[] }
const RIGS = import.meta.glob('../../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<string, Manifest>
const OPT_SRC = Object.values(
  import.meta.glob('../../../scripts/optimize-assets.mjs', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>,
)[0] as string | undefined

// the GLB basenames the optimizer treats as textures-only (parsed from its single-line Set literal)
function textureOnlySet(src: string): Set<string> {
  const m = src.match(/TEXTURE_ONLY\s*=\s*new Set\(\[([^\]]*)\]\)/)
  if (!m) throw new Error('could not locate the TEXTURE_ONLY set in optimize-assets.mjs')
  return new Set([...m[1]!.matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]!))
}

// GLB basenames (e.g. '/models/Diverter.glb' -> 'Diverter') referenced by node-ref mesh links in `geo`
function nodeRefGlbs(geo: PartPackageGeometry, assets: PartAsset[]): string[] {
  if (geo.kind !== 'rig') return []
  const out = new Set<string>()
  for (const link of geo.links) {
    const s = link.shape
    if (s.kind === 'mesh' && s.node) {
      const url = assets.find((a) => a.id === s.asset)?.url
      if (url) out.add(url.split('/').pop()!.replace(/\.glb$/i, ''))
    }
  }
  return [...out]
}

describe('prod asset optimizer - node-ref rig GLBs must be TEXTURE_ONLY', () => {
  const textureOnly = OPT_SRC ? textureOnlySet(OPT_SRC) : new Set<string>()
  const cases: { id: string; glb: string }[] = []
  for (const m of Object.values(RIGS)) for (const glb of nodeRefGlbs(m.geometry, m.assets ?? [])) cases.push({ id: m.id, glb })

  it('reads the optimizer source and finds node-ref rigs to check', () => {
    expect(OPT_SRC).toBeTruthy()
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('$glb.glb (used by $id) is in optimize-assets TEXTURE_ONLY', ({ glb }) => {
    // if this fails: meshopt-quantizing this GLB bakes per-node transforms that sdkPart discards, so the
    // part's links render mis-placed in prod. Add the basename to TEXTURE_ONLY in scripts/optimize-assets.mjs.
    expect(textureOnly.has(glb)).toBe(true)
  })
})
