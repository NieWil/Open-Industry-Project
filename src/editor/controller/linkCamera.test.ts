import { describe, expect, it } from 'vitest'
import { formatLinkCamera, parseLinkCamera } from './linkCamera'

describe('a link camera', () => {
  it('round-trips to the centimetre', () => {
    const pose = { px: 12.3456, py: 7, pz: -8.5, tx: -0.001, ty: 0.6, tz: 100 }
    const raw = formatLinkCamera(pose, false)
    expect(raw).toBe('12.35_7_-8.5_0_0.6_100')
    expect(parseLinkCamera(raw)).toEqual({ px: 12.35, py: 7, pz: -8.5, tx: 0, ty: 0.6, tz: 100, ortho: false })
  })

  it('carries an orthographic view', () => {
    const raw = formatLinkCamera({ px: 0, py: 20, pz: 0.01, tx: 0, ty: 0, tz: 0 }, true)
    expect(raw.endsWith('_o')).toBe(true)
    expect(parseLinkCamera(raw)?.ortho).toBe(true)
  })

  it('stays unescaped in a query', () => {
    const url = new URL('https://example.test/app/')
    const raw = formatLinkCamera({ px: -1.5, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 }, true)
    url.searchParams.set('cam', raw)
    expect(url.search).toBe('?cam=' + raw)
  })

  it('refuses anything else', () => {
    for (const raw of [null, '', '1_2_3', '1_2_3_4_5_6_7', '1_2_3_4_5_6_x', '1_2_3_4_5_NaN', '1e9_2_3_4_5_6', '1_2_3_4_5_Infinity', '1_2_3_4_5_ 6', '1_2_3_4_5_0x10', '999999_0_0_0_0_0'])
      expect(parseLinkCamera(raw)).toBeNull()
  })

  it('refuses a camera with nowhere to look', () => {
    expect(parseLinkCamera('1_2_3_1_2_3')).toBeNull()
  })
})
