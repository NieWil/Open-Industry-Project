import { describe, expect, it } from 'vitest'
import { defaultController, runnableSource } from './controller'
import { compile } from './interpreter'
import { watchInstances, watchScopes } from './watchScope'

const SRC = `VAR_GLOBAL
  g : INT;
  shared : INT;
END_VAR
FUNCTION_BLOCK Acc
VAR_INPUT step : INT; END_VAR
VAR i : INT; total : INT; END_VAR
i := i + 1;
total := total + step + g;
END_FUNCTION_BLOCK
FUNCTION Twice : INT
VAR_INPUT i : INT; END_VAR
Twice := i * 2;
END_FUNCTION
PROGRAM Main
VAR i : INT; a : Acc; t : TON; shared : INT; END_VAR
i := I + 1;
a(step := 2);
t(IN := TRUE, PT := T#1s);
g := Twice(i);
shared := g;
END_PROGRAM
`

/** the offset of the `n`th (from 0) whole-word `word` after `after` */
function at(source: string, word: string, after: string, n = 0): number {
  const re = new RegExp(`\\b${word}\\b`, 'g')
  re.lastIndex = source.indexOf(after)
  for (let k = 0; ; k++) {
    const m = re.exec(source)
    if (!m) throw new Error(`no ${word} after ${after}`)
    if (k === n) return m.index
  }
}

const image = (source: string): Record<string, unknown> => {
  const c = compile(runnableSource(source, defaultController(source, 10)))
  c.scan(0.01)
  return c.watch
}
const has = (watch: Record<string, unknown>, key: string): boolean => Object.keys(watch).some((k) => k.toUpperCase() === key.toUpperCase())

describe('watchScopes', () => {
  const scopes = watchScopes(SRC, watchInstances(SRC, defaultController(SRC, 10)))
  const watch = image(SRC)

  it("names a program's own variable by its instance, as the watch image keys it", () => {
    const key = scopes.keyAt(at(SRC, 'i', 'PROGRAM Main', 1), 'i')
    expect(key).toBe('Main.i')
    expect(has(watch, key!)).toBe(true)
  })

  it("matches a differently spelt name as IEC does, ignoring case", () => {
    const key = scopes.keyAt(at(SRC, 'I', 'i := I'), 'I')
    expect(key).toBe('Main.I')
    expect(has(watch, key!)).toBe(true)
  })

  it("names a standard block's member through the program's instance", () => {
    const key = scopes.keyAt(at(SRC, 't', 't(IN'), 't.Q')
    expect(key).toBe('Main.t.Q')
    expect(has(watch, key!)).toBe(true)
  })

  it("gives a function block's or a function's own variable nothing, never the program's variable of that name", () => {
    expect(scopes.keyAt(at(SRC, 'i', 'i := i + 1'), 'i')).toBeNull()
    expect(scopes.keyAt(at(SRC, 'i', 'Twice := i'), 'i')).toBeNull()
  })

  it('reads a name a POU does not declare as a global, keyed bare', () => {
    expect(scopes.keyAt(at(SRC, 'g', 'total := total'), 'g')).toBe('g')
    expect(scopes.keyAt(at(SRC, 'g', 'g := Twice'), 'g')).toBe('g')
    expect(has(watch, 'g')).toBe(true)
  })

  it("reads a program's own variable over a global it shadows", () => {
    expect(scopes.keyAt(at(SRC, 'shared', 'shared := g'), 'shared')).toBe('Main.shared')
  })

  it('names the code outside every POU by its bare names', () => {
    expect(scopes.keyAt(at(SRC, 'g', 'VAR_GLOBAL'), 'g')).toBe('g')
    const bare = 'VAR n : INT; END_VAR\nn := n + 1;\n'
    expect(watchScopes(bare, watchInstances(bare, defaultController(bare, 10))).keyAt(bare.lastIndexOf('n'), 'n')).toBe('n')
  })

  describe('a program that runs as several instances', () => {
    const lines = [
      { name: 'Line1', type: 'Main' },
      { name: 'Line2', type: 'Main' },
    ]
    const inMain = at(SRC, 'i', 'PROGRAM Main', 1)

    it('reads the first instance until one is picked, and says so', () => {
      const s = watchScopes(SRC, lines)
      expect(s.keyAt(inMain, 'i')).toBe('Line1.i')
      expect(s.shared).toEqual([{ type: 'Main', start: SRC.indexOf('PROGRAM Main'), instances: ['Line1', 'Line2'], monitored: 'Line1' }])
    })

    it('reads the picked instance, whatever case the pick is spelt in', () => {
      const s = watchScopes(SRC, lines, { MAIN: 'line2' })
      expect(s.keyAt(inMain, 'i')).toBe('Line2.i')
      expect(s.shared[0]!.monitored).toBe('Line2')
    })

    it('falls back to the first when the picked instance no longer runs', () => {
      expect(watchScopes(SRC, lines, { MAIN: 'Line9' }).keyAt(inMain, 'i')).toBe('Line1.i')
    })

    it('lists no program that runs as one instance', () => {
      expect(scopes.shared).toEqual([])
    })

    it('publishes those keys: each instance has its own variables in the watch image', () => {
      const controller = { tasks: [{ name: 'T', intervalMs: 10, priority: 1 }], programs: lines.map((l) => ({ ...l, task: 'T' })) }
      const c = compile(runnableSource(SRC, controller))
      c.scan(0.01)
      expect(has(c.watch, 'Line1.i') && has(c.watch, 'Line2.i')).toBe(true)
    })
  })

  it("takes the instances from the text's own CONFIGURATION when there is no controller table", () => {
    const cfg = `PROGRAM Merge
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Res ON PLC
    TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Line1 WITH Fast : Merge;
  END_RESOURCE
END_CONFIGURATION
`
    const key = watchScopes(cfg, watchInstances(cfg, null)).keyAt(cfg.indexOf('n := n') + 5, 'n')
    expect(key).toBe('Line1.n')
    const c = compile(cfg)
    c.scan(0.01)
    expect(has(c.watch, key!)).toBe(true)
  })
})
