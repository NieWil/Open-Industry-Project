import { describe, expect, it } from 'vitest'
import { compile } from './interpreter'
import { controllerDiagnostics, controllerFor } from './controller'
import { declareTagIn, tagNameError, tagScopes, tagTypeOptions } from './tags'

const POUS = `FUNCTION_BLOCK Latch
VAR_INPUT S : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := Q OR S;
END_FUNCTION_BLOCK

PROGRAM Line
VAR
  Count : INT;
END_VAR
Count := Count + 1;
END_PROGRAM
`

describe('tags: scopes and types', () => {
  it('the controller is always a scope, then every POU in source order', () => {
    expect(tagScopes('').map((s) => s.label)).toEqual(['Controller'])
    expect(tagScopes(POUS).map((s) => `${s.kind}:${s.label}`)).toEqual(['controller:Controller', 'functionBlock:Latch', 'program:Line'])
  })

  it('offers the elementary types, the standard blocks, and what the program defines', () => {
    const groups = tagTypeOptions(`TYPE Mode : (Idle, Run); END_TYPE\n${POUS}`)
    expect(groups[0]!.types).toContain('DINT')
    expect(groups[1]!.types).toContain('TON')
    expect(groups[2]!.types).toEqual(['Mode', 'Latch'])
  })
})

describe('tags: names', () => {
  it('refuses the empty, the malformed, the reserved, and the already declared - in that scope', () => {
    expect(tagNameError('', { kind: 'controller' }, ' ')).toMatch(/required/)
    expect(tagNameError('', { kind: 'controller' }, '1st')).toMatch(/not a valid/)
    expect(tagNameError('', { kind: 'controller' }, 'end_if')).toMatch(/reserved/)
    expect(tagNameError(POUS, { kind: 'pou', name: 'Line' }, 'count')).toMatch(/already declared/)
    expect(tagNameError(POUS, { kind: 'pou', name: 'Latch' }, 'Count')).toBeNull()
    expect(tagNameError(POUS, { kind: 'controller' }, 'Latch')).toMatch(/program or block name/)
    expect(tagNameError(POUS, { kind: 'controller' }, 'Eye')).toBeNull()
  })
})

describe('tags: declaring', () => {
  it('into an empty program, a program with only statements, and one with the block already', () => {
    const a = declareTagIn('', { kind: 'controller' }, { name: 'Start', type: 'BOOL', section: 'VAR_INPUT', description: 'push button' })
    expect(a).toBe('VAR_INPUT\n  Start : BOOL; (* push button *)\nEND_VAR\n')
    expect(compile(a).inputs).toEqual(['Start'])
    const b = declareTagIn('x := 1;', { kind: 'controller' }, { name: 'x', type: 'DINT', section: 'VAR' })
    expect(b).toBe('VAR\n  x : DINT;\nEND_VAR\nx := 1;')
    const c = declareTagIn(a, { kind: 'controller' }, { name: 'Stop', type: 'BOOL', section: 'VAR_INPUT' })
    expect(c).toBe('VAR_INPUT\n  Start : BOOL; (* push button *)\n  Stop : BOOL;\nEND_VAR\n')
  })

  it('into a PROGRAM or FUNCTION_BLOCK, at its own indentation, and the result checks', () => {
    let src = declareTagIn(POUS, { kind: 'pou', name: 'Line' }, { name: 'Total', type: 'INT', section: 'VAR' })
    expect(src).toContain('VAR\n  Count : INT;\n  Total : INT;\nEND_VAR\nCount := Count + 1;')
    src = declareTagIn(src, { kind: 'pou', name: 'Latch' }, { name: 'Held', type: 'TON', section: 'VAR' })
    expect(src).toContain('VAR_OUTPUT Q : BOOL; END_VAR\nVAR\n  Held : TON;\nEND_VAR\nQ := Q OR S;')
    src = declareTagIn(src, { kind: 'controller' }, { name: 'Eye', type: 'BOOL', section: 'VAR_INPUT' })
    expect(src.endsWith('END_PROGRAM\nVAR_INPUT\n  Eye : BOOL;\nEND_VAR\n')).toBe(true)
    // beside PROGRAMs the controller's tags are legal once the table's CONFIGURATION stands behind them,
    // which is how the editor always checks and runs a program (controller.ts)
    const checked = controllerDiagnostics(src, controllerFor(src, null, 100))
    expect([...checked.source, ...checked.controller]).toEqual([])
  })

  it('leaves the program alone for a scope it does not have', () => {
    expect(declareTagIn(POUS, { kind: 'pou', name: 'Nope' }, { name: 'x', type: 'BOOL', section: 'VAR' })).toBe(POUS)
  })

  it('defuses a comment terminator inside a description', () => {
    expect(declareTagIn('', { kind: 'controller' }, { name: 'x', type: 'BOOL', section: 'VAR', description: 'a *) b' })).toContain('(* a * ) b *)')
  })
})

describe('tags: listing, deleting, renaming', () => {
  const SRC = `PROGRAM Line
VAR
  Count : INT := 3;
  Held : STRING[20];
END_VAR
Count := Count + a;
END_PROGRAM
VAR_INPUT
  Start : BOOL; (* push button *)
  a, b, c : INT;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR
`
  it('lists every tag with its scope, type as written, and description', async () => {
    const { listTags } = await import('./tags')
    const rows = listTags(SRC)
    expect(rows.map((r) => `${r.scope.kind === 'pou' ? r.scope.name : 'ctl'}:${r.name}:${r.section}:${r.type}`)).toEqual([
      'ctl:Start:VAR_INPUT:BOOL', 'ctl:a:VAR_INPUT:INT', 'ctl:b:VAR_INPUT:INT', 'ctl:c:VAR_INPUT:INT', 'ctl:Motor:VAR_OUTPUT:BOOL',
      'Line:Count:VAR:INT', 'Line:Held:VAR:STRING[20]',
    ])
    expect(rows[0]!.description).toBe('push button')
  })

  it('deletes a line of its own with its comment, one name of several, and an emptied block', async () => {
    const { deleteTag } = await import('./tags')
    const a = deleteTag(SRC, { kind: 'controller' }, 'Start')
    expect(a).not.toContain('Start')
    expect(a).not.toContain('push button')
    expect(a).toContain(`VAR_INPUT
  a, b, c : INT;
END_VAR`)
    expect(deleteTag(SRC, { kind: 'controller' }, 'b')).toContain('  a, c : INT;')
    expect(deleteTag(SRC, { kind: 'controller' }, 'c')).toContain('  a, b : INT;')
    expect(deleteTag(SRC, { kind: 'controller' }, 'a')).toContain('  b, c : INT;')
    const emptied = deleteTag(SRC, { kind: 'controller' }, 'Motor')
    expect(emptied).not.toMatch(/VAR_OUTPUT/)
    const pou = deleteTag(SRC, { kind: 'pou', name: 'Line' }, 'Held')
    expect(pou).toContain('VAR\n  Count : INT := 3;\nEND_VAR')
    expect(deleteTag(SRC, { kind: 'pou', name: 'Line' }, 'Nope')).toBe(SRC)
  })

  it('renames a tag everywhere it is spelled, in any case, and not in prose', async () => {
    const { renameTag } = await import('./tags')
    const out = renameTag(`VAR_INPUT start : BOOL; END_VAR\n(* the Start button *)\nMotor := START;`, { kind: 'controller' }, 'Start', 'Go')
    expect(out).toEqual({ source: `VAR_INPUT Go : BOOL; END_VAR\n(* the Start button *)\nMotor := Go;`, error: null })
  })
})

describe('tags: a rename follows the tag, not the spelling', () => {
  // `Count` is four different things here: a structure's field, a function block's input, a program's tag, and (as
  // `Z.Count`, `T(Count := ...)`) the names of those other things at the places that use them
  const SRC = `TYPE Zone : STRUCT Count : DINT; END_STRUCT; END_TYPE
FUNCTION_BLOCK Tally
VAR_INPUT Count : DINT; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
VAR Seen : DINT; END_VAR
Seen := Count;
Q := Count > 3;
END_FUNCTION_BLOCK
PROGRAM Line
VAR Count : DINT; Z : Zone; T : Tally; Level : INT; END_VAR
Count := Z.Count;
T(Count := Count);
Level := Limit;
END_PROGRAM
VAR_GLOBAL Limit : INT; Parts : DINT; END_VAR
`
  const line = { kind: 'pou', name: 'Line' } as const
  const tally = { kind: 'pou', name: 'Tally' } as const
  const ctl = { kind: 'controller' } as const

  it("a program's tag is renamed in that program: not the structure's field, not the block's input, not the formal names", async () => {
    const { renameTag } = await import('./tags')
    const out = renameTag(SRC, line, 'Count', 'Total')
    expect(out.error).toBeNull()
    expect(out.source).toBe(SRC.replace('VAR Count : DINT; Z', 'VAR Total : DINT; Z').replace('Count := Z.Count;', 'Total := Z.Count;').replace('T(Count := Count);', 'T(Count := Total);'))
    const checked = controllerDiagnostics(out.source!, controllerFor(out.source!, null, 100))
    expect([...checked.source, ...checked.controller]).toEqual([])
  })

  it("a block's local stays in the block; its parameter is refused, because every call names it", async () => {
    const { renameTag } = await import('./tags')
    expect(renameTag(SRC, tally, 'Seen', 'Last').source).toBe(SRC.replace('VAR Seen : DINT;', 'VAR Last : DINT;').replace('Seen := Count;', 'Last := Count;'))
    expect(renameTag(SRC, tally, 'Count', 'N')).toEqual({ source: null, error: expect.stringMatching(/"Count" is a parameter of Tally, and every call of Tally names it too/) })
  })

  it('a controller tag follows into every POU that sees it, and not into one whose local hides it', async () => {
    const { renameTag } = await import('./tags')
    const out = renameTag(SRC, ctl, 'Limit', 'MaxLevel')
    expect(out.source).toBe(SRC.replace('Level := Limit;', 'Level := MaxLevel;').replace('VAR_GLOBAL Limit', 'VAR_GLOBAL MaxLevel'))
    // a program with a Limit of its own keeps it, and its uses of it
    const hidden = SRC.replace('Level : INT; END_VAR', 'Level : INT; Limit : INT; END_VAR')
    expect(renameTag(hidden, ctl, 'Limit', 'MaxLevel').source).toBe(hidden.replace('VAR_GLOBAL Limit', 'VAR_GLOBAL MaxLevel'))
  })

  it("a rename that would hand one tag's uses to another is refused, either way round", async () => {
    const { renameTag } = await import('./tags')
    // Line uses the controller's Limit and declares a Level: renamed to Level, Line's uses would be its local's
    expect(renameTag(SRC, ctl, 'Limit', 'Level')).toEqual({ source: null, error: expect.stringMatching(/Line declares a "Level" of its own and uses the controller's "Limit"/) })
    // Line's Count renamed to Limit would take over Line's uses of the controller's Limit
    expect(renameTag(SRC, line, 'Count', 'Limit')).toEqual({ source: null, error: expect.stringMatching(/Line already uses the top-level variable "Limit"/) })
  })

  it("the scene's names for a tag: a controller tag's own, a program tag's through every instance of the program", async () => {
    const { tagRenamesForScene } = await import('./tags')
    expect(tagRenamesForScene(SRC, ctl, 'Limit', 'MaxLevel', null)).toEqual([{ from: 'Limit', to: 'MaxLevel' }])
    const table = { tasks: [{ name: 'MainTask', intervalMs: 10, priority: 10 }], programs: [{ name: 'Line', type: 'Line', task: 'MainTask' }, { name: 'Line2', type: 'Line', task: 'MainTask' }] }
    expect(tagRenamesForScene(SRC, line, 'Count', 'Total', table)).toEqual([{ from: 'Line.Count', to: 'Line.Total' }, { from: 'Line2.Count', to: 'Line2.Total' }])
    expect(tagRenamesForScene(SRC, tally, 'Seen', 'Last', table)).toEqual([])
    // one instance: a part wired to the bare name follows too, unless a top-level tag owns that name
    const sole = { tasks: table.tasks, programs: [table.programs[0]!] }
    expect(tagRenamesForScene(SRC, line, 'Count', 'Total', sole)).toEqual([{ from: 'Line.Count', to: 'Line.Total' }, { from: 'Count', to: 'Total' }])
    const owned = SRC.replace('VAR_GLOBAL Limit', 'VAR_GLOBAL Count : INT; Limit')
    expect(tagRenamesForScene(owned, line, 'Count', 'Total', sole)).toEqual([{ from: 'Line.Count', to: 'Line.Total' }])
  })
})

describe('tags: editing one in place (the tag dialog, opened on an existing tag)', () => {
  const SRC = `PROGRAM Line
VAR
  Count : INT := 3; (* parts seen *)
  Held : STRING[20];
END_VAR
Count := Count + a;
END_PROGRAM
VAR_INPUT
  Start : BOOL; (* push button *)
  a, b, c : INT;
END_VAR
`
  const line = { kind: 'pou', name: 'Line' } as const
  const ctl = { kind: 'controller' } as const

  it('a new type is written where the tag stands: its place, its starting value and its comment are kept', async () => {
    const { editTag: edit } = await import('./tags')
    const editTag = (...a: Parameters<typeof edit>): string | null => edit(...a).source
    const out = editTag(SRC, line, 'Count', { name: 'Count', type: 'DINT', section: 'VAR', description: 'parts seen' })
    expect(out).toBe(SRC.replace('Count : INT := 3;', 'Count : DINT := 3;'))
  })

  it('a description is added, changed and removed without touching the declaration', async () => {
    const { editTag: edit } = await import('./tags')
    const editTag = (...a: Parameters<typeof edit>): string | null => edit(...a).source
    expect(editTag(SRC, line, 'Held', { name: 'Held', type: 'STRING[20]', section: 'VAR', description: 'what it holds' })).toContain('  Held : STRING[20]; (* what it holds *)\n')
    expect(editTag(SRC, ctl, 'Start', { name: 'Start', type: 'BOOL', section: 'VAR_INPUT', description: '' })).toContain('  Start : BOOL;\n')
    expect(editTag(SRC, ctl, 'Start', { name: 'Start', type: 'BOOL', section: 'VAR_INPUT', description: 'the green one' })).toContain('  Start : BOOL; (* the green one *)\n')
  })

  it('a new name follows everywhere it is spelled', async () => {
    const { editTag: edit } = await import('./tags')
    const editTag = (...a: Parameters<typeof edit>): string | null => edit(...a).source
    const out = editTag(SRC, line, 'Count', { name: 'Total', type: 'INT', section: 'VAR', description: 'parts seen' })
    expect(out).toContain('  Total : INT := 3; (* parts seen *)')
    expect(out).toContain('Total := Total + a;')
    expect(out).not.toMatch(/\bCount\b/)
  })

  it('one name of a list, and a change of usage, are declared again - and the result still compiles', async () => {
    const { editTag: edit, listTags } = await import('./tags')
    const editTag = (...a: Parameters<typeof edit>): string => edit(...a).source!
    // `b` leaves `a, b, c : INT` and becomes a DINT of its own
    const retyped = editTag(SRC, ctl, 'b', { name: 'b', type: 'DINT', section: 'VAR_INPUT', description: '' })
    expect(retyped).toContain('  a, c : INT;')
    expect(listTags(retyped).find((r) => r.name === 'b')).toMatchObject({ type: 'DINT', section: 'VAR_INPUT' })
    // an input becomes an output: another VAR block
    const moved = editTag(SRC, ctl, 'Start', { name: 'Start', type: 'BOOL', section: 'VAR_OUTPUT', description: 'push button' })
    expect(listTags(moved).find((r) => r.name === 'Start')).toMatchObject({ section: 'VAR_OUTPUT', description: 'push button' })
    const checked = controllerDiagnostics(moved, controllerFor(moved, null, 100))
    expect([...checked.source, ...checked.controller]).toEqual([])
  })

  // A declaration ends at its `;` - but a `;` inside a STRING literal ends nothing, and taking it for the end cut
  // the span mid-string, so editing that tag (or the one after it) rewrote the text around a broken literal.
  it('a `;` inside a string value is text, not the end of the declaration', async () => {
    const { editTag: edit } = await import('./tags')
    const src = 'VAR\n  Msg : STRING[20] := \'a;b\'; (* the note *)\n  After : INT := 3;\nEND_VAR\nAfter := After;\n'
    const scope = { kind: 'controller' } as const
    const out = edit(src, scope, 'Msg', { name: 'Msg', type: 'STRING[20]', section: 'VAR', description: 'greeting' })
    expect(out.source).not.toBeNull()
    expect(out.source!).toContain("Msg : STRING[20] := 'a;b';")
    expect(out.source!).toContain('(* greeting *)')
    expect(out.source!).toContain('After : INT := 3;')
    // and the one after it is still reachable, which a span that ran off the end would have swallowed
    const second = edit(out.source!, scope, 'After', { name: 'After', type: 'DINT', section: 'VAR', description: '' })
    expect(second.source!).toContain('After : DINT := 3;')
    expect(second.source!).toContain("Msg : STRING[20] := 'a;b';")
  })

  // The same gap as the saved-value span: strings were skipped, comments were not, so an apostrophe in one comment
  // ran on into the next declaration - the list showed that tag's type and description, and an edit deleted the
  // text in between.
  it('an apostrophe in a comment does not run one declaration into the next', async () => {
    const { editTag: edit, listTags: list } = await import('./tags')
    // (the apostrophe has to stand inside the declaration, before its `;` - one after it never reaches the scan)
    const src = "VAR\n  Count : DINT (* the operator's count *) := 1;\n  Limit : INT := 9; (* can't exceed *)\nEND_VAR\nCount := Limit;\n"
    const rows = list(src)
    expect(rows.find((r) => r.name === 'Count')?.type).toBe('DINT')
    expect(rows.find((r) => r.name === 'Limit')).toMatchObject({ type: 'INT', description: "can't exceed" })
    const out = edit(src, { kind: 'controller' }, 'Count', { name: 'Count', type: 'DINT', section: 'VAR', description: 'counted' })
    expect(out.source).toContain('Limit : INT := 9; (* can\'t exceed *)')
    expect(out.source).toMatch(/Count : DINT .*:= 1; \(\* counted \*\)/)
    expect(() => compile(out.source!)).not.toThrow()
  })

  // A declaration sharing its line with the block keywords must not take the whole line with it (`VAR` included),
  // which would leave a stray END_VAR the program cannot compile past.
  it('deleting the only tag of a one-line VAR block leaves a program that compiles', async () => {
    const { deleteTag } = await import('./tags')
    const src = 'VAR X : INT; END_VAR\nVAR_OUTPUT Q : BOOL; END_VAR\nQ := TRUE;\n'
    const out = deleteTag(src, { kind: 'controller' }, 'X')
    expect(out).not.toMatch(/\bX\b/)
    expect(() => compile(out)).not.toThrow()
    // and one of two keeps its block
    const two = deleteTag('VAR X : INT; Y : INT; END_VAR\nY := 1;\n', { kind: 'controller' }, 'X')
    expect(two).toMatch(/VAR\s+Y : INT; END_VAR/)
    expect(() => compile(two)).not.toThrow()
  })

  // A list wrapped over two lines was not seen as a list: the backward look for a comma stopped at the newline,
  // took `Accel`'s line for its own, and an edit to Accel's type rewrote the type Speed shares - silently.
  it('a tag in a wrapped list is edited alone, not with its neighbour', async () => {
    const { editTag: edit, listTags: list } = await import('./tags')
    const src = 'VAR\n  Speed,\n  Accel : REAL;\nEND_VAR\nSpeed := Accel;\n'
    const out = edit(src, { kind: 'controller' }, 'Accel', { name: 'Accel', type: 'DINT', section: 'VAR', description: '' })
    const rows = list(out.source!)
    expect(rows.find((r) => r.name === 'Speed')?.type).toBe('REAL')
    expect(rows.find((r) => r.name === 'Accel')?.type).toBe('DINT')
  })

  // The look back for a list's comma crosses lines and reads code only: a `//` comment ending in a comma on the line
  // above would make the next declaration look shared, and the delete-and-redeclare that follows would drop its value.
  it('a comma in a comment on the line above does not make a declaration part of a list', async () => {
    const { editTag: edit, listTags: list } = await import('./tags')
    const src = 'VAR\n  Speed : REAL; // m/s,\n  Accel : REAL := 2.5;\nEND_VAR\nSpeed := Accel;\n'
    const out = edit(src, { kind: 'controller' }, 'Accel', { name: 'Accel', type: 'REAL', section: 'VAR', description: 'ramp' })
    expect(out.source).toContain('Accel : REAL := 2.5; (* ramp *)')
    expect(out.source).toContain('Speed : REAL; // m/s,')
    expect(list(out.source!).find((r) => r.name === 'Speed')?.type).toBe('REAL')
  })

  // One ladder gesture asks for the tag list several times over, and the organizer and the tag editor ask again of the
  // same text: it is worked out once per text and shared, so it is read-only. And finding "part of a list" is a token
  // lookup, not a scan from the top of the text per declaration, which made listing 1000 tags take a quarter second.
  it('the tag list of a text is worked out once and shared, read-only; a list is still told from a comment', async () => {
    const { editTag: edit, listTags: list } = await import('./tags')
    const src = `VAR\n${Array.from({ length: 1000 }, (_, i) => `  T${i} : DINT := ${i}; // tag ${i},`).join('\n')}\n  A,\n  B : INT;\nEND_VAR\nA := B;\n`
    const rows = list(src)
    expect(list(src)).toBe(rows)
    expect(Object.isFrozen(rows)).toBe(true)
    // T1 follows a comment ending in a comma, so it is edited where it stands, starting value and all
    const t1 = edit(src, { kind: 'controller' }, 'T1', { name: 'T1', type: 'LINT', section: 'VAR', description: 'tag 1,' }).source!
    expect(t1).toContain('  T1 : LINT := 1; (* tag 1, *)\n')
    // B follows A's comma, so it is one of a list: A keeps its type, and B leaves the list to take its own
    const b = edit(src, { kind: 'controller' }, 'B', { name: 'B', type: 'DINT', section: 'VAR', description: '' }).source!
    expect(list(b).map((r) => `${r.name}:${r.type}`).filter((r) => /^[AB]:/.test(r))).toEqual(['A:INT', 'B:DINT'])
  })

  it('a tag that is not there changes nothing', async () => {
    const { editTag: edit } = await import('./tags')
    const editTag = (...a: Parameters<typeof edit>): string | null => edit(...a).source
    expect(editTag(SRC, line, 'Nope', { name: 'X', type: 'INT', section: 'VAR', description: '' })).toBe(SRC)
  })
})

describe('tags: go to definition', () => {
  const SRC = `TYPE Pos : STRUCT X : REAL; Y : REAL; END_STRUCT; END_TYPE
TYPE Mode : (Idle, Run); END_TYPE

VAR_GLOBAL
  Speed : REAL;
  Count : INT;
END_VAR

FUNCTION_BLOCK Base
VAR
  Ticks : INT;
END_VAR
Ticks := Ticks + 1;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Axis EXTENDS Base
VAR_INPUT
  Target : Pos;
END_VAR
VAR_EXTERNAL
  Speed : REAL;
END_VAR
METHOD Home
VAR
  Count : INT;
END_VAR
Count := Ticks;
END_METHOD
Target.X := Speed;
END_FUNCTION_BLOCK

FUNCTION Twice : INT
VAR_INPUT
  N : INT;
END_VAR
Twice := N * 2;
END_FUNCTION

PROGRAM Line
VAR
  A : Axis;
  M : Mode := Run;
  Count : INT;
END_VAR
A(Target := A.Target);
A.Home();
Count := Twice(N := Count) + A.Ticks;
A.Target.Y := Speed;
END_PROGRAM
`
  // the line holding the declaration of the last name in `before` (the caret at its end), and that name's first letters
  const goTo = async (before: string): Promise<string | null> => {
    const { definitionAt } = await import('./tags')
    const from = SRC.indexOf(before)
    expect(from).toBeGreaterThanOrEqual(0)
    const at = definitionAt(SRC, from + before.length)
    if (at === null) return null
    const start = SRC.lastIndexOf('\n', at - 1) + 1
    return `${SRC.slice(start, SRC.indexOf('\n', at)).trim()} @${SRC.slice(at, at + 4)}`
  }

  it('finds a POU variable before the controller variable of the same name', async () => {
    const { definitionAt } = await import('./tags')
    const use = SRC.indexOf('Twice(N := Count') + 'Twice(N := Count'.length
    expect(definitionAt(SRC, use)).toBe(SRC.indexOf('Count : INT;', SRC.indexOf('PROGRAM Line')))
    expect(await goTo('A.Target.Y := Speed')).toBe('Speed : REAL; @Spee')
  })

  it('follows a VAR_EXTERNAL to the global it names', async () => {
    const { definitionAt } = await import('./tags')
    expect(definitionAt(SRC, SRC.indexOf('Target.X := Speed') + 'Target.X := Speed'.length)).toBe(SRC.indexOf('Speed : REAL;'))
  })

  it("resolves a METHOD's own variable, then what the block inherits", async () => {
    const { definitionAt } = await import('./tags')
    const inMethod = SRC.indexOf('Count := Ticks')
    expect(definitionAt(SRC, inMethod + 2)).toBe(SRC.indexOf('Count : INT;', SRC.indexOf('METHOD Home')))
    expect(definitionAt(SRC, inMethod + 'Count := Ticks'.length)).toBe(SRC.indexOf('Ticks : INT;'))
  })

  it('looks a member up in the instance, through EXTENDS and into a struct', async () => {
    expect(await goTo('A.Home')).toBe('METHOD Home @Home')
    expect(await goTo('A.Ticks')).toBe('Ticks : INT; @Tick')
    expect(await goTo('A.Target.Y')).toBe('TYPE Pos : STRUCT X : REAL; Y : REAL; END_STRUCT; END_TYPE @Y : ')
    expect(await goTo('A(Target := A.Target')).toBe('Target : Pos; @Targ')
  })

  it("takes a formal argument from the callee's declarations", async () => {
    expect(await goTo('A(Target')).toBe('Target : Pos; @Targ')
    expect(await goTo('Twice(N')).toBe('N : INT; @N : ')
  })

  it('jumps from a type, a POU or an enumeration value to where it is defined', async () => {
    expect(await goTo('A : Axis')).toBe('FUNCTION_BLOCK Axis EXTENDS Base @Axis')
    expect(await goTo('EXTENDS Base')).toBe('FUNCTION_BLOCK Base @Base')
    expect(await goTo('Target : Pos')).toBe('TYPE Pos : STRUCT X : REAL; Y : REAL; END_STRUCT; END_TYPE @Pos ')
    expect(await goTo('Mode := Run')).toBe('TYPE Mode : (Idle, Run); END_TYPE @Run)')
    expect(await goTo('Count := Twice')).toBe('FUNCTION Twice : INT @Twic')
  })

  it('answers null off a declared name', async () => {
    const { definitionAt } = await import('./tags')
    expect(definitionAt(SRC, SRC.indexOf('END_PROGRAM') + 3)).toBeNull()
    expect(definitionAt(SRC, SRC.indexOf('INT;') + 1)).toBeNull()
    expect(definitionAt('PROGRAM P\nVAR t : TON; END_VAR\nt(IN := TRUE);\nEND_PROGRAM', 'PROGRAM P\nVAR t : TON; END_VAR\nt(IN'.length)).toBeNull()
  })
})
