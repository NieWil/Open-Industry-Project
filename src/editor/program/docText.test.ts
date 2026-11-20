// A program's text as CodeMirror's document, split here (docText.ts): the document must be the one CodeMirror would
// have made of the string itself.
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { docText, linesOf } from './docText'

const TEXTS = ['', 'one', 'a\nb', 'a\r\nb', 'a\rb', 'a\n', '\n', '\r\n\r\n', 'a\r\n\rb\n\nc\r', 'tab\there\r\n  indented\n']

describe("a program's text as the editor's document", () => {
  it('breaks lines where CodeMirror does', () => {
    for (const text of TEXTS) expect(linesOf(text), JSON.stringify(text)).toEqual(text.split(/\r\n?|\n/))
  })

  it('is the document CodeMirror makes of the string', () => {
    for (const text of TEXTS) {
      const theirs = EditorState.create({ doc: text }).doc
      const ours = EditorState.create({ doc: docText(text) }).doc
      expect(ours.toString(), JSON.stringify(text)).toBe(theirs.toString())
      expect(ours.lines).toBe(theirs.lines)
      expect(ours.eq(theirs)).toBe(true)
    }
  })

  it('goes into an edit as the string would', () => {
    const state = EditorState.create({ doc: docText('one\ntwo\nthree') })
    const edit = (insert: Parameters<typeof docText>[0]): string => state.update({ changes: { from: 4, to: 7, insert: docText(insert) } }).state.doc.toString()
    expect(edit('2\r\n2b')).toBe(state.update({ changes: { from: 4, to: 7, insert: '2\r\n2b' } }).state.doc.toString())
    expect(edit('')).toBe('one\n\nthree')
  })
})
