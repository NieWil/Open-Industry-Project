import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping } from 'three'
import type { PartPattern } from '../../../core/parts/partPackage'

// A package material's pattern (PartMaterial.pattern): a two-colour texture the host paints from the spec, so a
// part gets hazard stripes or a checker with no image file. One texture is one repeat of the pattern, tiling
// seamlessly, which is what both the mesh-UV path and the triplanar path sample.
//
// The texels hold linear colour bytes and the texture keeps three's default (no) colour space, so the value
// sampled is the colour declared, on both paths: the triplanar shader multiplies its raw texels in, and a
// MeshStandardMaterial map in no colour space is read as linear too.

/** texels per repeat: crisp at a hand's length on a 25 cm stripe pair, 256 KB a pattern */
const SIZE = 256
/** subsamples per texel side, so a diagonal edge is smoothed instead of stair-stepped */
const SUPER = 4

/** which colour (0 or 1) the pattern has at tile coordinates (s, t), each 0..1 across one repeat */
export function patternColourAt(p: PartPattern, s: number, t: number): 0 | 1 {
  if (p.kind === 'checker') return ((Math.floor(s * 2) + Math.floor(t * 2)) & 1) as 0 | 1
  const angle = p.angle ?? 0
  // the phase grows across the bands; at 45 and 135 two bands cross the tile, so the tile still repeats seamlessly
  const raw = angle === 0 ? t : angle === 90 ? s : angle === 45 ? s - t : s + t
  const phase = raw - Math.floor(raw)
  return phase < (p.ratio ?? 0.5) ? 0 : 1
}

/** one repeat of the pattern as SIZE x SIZE RGBA bytes, linear colour */
export function patternPixels(p: PartPattern, size = SIZE): Uint8Array {
  const data = new Uint8Array(size * size * 4)
  const n = SUPER * SUPER
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ones = 0
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) ones += patternColourAt(p, (x + (sx + 0.5) / SUPER) / size, (y + (sy + 0.5) / SUPER) / size)
      }
      const w = ones / n
      const k = (y * size + x) * 4
      for (let ch = 0; ch < 3; ch++) {
        const v = p.colors[0][ch]! * (1 - w) + p.colors[1][ch]! * w
        data[k + ch] = Math.round(Math.min(1, Math.max(0, v)) * 255)
      }
      data[k + 3] = 255
    }
  }
  return data
}

/** a stable key for a pattern: the same spec in two parts is one texture */
export function patternKey(p: PartPattern): string {
  const c = (v: readonly number[]): string => v.join(',')
  return `${p.kind}|${c(p.colors[0])}|${c(p.colors[1])}|${p.ratio ?? 0.5}|${p.angle ?? 0}`
}

// module-lived, like materials.ts's texCache: a pattern texture is shared by every material naming the same spec,
// never disposed (a few hundred KB each, and a part's material can be rebuilt at any param edit)
const cache = new Map<string, DataTexture>()

/** the shared texture for a pattern spec */
export function patternTexture(p: PartPattern): DataTexture {
  const key = patternKey(p)
  let tex = cache.get(key)
  if (!tex) {
    tex = new DataTexture(patternPixels(p), SIZE, SIZE, RGBAFormat)
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    tex.magFilter = LinearFilter
    tex.minFilter = LinearMipmapLinearFilter
    tex.generateMipmaps = true
    tex.anisotropy = 4
    tex.needsUpdate = true
    cache.set(key, tex)
  }
  return tex
}
