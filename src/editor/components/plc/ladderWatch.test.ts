import { describe, expect, it } from 'vitest'
import { shownUnchanged, fmt, indexWatch, watchLookup } from './ladderWatch'

// A ladder sheet's live values (ladderWatch.ts): the running image read by the text a rung spells a variable with.

const IMAGE = {
  'Main.Start': true,
  'Main.Count': 7,
  'Line2.Count': 9,
  Status: 0b1010,
  Idx: 2,
  'Arr[2]': 42,
  Name: 'Box',
}

describe('reading the running image by what a rung says', () => {
  const { valueOf, keyOf } = watchLookup(IMAGE, indexWatch(IMAGE))

  it("a PROGRAM's variable by its bare name, when one instance has it; any case, any spacing", () => {
    expect(valueOf('start')).toBe(true)
    expect(keyOf('START')).toBe('Main.Start')
    expect(valueOf('Main . Count')).toBe(7)
    expect(valueOf('Count')).toBeUndefined() // Main.Count and Line2.Count: which one is not the sheet's to guess
  })

  it('a bit of a word, and an index that is itself a variable', () => {
    expect(valueOf('Status.1')).toBe(true)
    expect(valueOf('Status.2')).toBe(false)
    expect(keyOf('Status.3')).toBe('Status.3')
    expect(valueOf('Arr[Idx]')).toBe(42)
  })

  it('nothing is read when nothing runs', () => {
    expect(watchLookup(null, null).valueOf('Start')).toBeUndefined()
  })

  it('printed as a rung prints it', () => {
    expect([fmt(true), fmt(false), fmt(1 / 3), fmt('x'), fmt(undefined)]).toEqual(['1', '0', '0.333', 'x', ''])
  })
})

describe('whether a newer image changes what the sheet shows', () => {
  const read = (image: Record<string, number | boolean | string>) => watchLookup(image, indexWatch(image))
  const first = { 'Main.Run': true, 'Main.Count': 3, 'Main.Idle': 0, 'Main.Bins[0]': 1, 'Main.Bins[1]': 2, 'Main.i': 0 }

  /** the operand texts a draw asked about, with what it was handed */
  const drawn = (image: typeof first, texts: string[]): Map<string, number | boolean | string | undefined> => {
    const lookup = read(image)
    return new Map(texts.map((t) => [t, lookup.valueOf(t)]))
  }

  it('is unchanged when only values the sheet does not show moved', () => {
    const shown = drawn(first, ['Run', 'Count', 'Nope'])
    expect(shownUnchanged(shown, read({ ...first, 'Main.Idle': 99 }))).toBe(true)
  })

  it('is changed when a shown value moved, or one appeared where there was none', () => {
    const shown = drawn(first, ['Run', 'Count', 'Nope'])
    expect(shownUnchanged(shown, read({ ...first, 'Main.Count': 4 }))).toBe(false)
    expect(shownUnchanged(shown, read({ ...first, 'Main.Nope': 1 } as typeof first))).toBe(false)
  })

  it('follows an element whose index is a variable', () => {
    const shown = drawn(first, ['Bins[i]'])
    expect(shown.get('Bins[i]')).toBe(1)
    expect(shownUnchanged(shown, read({ ...first, 'Main.i': 1 }))).toBe(false)
  })

  it('a draw that showed nothing never asks for another', () => {
    expect(shownUnchanged(new Map(), read({ ...first, 'Main.Count': 9 }))).toBe(true)
  })
})

describe('the index of a value table is built only when a lookup needs it', () => {
  // a table that counts how often its keys are listed: listing them is what an index costs
  const counted = (values: Record<string, number | boolean | string>): { table: Record<string, number | boolean | string>; listed: () => number } => {
    let n = 0
    const table = new Proxy(values, {
      ownKeys: (t) => {
        n++
        return Reflect.ownKeys(t)
      },
    })
    return { table, listed: () => n }
  }
  const VALUES = { Start: true, Count: 7, Word: 5, 'Zone[2].Run': true, 'Main.Local': 3 }

  it('answers a name spelled as the table spells it, a bit of a word and a literal without listing a key', () => {
    const { table, listed } = counted({ ...VALUES })
    const { valueOf, keyOf } = watchLookup(table, indexWatch(table))
    expect(valueOf('Start')).toBe(true)
    expect(valueOf(' Count ')).toBe(7)
    expect(valueOf('Zone[2].Run')).toBe(true)
    expect(keyOf('Word.2')).toBe('Word.2')
    expect(valueOf('Word.2')).toBe(true)
    expect(valueOf('Word.1')).toBe(false)
    for (const literal of ['0', '-1', '2.5', '16#FF', 'T#5s', "'text'", '?']) expect(keyOf(literal), literal).toBeNull()
    expect(listed()).toBe(0)
  })

  it('gives the answers a full index gives, for every spelling', () => {
    const { table, listed } = counted({ ...VALUES })
    const { valueOf, keyOf } = watchLookup(table, indexWatch(table))
    expect(keyOf('start')).toBe('Start') // another case: the index answers
    expect(listed()).toBeGreaterThan(0)
    expect(keyOf('Local')).toBe('Main.Local') // an instance's variable by its bare name
    expect(keyOf('ZONE[2].RUN')).toBe('Zone[2].Run')
    expect(valueOf('word.0')).toBe(true)
    expect(keyOf('Nothing')).toBeNull()
  })
})
