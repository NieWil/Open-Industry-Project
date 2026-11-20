import { describe, expect, it } from 'vitest'
import { parseDocument } from '../../plc'
import { blockAt, blockOffset, blockStarts } from './stReveal'

const SRC = `FUNCTION_BLOCK Latch
VAR_INPUT S : BOOL; END_VAR
END_FUNCTION_BLOCK

FUNCTION_BLOCK Other
VAR_OUTPUT Q : BOOL; END_VAR
END_FUNCTION_BLOCK

VAR_INPUT Start : BOOL; END_VAR
Start := Start;`

describe('blockStarts', () => {
  const blocks = parseDocument(SRC).blocks

  it('finds every block where its text begins', () => {
    expect(blockStarts(SRC, blocks)).toEqual([0, SRC.indexOf('FUNCTION_BLOCK Other'), SRC.indexOf('VAR_INPUT Start')])
  })

  it('agrees with blockOffset, which the reveals use', () => {
    const starts = blockStarts(SRC, blocks)
    expect(blocks.map((_, i) => blockOffset(SRC, blocks, i))).toEqual(starts)
  })

  it('tells two identical blocks apart by searching on from the one before', () => {
    const twice = `${SRC.slice(0, SRC.indexOf('\n\n'))}\n\n${SRC}`
    const b = parseDocument(twice).blocks
    const starts = blockStarts(twice, b)
    expect(b[0]!.text).toBe(b[1]!.text)
    expect(starts[1]).toBeGreaterThan(starts[0]!)
  })

  it('holds the last good position once the text has moved under stale blocks', () => {
    // Other's stale text is no longer in the source: it and every block after it sit where Latch ended
    const edited = SRC.replace('Q : BOOL', 'Q : INT')
    const latchEnd = blocks[0]!.text.length
    expect(blockStarts(edited, blocks)).toEqual([0, latchEnd, latchEnd])
  })
})

describe('blockAt', () => {
  const starts = blockStarts(SRC, parseDocument(SRC).blocks)

  it('is the block holding the offset', () => {
    expect(blockAt(starts, 0)).toBe(0)
    expect(blockAt(starts, SRC.indexOf('Q : BOOL'))).toBe(1)
    expect(blockAt(starts, SRC.indexOf('Start := Start'))).toBe(2)
    expect(blockAt(starts, SRC.length)).toBe(2)
  })

  it('gives the blank lines after a block END to that block', () => {
    expect(blockAt(starts, SRC.indexOf('\n\nFUNCTION_BLOCK Other') + 1)).toBe(0)
  })

  it('counts a position ahead of the first block as the first, and nothing as none', () => {
    expect(blockAt([5, 20], 0)).toBe(0)
    expect(blockAt([], 0)).toBe(-1)
  })
})
