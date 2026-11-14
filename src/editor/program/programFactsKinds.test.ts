// The kind of a wired tag, read from its declaration where that is safe (programFacts.ts PLAIN_KIND): the answer
// must be the one the value table gives.
import { describe, expect, it } from 'vitest'
import { compile } from '../../plc/interpreter'
import { LocalPlcLink } from '../../plc/link/plcLink'
import { programFactsOf } from './programFacts'

const TYPES = ['BOOL', 'SINT', 'INT', 'DINT', 'USINT', 'UINT', 'UDINT', 'REAL', 'LREAL', 'BYTE', 'WORD', 'TIME', 'STRING']
const SRC = `
TYPE Pair : STRUCT A : INT; B : BOOL; END_STRUCT; END_TYPE
PROGRAM Main
VAR
${TYPES.map((t) => `  v${t} : ${t};`).join('\n')}
  P : Pair;
  Arr : ARRAY[0..3] OF INT;
END_VAR
END_PROGRAM
`

describe('the kind of a wired tag', () => {
  const asked = [...TYPES.map((t) => `v${t}`), ...TYPES.map((t) => `Main.v${t}`), 'P.A', 'P.B', 'Arr[2]', 'vbool', 'VINT', 'Nothing', 'P']

  it('is what the value table shows, for every type and spelling', () => {
    const link = new LocalPlcLink(compile(SRC))
    const watch = link.watch
    const expected: Record<string, string> = {}
    for (const tag of asked) {
      const v = watch[link.aliases.get(tag) ?? tag]
      if (v !== undefined) expected[tag] = typeof v
    }
    const facts = programFactsOf({ source: SRC, controller: null, simulated: [], tags: { '': asked } })
    expect(facts.main?.kinds).toEqual(expected)
    // the declared ones were found, and a spelling the table does not have was not
    expect(expected['vBOOL']).toBe('boolean')
    expect(expected['vREAL']).toBe('number')
    expect(expected['P.B']).toBe('boolean')
    expect('vbool' in expected).toBe(false)
  })
})
