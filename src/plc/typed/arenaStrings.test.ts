// A STRING read back from a controller's memory (Arena.strAt) is the text that was put there, unit for unit: an
// empty one, one longer than a single String.fromCharCode call takes, and code units that are not characters on
// their own.
import { describe, expect, it } from 'vitest'
import { Arena } from './arena'

function roundTrip(text: string): string {
  const arena = new Arena(2 * (text.length + 1) + 64)
  arena.strPut(16, text.length, text)
  return arena.strAt(16)
}

describe('a STRING in the arena', () => {
  it('reads back what was written, at every length around the chunk a single call takes', () => {
    for (const n of [0, 1, 2, 80, 4095, 4096, 4097, 8192, 8193, 20000]) {
      let text = ''
      for (let i = 0; i < n; i++) text += String.fromCharCode(32 + ((i * 7) % 95))
      expect(roundTrip(text) === text, `length ${n}`).toBe(true)
    }
  })

  it('keeps code units that are not characters on their own', () => {
    const text = 'a\u0000b\ud800c\udc00d￿é'
    const back = roundTrip(text)
    expect(back.length).toBe(text.length)
    for (let i = 0; i < text.length; i++) expect(back.charCodeAt(i)).toBe(text.charCodeAt(i))
  })

  it('reads no further than the length it holds', () => {
    const arena = new Arena(256)
    arena.strPut(16, 20, 'a longer text here')
    arena.strPut(16, 20, 'short')
    expect(arena.strAt(16)).toBe('short')
    arena.strPut(16, 3, 'clipped')
    expect(arena.strAt(16)).toBe('cli')
  })

  it('copies one into another as a read and a write would, at every length around the short copy', () => {
    for (const n of [0, 1, 31, 32, 33, 34, 200]) {
      for (const cap of [0, 1, 32, 33, 500]) {
        let text = ''
        for (let i = 0; i < n; i++) text += String.fromCharCode(65 + (i % 26))
        const copied = new Arena(4096)
        const stored = new Arena(4096)
        for (const arena of [copied, stored]) {
          arena.strPut(16, 500, text)
          arena.strPut(2048, 500, 'what the target held before, longer than a short text so its tail shows')
        }
        copied.strCopy(2048, cap, 16)
        stored.strPut(2048, cap, stored.strAt(16))
        expect(Array.from(copied.U16), `length ${n} into capacity ${cap}`).toEqual(Array.from(stored.U16))
      }
    }
  })

  it('copies one onto itself, cut to the capacity given', () => {
    const arena = new Arena(256)
    arena.strPut(16, 20, 'unchanged')
    arena.strCopy(16, 20, 16)
    expect(arena.strAt(16)).toBe('unchanged')
    arena.strCopy(16, 4, 16)
    expect(arena.strAt(16)).toBe('unch')
  })
})
