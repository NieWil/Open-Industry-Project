// One bit of an integer, as the exporters write it. The parser reads `Status.3` (a `bit` node, parserExpr.ts); IEC's
// 3rd edition spells the same access `Status.%X3` (partial access), which is the spelling every target reads, so the
// text exporters respell it. Text in, text out, like the rest of the export path.

import { lex } from './lexer'
import { parse } from './parser'

/** `source` with every `Tag.3` written `Tag.%X3`; source that does not parse comes back untouched. */
export function expandBits(source: string): string {
  let at: number[]
  try {
    at = parse(lex(source), null).bitRefs
  } catch {
    return source
  }
  let out = source
  for (const offset of [...at].sort((a, b) => b - a)) out = `${out.slice(0, offset)}%X${out.slice(offset)}`
  return out
}
