// A scan's output table (LocalPlcLink): built again only when an output changed, and then exactly what a table built
// after every scan would hold.
import { describe, expect, it } from 'vitest'
import { LocalPlcLink } from './plcLink'

const PROGRAM = `
PROGRAM Main
VAR_INPUT
  Go : BOOL;
  X : REAL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
  Y : REAL;
  N : INT;
END_VAR
Run := Go;
Y := X;
IF Go THEN N := N + 1; END_IF;
END_PROGRAM
`

const DT = 0.01

describe('the output table of a scan', () => {
  it('is the same table while no output changes, and a new one when one does', () => {
    const link = new LocalPlcLink(PROGRAM)
    const a = link.step({ Go: false, X: 1.5 }, DT)
    expect(a).toEqual({ Run: false, Y: 1.5, N: 0 })
    const b = link.step({ Go: false, X: 1.5 }, DT)
    expect(b).toBe(a)
    const c = link.step({ Go: false, X: 2.5 }, DT)
    expect(c).not.toBe(a)
    expect(c).toEqual({ Run: false, Y: 2.5, N: 0 })
    // the table handed out before is not written: it still reads as it did
    expect(a).toEqual({ Run: false, Y: 1.5, N: 0 })
  })

  it('holds what the program holds after every scan, through outputs that change every scan', () => {
    const link = new LocalPlcLink(PROGRAM)
    let last: Record<string, unknown> | null = null
    for (let i = 1; i <= 20; i++) {
      const t = link.step({ Go: true, X: i % 3 }, DT)
      expect(t).toEqual({ Run: true, Y: i % 3, N: i })
      expect(t).not.toBe(last)
      last = t
    }
    const stopped = link.step({ Go: false, X: 2 }, DT)
    expect(stopped).toEqual({ Run: false, Y: 2, N: 20 })
    expect(link.step({ Go: false, X: 2 }, DT)).toBe(stopped)
  })

  it('tells 0 from -0, and takes a NaN that stays a NaN as no change', () => {
    const link = new LocalPlcLink(PROGRAM)
    const zero = link.step({ Go: false, X: 0 }, DT)
    expect(Object.is(zero.Y, 0)).toBe(true)
    const negative = link.step({ Go: false, X: -0 }, DT)
    expect(Object.is(negative.Y, -0)).toBe(true)
    expect(negative).not.toBe(zero)
    const nan = link.step({ Go: false, X: NaN }, DT)
    expect(Number.isNaN(nan.Y)).toBe(true)
    expect(link.step({ Go: false, X: NaN }, DT)).toBe(nan)
  })

  it('is frozen, so a caller cannot write the table the next scan hands back', () => {
    const link = new LocalPlcLink(PROGRAM)
    const t = link.step({ Go: false, X: 1 }, DT)
    expect(Object.isFrozen(t)).toBe(true)
    expect(() => {
      ;(t as Record<string, unknown>).Run = true
    }).toThrow()
    expect(link.step({ Go: false, X: 1 }, DT)).toEqual({ Run: false, Y: 1, N: 0 })
  })

  it('is built again after the link is bound again', () => {
    const link = new LocalPlcLink(PROGRAM)
    const a = link.step({ Go: false, X: 1 }, DT)
    link.bind({ inputs: [], outputs: [] })
    const b = link.step({ Go: false, X: 1 }, DT)
    expect(b).not.toBe(a)
    expect(b).toEqual(a)
  })
})
