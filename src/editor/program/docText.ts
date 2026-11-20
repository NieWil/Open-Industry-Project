// A program's text as the document CodeMirror holds, split into lines here.
//
// Handed a string, CodeMirror splits it with a regular expression. Under the lockdown the page runs in
// (docs/part-sandbox.md) the engine's fast path for that is off, and it takes about a second on a 25,000-line program
// where splitting on a plain string takes a few milliseconds. So a whole program is never handed over as a string:
// the editor's first document and every edit that carries text go through `docText`.

import { Text } from '@codemirror/state'

/** `text` as lines, breaking where CodeMirror does by default: at `\n`, `\r\n` and a lone `\r`. */
export function linesOf(text: string): string[] {
  const lf = text.includes('\r') ? text.replaceAll('\r\n', '\n').replaceAll('\r', '\n') : text
  return lf.split('\n')
}

/** `text` as a CodeMirror document. */
export function docText(text: string): Text {
  return Text.of(linesOf(text))
}
