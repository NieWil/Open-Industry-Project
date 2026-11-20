// IEC 61131-3 direct addresses (`%IX100.0`, `%QW3`): the notation a PLC uses for a physical I/O point.
//
// Shared by both sides of the tag model, which is why it lives in core:
//   - the ST engine (plc/) reads them in located declarations: `Eye AT %IX100.0 : BOOL;`
//   - the scene reads them in a part's tag field: a photo eye wired to input %IX100.0
// Both must agree on what counts as the same point, so both go through canonicalAddress: `%i100.0`,
// `%IX100.0` and `%IX0100.0` are one input.
//
// Shape (IEC 61131-3 2nd ed. 2.4.1.1, as the targets this project exports to spell it):
//   %  area  [size]  fields
//      I input, Q output, M memory
//      X bit (the default when no size is written), B byte, W word, D double word, L long word
//   A bit is `byte.bit` with the bit 0-7. A byte, word or double word is one number. The standard also
//   allows deeper hierarchies (`%IX1.2.3`); this engine's rule is the two-level bit form (the one OpenPLC and
//   MATIEC use), and the others are refused by name.

export type IoArea = 'I' | 'Q' | 'M'
export type IoSize = 'X' | 'B' | 'W' | 'D' | 'L'

export interface DirectAddress {
  area: IoArea
  size: IoSize
  /** byte and bit for X; the one index for B, W, D and L */
  fields: number[]
  /** the canonical spelling: upper case, size written out, no leading zeros */
  text: string
}

const SHAPE = /^%([IQM])([XBWDL])?(\d+(?:\.\d+)*)$/i

/** Does the string use the direct-address notation at all? (Well-formed or not.) */
export function looksLikeAddress(s: string): boolean {
  return s.trimStart().startsWith('%')
}

/**
 * Read a direct address, or say what is wrong with it. `raw` may be in any case, may omit the X of a
 * bit address and may carry leading zeros; the result's `text` is the one spelling every consumer
 * compares.
 */
export function parseDirectAddress(raw: string): DirectAddress | { error: string } {
  const s = raw.trim()
  if (/^%[IQM][XBWDL]?\*$/i.test(s)) {
    return { error: `${s} is an incomplete address, which only a VAR_CONFIG can complete, and that is not supported; write the full address` }
  }
  const m = SHAPE.exec(s)
  // An S7 data block address is often shown with a % in front; here a % tag is an IEC address, so a DB's is written without (core/io/s7Io.ts)
  if (!m && /^%DB\d+\.DB/i.test(s)) return { error: `'${s}' is a data block address, which is written without the %: ${s.slice(1)} (an S7 link carries it)` }
  if (!m) return { error: `'${s}' is not a direct address; one reads like %IX0.0 (input bit), %QX0.0 (output bit) or %IW0 (input word)` }
  const area = m[1]!.toUpperCase() as IoArea
  const size = (m[2]?.toUpperCase() ?? 'X') as IoSize
  const fields = m[3]!.split('.').map((f) => Number(f))
  if (fields.some((f) => !Number.isSafeInteger(f))) return { error: `'${s}' has a number too large to address` }
  if (size === 'X') {
    if (fields.length !== 2) return { error: `a bit address is byte.bit, like %${area}X0.3; '${s}' has ${fields.length === 1 ? 'no bit' : 'more than two levels'}` }
    if (fields[1]! > 7) return { error: `bit ${fields[1]} does not exist in a byte (0-7): '${s}'` }
  } else if (fields.length !== 1) {
    return { error: `a ${SIZE_WORD[size]} address is one number, like %${area}${size}4; '${s}' has ${fields.length}` }
  }
  return { area, size, fields, text: `%${area}${size}${fields.join('.')}` }
}

/** The canonical spelling, or null when `raw` is not a well-formed direct address. */
export function canonicalAddress(raw: string): string | null {
  const a = parseDirectAddress(raw)
  return 'error' in a ? null : a.text
}

const SIZE_WORD: Record<IoSize, string> = { X: 'bit', B: 'byte', W: 'word', D: 'double-word', L: 'long-word' }

/** The elementary types that fit each size, in the order a message lists them. */
export const TYPES_FOR_SIZE: Record<IoSize, readonly string[]> = {
  X: ['BOOL'],
  B: ['BYTE', 'SINT', 'USINT'],
  W: ['INT', 'UINT', 'WORD'],
  D: ['DINT', 'UDINT', 'DWORD', 'REAL'],
  L: ['LINT', 'ULINT', 'LWORD', 'LREAL'],
}

/** "bit", "word", ... for a message. */
export function sizeWord(size: IoSize): string {
  return SIZE_WORD[size]
}

/** Which way a point's value travels, seen from the PLC: it reads an input and writes an output. */
export function addressDirection(a: DirectAddress): 'input' | 'output' | 'memory' {
  return a.area === 'I' ? 'input' : a.area === 'Q' ? 'output' : 'memory'
}
