import { describe, expect, it } from 'vitest'
import { addToWatchList, addWatchNames, MAX_MEMBERS, onWatchListChange, parseWatchNames, readWatchList, resolveWatch, watchListKey, watchNameAt, watchNameOfSelection } from './plcWatchList'
import { memoryTable } from '../../core/watchTable'
import { compile } from '../../plc/interpreter'

const IMAGE = {
  Run: true,
  Count: 42,
  'Line.Speed': 1.5,
  'Line.Fill.ET': 1500,
  'Line.Fill.Q': false,
  'Cell.Status': 0b1010,
  'Bins[1]': 3,
  'Bins[2]': 4,
}

describe('resolveWatch', () => {
  it('finds a value by its name, in any case, and answers with the image spelling a write goes by', () => {
    expect(resolveWatch('count', IMAGE)).toMatchObject({ key: 'Count', value: 42, members: [] })
    expect(resolveWatch('Line.Speed', IMAGE)).toMatchObject({ key: 'Line.Speed', value: 1.5 })
  })

  it('reads one bit of a word out of the word', () => {
    expect(resolveWatch('Cell.Status.1', IMAGE)).toMatchObject({ key: 'Cell.Status.1', value: true })
    expect(resolveWatch('Cell.Status.2', IMAGE)).toMatchObject({ value: false })
  })

  it("takes a program instance's variable by its bare name when one instance holds it", () => {
    expect(resolveWatch('Speed', IMAGE)).toMatchObject({ key: 'Line.Speed', value: 1.5 })
    expect(resolveWatch('Fill.Q', IMAGE)).toMatchObject({ key: 'Line.Fill.Q', value: false })
    // two instances holding the name: neither is guessed
    expect(resolveWatch('Speed', { ...IMAGE, 'Other.Speed': 2 }).key).toBeNull()
  })

  it('lists the members under a structure, an array or an instance', () => {
    const fill = resolveWatch('Line.Fill', IMAGE)
    expect(fill.key).toBeNull()
    expect(fill.members.map((m) => m.key)).toEqual(['Line.Fill.ET', 'Line.Fill.Q'])
    expect(resolveWatch('bins', IMAGE).members.map((m) => m.value)).toEqual([3, 4])
    // a name that only starts the same is not a member
    expect(resolveWatch('Lin', IMAGE).members).toEqual([])
  })

  it('counts the members past the cap instead of listing them', () => {
    const big: Record<string, number> = {}
    for (let i = 0; i < MAX_MEMBERS + 5; i++) big[`A[${i}]`] = i
    const row = resolveWatch('A', big)
    expect(row.members).toHaveLength(MAX_MEMBERS)
    expect(row.more).toBe(5)
  })

  it('answers nothing for a name the program does not hold', () => {
    expect(resolveWatch('Nope', IMAGE)).toEqual({ name: 'Nope', key: null, value: undefined, members: [], more: 0 })
  })
})

describe('the watch list', () => {
  it('splits what was typed and skips names it already has, in any case', () => {
    expect(parseWatchNames(' Run, Count  Line.Speed;')).toEqual(['Run', 'Count', 'Line.Speed'])
    expect(addWatchNames(['Run'], ['RUN', 'Count', 'count'])).toEqual(['Run', 'Count'])
  })
})

describe('the name a right-click is on', () => {
  const at = (line: string): string | null => watchNameAt(line.replace('|', ''), line.indexOf('|'))

  it('takes the name with the names it is a member of, up to the one clicked', () => {
    expect(at('  Count := Co|unt + 1;')).toBe('Count')
    expect(at('IF Line.Fi|ll.ET > T#2s THEN')).toBe('Line.Fill')
    expect(at('IF Line.Fill.E|T > T#2s THEN')).toBe('Line.Fill.ET')
    expect(at('Bi|ns[i] := 3;')).toBe('Bins')
    expect(at('x := Status.|3;')).toBe('Status.3')
  })

  it('takes nothing on a keyword, a type, a literal or blank space', () => {
    expect(at('I|F Go THEN')).toBeNull()
    expect(at('  Go : BO|OL;')).toBeNull()
    expect(at('Fill(PT := T|#5s);')).toBeNull()
    expect(at('Fill(PT := T#5|s);')).toBeNull()
    expect(at('n := 4|2;')).toBeNull()
    expect(at('a :=  |  b;')).toBeNull()
  })

  it('takes a selection that is one place, and nothing else', () => {
    expect(watchNameOfSelection(' Line . Fill.ET ')).toBe('Line.Fill.ET')
    expect(watchNameOfSelection('Bins[2]')).toBe('Bins[2]')
    expect(watchNameOfSelection('a + b')).toBeNull()
    expect(watchNameOfSelection('END_IF')).toBeNull()
  })
})

describe('Add to Watch', () => {
  it("adds to the project's list and tells whoever listens", () => {
    const heard: string[] = []
    const off = onWatchListChange((p) => heard.push(p))
    addToWatchList('watch-test', ['Run'])
    addToWatchList('watch-test', ['run', 'Count'])
    off()
    expect(readWatchList('watch-test')).toEqual(['Run', 'Count'])
    expect(heard).toEqual(['watch-test', 'watch-test'])
  })

  it('keeps a list per document, so two projects of one name keep apart', () => {
    const a = watchListKey('doc-a', 'Line', false)
    const b = watchListKey('doc-b', 'Line', false)
    expect(a).not.toBe(b)
    addToWatchList(a, ['Motor'], 'Line')
    expect(readWatchList(b, 'Line')).toEqual([])
    expect(watchListKey('doc-a', 'Line', true)).toBe('Line') // a room's project has no document of its own here
    expect(watchListKey(null, 'Line', false)).toBe('Line')
  })

  it("takes over the list a project kept under its name, once it has none of its own", () => {
    addToWatchList('Old Line', ['Eye'])
    expect(readWatchList(watchListKey('doc-old', 'Old Line', false), 'Old Line')).toEqual(['Eye'])
  })
})

describe('an array too long to be among the image’s keys', () => {
  // (the image a running program gives: a copy of its memory, read through its plan - core/watchTable.ts)
  const image = (): Readonly<Record<string, number | boolean | string>> => {
    const program = compile(`TYPE Rec : STRUCT Ok : BOOL; Grid : ARRAY[1..2, 0..1] OF INT; END_STRUCT END_TYPE
VAR
  Wide : ARRAY[0..999] OF Rec;
END_VAR
Wide[1].Grid[2,0] := 9;`)
    program.scan(0.1)
    const plan = program.watchPlan!()!
    return memoryTable(plan.layout, plan.memory.slice(0))
  }

  it('answers one element by name, and lists the first values under the array or one of its elements', () => {
    const table = image()
    expect(resolveWatch('wide[1].grid[2,0]', table)).toMatchObject({ key: 'Wide[1].Grid[2,0]', value: 9, members: [] })
    const element = resolveWatch('Wide[1]', table)
    expect(element.members.map((m) => [m.key, m.value])).toEqual([['Wide[1].Ok', false], ['Wide[1].Grid[1,0]', 0], ['Wide[1].Grid[1,1]', 0], ['Wide[1].Grid[2,0]', 9], ['Wide[1].Grid[2,1]', 0]])
    expect(element.more).toBe(0)
    const whole = resolveWatch('Wide', table)
    expect(whole.members.length).toBe(MAX_MEMBERS)
    expect(whole.members[0]!.key).toBe('Wide[0].Ok')
    expect(whole.more).toBe(5000 - MAX_MEMBERS)
  })
})
