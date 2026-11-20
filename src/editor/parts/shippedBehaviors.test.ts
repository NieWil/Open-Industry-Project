import { describe, expect, it } from 'vitest'
import { bundledBehaviors } from './bundledExamples'
import { loadShippedBehaviors } from './shippedBehaviors'

describe('shipped first-party behaviors', () => {
  it('lists every behavior this build ships (run `node scripts/shipped-behaviors.mjs` after changing a part)', async () => {
    const wasShipped = await loadShippedBehaviors()
    const missing = [...bundledBehaviors()].filter(([, src]) => !wasShipped(src)).map(([id]) => id)
    expect(missing).toEqual([])
  })

  it('does not recognise code that differs by a single character', async () => {
    const wasShipped = await loadShippedBehaviors()
    const [, src] = [...bundledBehaviors()][0]!
    expect(wasShipped(src)).toBe(true)
    expect(wasShipped(src + ' ')).toBe(false)
    expect(wasShipped(src.replace('definePart', 'definePart '))).toBe(false)
  })
})
