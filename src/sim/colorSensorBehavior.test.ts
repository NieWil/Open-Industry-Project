/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest'
import { create, destroy, stepDirect } from './embeddedBehavior'

// The committed colour sensor behavior (examples/parts/color-sensor), driven directly through the embeddable runtime
// with a beam hit of a given tint. The code is the position of the matched colour in the `colors` param.
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const SOURCE = BEHAVIORS['../../examples/parts/color-sensor/behavior.ts']!.replace(/\r\n/g, '\n')

const DT = 1 / 60

describe('colour sensor behavior - the colour code', () => {
  let h = 0
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })

  const read = (params: Record<string, unknown>, color: [number, number, number] | null, distance = 0.5): unknown => {
    if (h > 0) destroy(h)
    h = create(SOURCE, JSON.stringify({ colorTag: 'Code', ...params }))
    const beams = { lens: color ? { hit: true, distance, color } : { hit: false, distance: 10, color: [1, 1, 1] as [number, number, number] } }
    return stepDirect(h, { simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: {}, beams }, DT)!.tags['Code']
  }

  it('tells red, green and blue apart by default, and calls white, grey, yellow and the pilot none', () => {
    expect(read({}, [1, 0, 0])).toBe(1)
    expect(read({}, [0, 1, 0])).toBe(2)
    expect(read({}, [0, 0, 1])).toBe(3)
    expect(read({}, [0.88, 0.13, 0.13])).toBe(1) // an off-pure authored red
    for (const c of [[1, 1, 1], [0.5, 0.5, 0.5], [1, 1, 0], [0.35, 0.35, 0.35]] as [number, number, number][]) expect(read({}, c)).toBe(0)
  })

  it('reads 0 with nothing in range, or with the hit past maxRange', () => {
    expect(read({}, null)).toBe(0)
    expect(read({ maxRange: 1 }, [1, 0, 0], 1.5)).toBe(0)
  })

  it('codes any list of colours by position, so yellow can be a code of its own', () => {
    const colors = '#ffff00,#ff8000,#ffffff,#000080'
    expect(read({ colors }, [1, 1, 0])).toBe(1)
    expect(read({ colors }, [1, 0.5, 0])).toBe(2)
    expect(read({ colors }, [1, 1, 1])).toBe(3)
    expect(read({ colors }, [0, 0, 0.5])).toBe(4)
    expect(read({ colors }, [0, 1, 0])).toBe(0) // green is not listed
  })

  it('matches the nearer of two listed colours, and only the exact one at tolerance 0', () => {
    expect(read({ colors: '#ff0000,#ff8000' }, [1, 0.4, 0])).toBe(2) // 102: 26 steps from orange, 102 from red
    expect(read({ colors: '#ff0000', tolerance: 0 }, [1, 0, 0])).toBe(1)
    expect(read({ colors: '#ff0000', tolerance: 0 }, [0.99, 0, 0])).toBe(0)
  })

  it('reads 0 for every tint when the list is empty', () => {
    expect(read({ colors: '' }, [1, 0, 0])).toBe(0)
  })
})
