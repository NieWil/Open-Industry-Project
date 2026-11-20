// Type-ahead for a ladder editor's fields: as you type `Conv_`, the rest of the first tag
// that starts that way appears after the caret, selected - so the next keystroke replaces it, and only Enter takes it.
// Nothing here touches the program; it only proposes text.
//
// Part of the shared rung core (ladderEdit.ts): pure string work over a list of names, so every dialect's editor has
// it (a family may add candidates of its own on top).

/** The candidate that continues `partial`, or null: one spelled in the same case first, then any case, each in the order given. */
function continuing(partial: string, candidates: readonly string[], allowEmpty = false): string | null {
  if (partial === '' && !allowEmpty) return null
  const longer = candidates.filter((c) => c.length > partial.length)
  return longer.find((c) => c.startsWith(partial)) ?? longer.find((c) => c.toUpperCase().startsWith(partial.toUpperCase())) ?? null
}

/**
 * `typed` with the rest of the tag it begins, or null when nothing continues it.
 *
 * It completes the last name in the text, so an expression is completed where it is being written
 * (`Level + Cou` -> `Level + Count`). After a `.` the candidates are that tag's members, asked of
 * `membersOf` with everything before the dot (`Conv.Drive.` -> the members of Conv.Drive), and an empty
 * partial is enough there: `T1.` proposes a TON's members, `T1.Q`, `T1.ET` and the rest. A bit number (`Status.3`) is never completed.
 *
 * What was typed is kept as typed - only the ending is added - so a name begun in another case still
 * commits, and the editor's own case correction puts it right afterwards.
 */
export function completeName(typed: string, names: readonly string[], membersOf: (base: string) => readonly string[]): string | null {
  // a name starts where nothing of a word or a literal stands before it: not the `s` of `T#2s`, the `F` of `16#F`
  const token = /(?<![A-Za-z0-9_#.])[A-Za-z_][A-Za-z0-9_.[\]]*$/.exec(typed)?.[0]
  if (token === undefined) return null // the text does not end in a name (`Level + `, `3`, `T#2s`): nothing is being named
  const dot = token.lastIndexOf('.')
  if (dot < 0) {
    const hit = continuing(token, names)
    return hit === null ? null : typed + hit.slice(token.length)
  }
  const partial = token.slice(dot + 1)
  if (/^[0-9]/.test(partial)) return null // a bit of a word
  const hit = continuing(partial, membersOf(token.slice(0, dot)), true)
  return hit === null ? null : typed + hit.slice(partial.length)
}

// ---- suggestions in the order of what the operand wants --------------------------------------------------------
//
// A tool that offers every tag for every operand: with a few thousand of them the one wanted is rarely the first
// that starts with what was typed. The instruction already says what it takes - a contact a bit, a MOVE a number,
// a TON a timer - so the candidates are put in that order: tags of a type the operand takes, then structures that
// hold one (the member is a dot away), then the rest. Order only: nothing is hidden, because a program may
// rightly put an expression, an array element or an alias where the table says "number".

/** the types an integer / real operand takes: IEC's elementary numbers and bit strings */
export const NUMERIC_TYPES: ReadonlySet<string> = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL', 'BYTE', 'WORD', 'DWORD', 'LWORD'])
export const BIT_TYPES: ReadonlySet<string> = new Set(['BOOL'])

/** The type a declared type holds, upper case: an array's element (`ARRAY [0..9] OF DINT` -> `DINT`), a string's
 *  family without its length (`STRING[20]` -> `STRING`), anything else as it is. The index is a bracket away. */
export function elementType(type: string): string {
  return (/\bOF\s+(.+)$/i.exec(type)?.[1] ?? type).replace(/\[.*$/, '').trim().toUpperCase()
}

/**
 * `names` with the ones the operand wants first: a tag whose (element) type is wanted, then a tag of a structure
 * that holds a member of a wanted type, then everything else - each group in the order given, so an alphabetical
 * list stays alphabetical inside its group.
 *
 * `typeOf` answers a name's declared type as written (`DINT`, `ARRAY[0..9] OF DINT`, `MotorUDT`), or undefined;
 * `membersOf` a structure type's member types. An array counts as its element: the index is a bracket away.
 */
export function rankByWanted(names: readonly string[], wants: ReadonlySet<string> | null, typeOf: (name: string) => string | undefined, membersOf: (type: string) => readonly string[]): string[] {
  if (wants === null || wants.size === 0) return [...names]
  const holds = new Map<string, boolean>()
  const structHolds = (type: string): boolean => {
    let known = holds.get(type)
    if (known === undefined) {
      known = membersOf(type).some((m) => wants.has(elementType(m)))
      holds.set(type, known)
    }
    return known
  }
  const tiers: string[][] = [[], [], []]
  for (const name of names) {
    const declared = typeOf(name)
    const type = declared === undefined ? '' : elementType(declared)
    tiers[type !== '' && wants.has(type) ? 0 : type !== '' && structHolds(type) ? 1 : 2]!.push(name)
  }
  return [...tiers[0]!, ...tiers[1]!, ...tiers[2]!]
}
