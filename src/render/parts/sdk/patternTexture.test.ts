import { describe, expect, it } from 'vitest'
import type { PartPattern } from '../../../core/parts/partPackage'
import { patternColourAt, patternKey, patternPixels } from './patternTexture'

// A pattern is right when its texels are exactly the declared linear colours (no colour-space conversion on the
// way in), each colour covers the share it was given, and one repeat is exactly one tile at every angle, or the
// stripes break at every tile boundary.

const N = 64
const YELLOW: [number, number, number] = [1, 0.6, 0]
const BLACK: [number, number, number] = [0.02, 0.02, 0.02]
const at = (d: Uint8Array, x: number, y: number): number[] => {
  const k = (((y + N) % N) * N + ((x + N) % N)) * 4
  return [d[k]!, d[k + 1]!, d[k + 2]!, d[k + 3]!]
}
const share = (d: Uint8Array, rgb: readonly number[]): number => {
  let n = 0
  for (let i = 0; i < N * N; i++) if (d[i * 4] === Math.round(rgb[0]! * 255) && d[i * 4 + 1] === Math.round(rgb[1]! * 255)) n++
  return n / (N * N)
}

describe('patternPixels', () => {
  it('paints the declared linear colours, opaque, each over its share of the repeat', () => {
    const d = patternPixels({ kind: 'stripes', colors: [YELLOW, BLACK], ratio: 0.25 }, N)
    expect(at(d, 3, 2)).toEqual([255, 153, 0, 255]) // the first quarter of the repeat is colour 0
    expect(at(d, 3, 40)).toEqual([5, 5, 5, 255])
    expect(share(d, YELLOW)).toBeCloseTo(0.25, 2)
    expect(share(d, BLACK)).toBeCloseTo(0.75, 2)
  })

  it('runs the bands the way the angle says', () => {
    const bands = (angle: PartPattern['angle']): Uint8Array => patternPixels({ kind: 'stripes', colors: [YELLOW, BLACK], angle }, N)
    // 0: bands run along U, so a row is one colour; 90: along V, so a column is
    const along = (d: Uint8Array, dx: number, dy: number): boolean => {
      for (let i = 0; i < 40; i++) if (at(d, 10 + i * dx, 10 + i * dy)[0] !== at(d, 10, 10)[0]) return false
      return true
    }
    expect(along(bands(0), 1, 0)).toBe(true)
    expect(along(bands(0), 0, 1)).toBe(false)
    expect(along(bands(90), 0, 1)).toBe(true)
    expect(along(bands(45), 1, 1)).toBe(true)
    expect(along(bands(45), 1, 0)).toBe(false)
    expect(along(bands(135), -1, 1)).toBe(true)
  })

  it('tiles seamlessly at every angle, and as a checker: one repeat is exactly one tile', () => {
    const specs: PartPattern[] = [
      ...([0, 45, 90, 135] as const).map((angle) => ({ kind: 'stripes' as const, colors: [YELLOW, BLACK] as [typeof YELLOW, typeof BLACK], angle, ratio: 0.4 })),
      { kind: 'checker', colors: [YELLOW, BLACK] },
    ]
    for (const p of specs) {
      // the pattern a whole tile over is the same pattern, so the texture's wrap continues it without a break
      for (let i = 0; i < 97; i++) {
        const s = (i * 0.37) % 1, t = (i * 0.61) % 1
        const c = patternColourAt(p, s, t)
        expect(patternColourAt(p, s + 1, t), `${patternKey(p)} at ${s},${t}`).toBe(c)
        expect(patternColourAt(p, s, t + 1), `${patternKey(p)} at ${s},${t}`).toBe(c)
        expect(patternColourAt(p, s - 1, t - 1), `${patternKey(p)} at ${s},${t}`).toBe(c)
      }
    }
  })

  it('smooths a diagonal edge instead of stair-stepping it', () => {
    const d = patternPixels({ kind: 'stripes', colors: [[1, 1, 1], [0, 0, 0]], angle: 45 }, N)
    const values = new Set<number>()
    for (let i = 0; i < N * N; i++) values.add(d[i * 4]!)
    expect(values.size).toBeGreaterThan(2) // texels straddling an edge take a blend
  })

  it('keys the same spec to one texture and a different one apart', () => {
    const a: PartPattern = { kind: 'stripes', colors: [YELLOW, BLACK], angle: 45 }
    expect(patternKey(a)).toBe(patternKey({ ...a, ratio: 0.5 }))
    expect(patternKey(a)).not.toBe(patternKey({ ...a, angle: 135 }))
    expect(patternKey(a)).not.toBe(patternKey({ ...a, colors: [BLACK, YELLOW] }))
  })
})
