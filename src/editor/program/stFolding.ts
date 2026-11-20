// Code folding for the ST editor: which lines open a block that can fold (a VAR section, a TYPE or STRUCT, a POU, an
// IF / CASE / loop), a fold gutter, Ctrl+Shift+[ / ] on the caret's line, and "fold every declaration" for the menu.
//
// The ranges come from a scan of its own, not plc/lexer.ts: the lexer throws on the first character it cannot read,
// and folds should survive a half-typed line. The scan only needs the words outside comments, strings and pragmas.

import { codeFolding, foldCode, foldEffect, foldGutter, foldService, foldedRanges, unfoldCode } from '@codemirror/language'
import type { EditorState, Extension, Text } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'

export type StFoldKind = 'declaration' | 'pou' | 'statement'

/** One foldable block: `from` is the end of its opening line, `to` the end of the line before its END_ line (or the
 *  END_ word itself when code precedes it on its line), so the opener and the closer stay visible. */
export interface StFold {
  from: number
  to: number
  kind: StFoldKind
}

interface Opener {
  close: string
  kind: StFoldKind
  /** not reserved words, so a variable may be spelled so: a block only when a name follows */
  named?: true
  /** LADDER opens a section only on a line of its own */
  alone?: true
}

const OPENERS: Record<string, Opener> = {
  TYPE: { close: 'END_TYPE', kind: 'declaration' },
  STRUCT: { close: 'END_STRUCT', kind: 'declaration' },
  PROGRAM: { close: 'END_PROGRAM', kind: 'pou', named: true },
  FUNCTION_BLOCK: { close: 'END_FUNCTION_BLOCK', kind: 'pou' },
  FUNCTION: { close: 'END_FUNCTION', kind: 'pou' },
  METHOD: { close: 'END_METHOD', kind: 'pou', named: true },
  INTERFACE: { close: 'END_INTERFACE', kind: 'pou', named: true },
  CONFIGURATION: { close: 'END_CONFIGURATION', kind: 'pou', named: true },
  RESOURCE: { close: 'END_RESOURCE', kind: 'pou', named: true },
  LADDER: { close: 'END_LADDER', kind: 'statement', alone: true },
  IF: { close: 'END_IF', kind: 'statement' },
  CASE: { close: 'END_CASE', kind: 'statement' },
  FOR: { close: 'END_FOR', kind: 'statement' },
  WHILE: { close: 'END_WHILE', kind: 'statement' },
  REPEAT: { close: 'END_REPEAT', kind: 'statement' },
}
const VAR_SECTION: Opener = { close: 'END_VAR', kind: 'declaration' }

/** The end of the line `at` is on, before any `\r`. */
function lineEnd(src: string, at: number): number {
  const nl = src.indexOf('\n', at)
  const end = nl < 0 ? src.length : nl
  return end > 0 && src[end - 1] === '\r' ? end - 1 : end
}

// What the scan stops at: a comment (an unterminated one runs to the end, as the editor colours it), a string (ended by
// its quote or, unterminated, by the line's end; `$` escapes the next character), a pragma closed on its own line (a
// lone `{` is a typo, not a pragma that swallows the program), or a word that opens or closes a block. One regex lets
// the engine skip everything else: on an 18,000-line program it takes 2.8 ms where a character loop took 11, a cost the
// fold gutter pays per keystroke.
const SCAN = new RegExp(
  [
    String.raw`//[^\n]*`,
    String.raw`\(\*[\s\S]*?(?:\*\)|$)`,
    String.raw`'(?:\$.|[^'\n$])*'?`,
    String.raw`"(?:\$.|[^"\n$])*"?`,
    String.raw`\{[^}\n]*\}`,
    String.raw`\b(?:END_[A-Z_]+|VAR(?:_[A-Z_]+)?|${Object.keys(OPENERS).join('|')})\b`,
  ].join('|'),
  'gi',
)

/**
 * The foldable blocks of `src`, by where they open. A closer pairs with the nearest open block it closes, and the
 * blocks opened inside it that never closed are dropped: a half-typed IF inside a PROGRAM costs the IF its fold, not the
 * PROGRAM, and a CONFIGURATION's `PROGRAM Inst WITH Task : Main;` lines (which have no END_PROGRAM) cost nothing.
 */
export function stFolds(src: string): StFold[] {
  const out: StFold[] = []
  const open: { opener: Opener; at: number }[] = []
  SCAN.lastIndex = 0
  for (let m = SCAN.exec(src); m !== null; m = SCAN.exec(src)) {
    const c = m[0][0]!
    if (c === '/' || c === '(' || c === "'" || c === '"' || c === '{') continue
    const start = m.index
    const end = start + m[0].length
    const word = m[0].toUpperCase()
    if (word.startsWith('END_')) {
      let k = open.length - 1
      while (k >= 0 && open[k]!.opener.close !== word) k--
      if (k < 0) continue
      const o = open[k]!
      open.length = k
      const from = lineEnd(src, o.at)
      const closerLine = src.lastIndexOf('\n', start - 1) + 1
      const to = src.slice(closerLine, start).trim() === '' ? lineEnd(src, closerLine - 1) : start
      if (to > from) out.push({ from, to, kind: o.opener.kind })
      continue
    }
    const opener = word.startsWith('VAR') ? VAR_SECTION : OPENERS[word]
    if (!opener) continue
    if (opener.named && !/^[ \t]+[A-Za-z_]/.test(src.slice(end, end + 64))) continue
    if (opener.alone && (src.slice(src.lastIndexOf('\n', start - 1) + 1, start).trim() !== '' || src.slice(end, lineEnd(src, end)).trim() !== '')) continue
    open.push({ opener, at: start })
  }
  return out.sort((a, b) => a.from - b.from || b.to - a.to)
}

// one scan per document, shared by every line the gutter asks about
const scanned = new WeakMap<Text, Map<number, StFold>>()

/** The folds by the offset their opening line ends at; on a line opening two, the larger. */
function foldsOf(doc: Text): Map<number, StFold> {
  let byLine = scanned.get(doc)
  if (!byLine) {
    byLine = new Map()
    for (const f of stFolds(doc.toString())) if (!byLine.has(f.from)) byLine.set(f.from, f)
    scanned.set(doc, byLine)
  }
  return byLine
}

/** Fold every VAR section, TYPE and STRUCT not already folded: the program's statements, without its declarations. */
export function foldDeclarations(view: EditorView): boolean {
  const folded = foldedRanges(view.state)
  const isFolded = (f: StFold): boolean => {
    let hit = false
    folded.between(f.from, f.to, (a, b) => {
      if (a === f.from && b === f.to) hit = true
    })
    return hit
  }
  const effects = [...foldsOf(view.state.doc).values()].filter((f) => f.kind === 'declaration' && !isFolded(f)).map((f) => foldEffect.of({ from: f.from, to: f.to }))
  if (effects.length === 0) return false
  view.dispatch({ effects })
  return true
}

/** Folding for the ST editor. Folds are this view's own: a room does not share them, and undo does not touch them. */
export function stFolding(): Extension {
  return [
    foldService.of((state: EditorState, lineStart: number, lineEndAt: number) => {
      const f = foldsOf(state.doc).get(lineEndAt)
      return f && lineStart <= f.from ? { from: f.from, to: f.to } : null
    }),
    codeFolding(),
    foldGutter(),
    // CodeMirror's foldKeymap also binds Ctrl+Alt+[ / ], which is AltGr+[ on layouts that type [ with AltGr
    keymap.of([
      { key: 'Ctrl-Shift-[', mac: 'Cmd-Alt-[', run: foldCode },
      { key: 'Ctrl-Shift-]', mac: 'Cmd-Alt-]', run: unfoldCode },
    ]),
  ]
}
