// Where the reader is in the PLC panel: which face shows, which POU, and in the text the cursor's line and the word
// under it. The panel owns all of that (StEditor.tsx), and is mounted only while it shows, so a reader outside it (the
// agent's get_context) asks through this one slot. The panel fills the slot while mounted. An empty slot means the
// panel is closed.

export interface PlcReading {
  face: 'text' | 'ladder'
  /** the POU the reader is in: its name, or for a block without one its kind ('type', 'global', 'body') */
  pou: string | null
  /** the text cursor's line, 1-based (null on the ladder face, which has no cursor) */
  line: number | null
  /** the identifier under the cursor */
  word: string | null
}

let provider: (() => PlcReading) | null = null

/** The panel's half: fill the slot while mounted. Returns the release. */
export function providePlcReading(read: () => PlcReading): () => void {
  provider = read
  return () => {
    if (provider === read) provider = null
  }
}

/** The PLC panel's reading position, or null while it is closed. */
export function readPlcReading(): PlcReading | null {
  return provider?.() ?? null
}
