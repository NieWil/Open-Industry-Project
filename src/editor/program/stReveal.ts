// Where a block of the program starts. The PLC panel's strip scrolls with these offsets.

import type { StBlock } from '../../plc'

/**
 * Where block `i` starts in `src`.
 *
 * Offsets are found by walking the blocks in order rather than stored on them: a block's text
 * is a verbatim slice of the source, and searching forward from the previous block's end means
 * two identical blocks cannot both resolve to the first one. Not part of the
 * document model - where to scroll is the panels' business, and putting positions in StBlock
 * would make two parses of the same program unequal.
 */
export function blockOffset(src: string, blocks: StBlock[], i: number): number {
  return blockStarts(src, blocks)[i] ?? 0
}

/** Where every block starts in `src`, in block order (see {@link blockOffset}). */
export function blockStarts(src: string, blocks: StBlock[]): number[] {
  const starts: number[] = []
  let at = 0
  let lost = false
  for (const b of blocks) {
    const found = lost ? -1 : src.indexOf(b.text, at)
    // the text moved under us: the last good position is still sensible, for this block and every one after it
    if (found < 0) lost = true
    else at = found
    starts.push(at)
    if (!lost) at += b.text.length
  }
  return starts
}

/**
 * The block `offset` falls in: the last one starting at or before it, so the blank lines after a block's end belong to
 * that block. A position ahead of the first block (a leading comment) counts as the first; -1 only when there are none.
 */
export function blockAt(starts: number[], offset: number): number {
  if (starts.length === 0) return -1
  let i = 0
  while (i + 1 < starts.length && starts[i + 1]! <= offset) i++
  return i
}
