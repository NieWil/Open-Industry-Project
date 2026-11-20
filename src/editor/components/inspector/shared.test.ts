import { describe, expect, it } from 'vitest'
import { decimalsForStep, evalNumeric, gridDecimals, parseOffset, shiftFoldsAfterRemove, snapToStep, titleCase } from './shared'

describe('titleCase', () => {
  it('capitalises each word of the name', () => {
    expect(titleCase('stand height')).toBe('Stand Height')
    expect(titleCase('PLC speed in FPM')).toBe('PLC Speed In FPM')
  })

  it('keeps a trailing bracket as written: a unit or an explanation, not part of the name', () => {
    expect(titleCase('Speed tag (m/s)')).toBe('Speed Tag (m/s)')
    expect(titleCase('Average cycle time tag (s)')).toBe('Average Cycle Time Tag (s)')
    expect(titleCase('Run tag (belt runs while true)')).toBe('Run Tag (belt runs while true)')
  })

  it('title-cases a bracket inside the name, since only a trailing one is kept', () => {
    expect(titleCase('move to X/Y/Z (gantry) slowly')).toBe('Move To X/Y/Z (Gantry) Slowly')
  })
})

describe('parseOffset', () => {
  it('reads += and -= as an offset, converting units like a value', () => {
    expect(parseOffset('+= 1.2', 'm')).toBe(1.2)
    expect(parseOffset('-=600mm', 'm')).toBeCloseTo(-0.6, 12)
    expect(parseOffset(' += 2*45', '')).toBe(90)
  })

  it('leaves a signed plain value absolute', () => {
    expect(parseOffset('-5', 'm')).toBeUndefined()
    expect(parseOffset('+5', 'm')).toBeUndefined()
    expect(parseOffset('5', 'm')).toBeUndefined()
  })

  it('is null when the amount does not parse', () => {
    expect(parseOffset('+=', 'm')).toBeNull()
    expect(parseOffset('-= 2 3', 'm')).toBeNull()
  })
})

describe('decimalsForStep', () => {
  it('matches the step', () => {
    expect(decimalsForStep(1)).toBe(0)
    expect(decimalsForStep(15)).toBe(0)
    expect(decimalsForStep(0.1)).toBe(1)
    expect(decimalsForStep(0.25)).toBe(2)
    expect(decimalsForStep(0.005)).toBe(3)
  })

  it('reads a step that prints in exponent form', () => {
    // (1e-7).toString() is "1e-7": parsing the string found no '.' and showed whole numbers
    expect(decimalsForStep(1e-7)).toBe(7)
  })

  it('treats a missing or broken step as whole numbers', () => {
    expect(decimalsForStep(0)).toBe(0)
    expect(decimalsForStep(-0.1)).toBe(0)
    expect(decimalsForStep(Number.NaN)).toBe(0)
  })
})

describe('snapToStep', () => {
  it('lands on the grid without float noise', () => {
    // Math.round(1.2 / 0.1) * 0.1 is 1.2000000000000002, which must not be stored
    expect(snapToStep(1.1 + 0.1, 0.1)).toBe(1.2)
    expect(snapToStep(0.7, 0.1)).toBe(0.7)
    expect(snapToStep(0.015, 0.005)).toBe(0.015)
  })

  it('rounds to the nearest step', () => {
    expect(snapToStep(1.25, 0.1)).toBe(1.3)
    expect(snapToStep(22, 15)).toBe(15)
    expect(snapToStep(23, 15)).toBe(30)
  })
})

describe('gridDecimals', () => {
  it('uses the step when every value fits it', () => {
    expect(gridDecimals([[4, 0]], 1)).toBe(0)
    expect(gridDecimals([[0.5, 1]], 0.1)).toBe(1)
  })

  it('widens to show host-written precision, for the whole table', () => {
    expect(gridDecimals([[4, 0], [2.125, 0]], 1)).toBe(3)
  })

  it('caps the width so noise cannot blow it up', () => {
    expect(gridDecimals([[1 / 3]], undefined)).toBe(4)
  })
})

describe('evalNumeric', () => {
  it('parses plain numbers and simple arithmetic', () => {
    expect(evalNumeric('1.5', '')).toBe(1.5)
    expect(evalNumeric('2*0.75', '')).toBe(1.5)
    expect(evalNumeric('(1+2)/4', '')).toBe(0.75)
    expect(evalNumeric('1e3', '')).toBe(1000)
    expect(evalNumeric('-3', '')).toBe(-3)
  })

  it('strips the field unit', () => {
    expect(evalNumeric('1.5 m', 'm')).toBe(1.5)
    expect(evalNumeric('90°', '°')).toBe(90)
  })

  it('reads a number followed by an unknown unit', () => {
    expect(evalNumeric('1.5 m/s', '')).toBe(1.5)
  })

  it('reads a comma between digits as the decimal point', () => {
    expect(evalNumeric('1,5', '')).toBe(1.5)
    expect(evalNumeric('0,75 m', 'm')).toBe(0.75)
    expect(evalNumeric('2*0,5', '')).toBe(1)
    expect(evalNumeric('1,25', '')).toBe(1.25)
    expect(evalNumeric('1,2345', '')).toBe(1.2345)
  })

  it('reads a comma decimal in another unit too', () => {
    expect(evalNumeric('2,5ft', 'm')).toBeCloseTo(0.762, 6)
  })

  it('reads three decimals after a comma when it cannot be a thousands separator', () => {
    // millimetre precision in a metre field
    expect(evalNumeric('0,125', 'm')).toBe(0.125)
    expect(evalNumeric('0,500 m', 'm')).toBe(0.5)
    expect(evalNumeric('-0,125', '')).toBe(-0.125)
    expect(evalNumeric('2*0,125', '')).toBe(0.25)
    // a thousands group has at most three digits before its comma
    expect(evalNumeric('1234,567', '')).toBe(1234.567)
  })

  it('rejects a comma that could be a thousands separator, or one standing alone', () => {
    expect(evalNumeric('1,500', '')).toBeNull()
    expect(evalNumeric('12,500', '')).toBeNull()
    expect(evalNumeric('1,000,000', '')).toBeNull()
    expect(evalNumeric('2*1,500', '')).toBeNull()
    expect(evalNumeric('0,125 1,500', '')).toBeNull()
    expect(evalNumeric('1,500.5', '')).toBeNull()
    expect(evalNumeric('1,', '')).toBeNull()
    expect(evalNumeric(',5', '')).toBeNull()
  })

  it('rejects malformed arithmetic instead of half-reading it', () => {
    // parseFloat would half-read each and commit a number the user never meant
    expect(evalNumeric('2 3', '')).toBeNull()
    expect(evalNumeric('5%', '')).toBeNull()
    expect(evalNumeric('1/0', '')).toBeNull()
    expect(evalNumeric('2e', '')).toBeNull()
    expect(evalNumeric('--2', '')).toBeNull()
  })

  it('returns null for empty or non-numeric text', () => {
    expect(evalNumeric('', '')).toBeNull()
    expect(evalNumeric('   ', '')).toBeNull()
    expect(evalNumeric('abc', '')).toBeNull()
  })
})

describe('evalNumeric - typed units convert into the field unit', () => {
  it('reads feet, inches and millimetres into a metre field', () => {
    expect(evalNumeric('5ft', 'm')).toBeCloseTo(1.524, 9)
    expect(evalNumeric('60 in', 'm')).toBeCloseTo(1.524, 9)
    expect(evalNumeric(`5' 6"`, 'm')).toBeCloseTo(1.6764, 9)
    expect(evalNumeric('5ft 6in', 'm')).toBeCloseTo(1.6764, 9)
    // before the suffix strip, which would have read this as 600 m
    expect(evalNumeric('600mm', 'm')).toBeCloseTo(0.6, 9)
    expect(evalNumeric('-2 ft', 'm')).toBeCloseTo(-0.6096, 9)
  })

  it('converts between m/s and feet per minute either way', () => {
    expect(evalNumeric('394 fpm', 'm/s')).toBeCloseTo(2.00152, 9)
    expect(evalNumeric('2 m/s', 'FPM')).toBeCloseTo(393.7008, 3)
  })

  it('leaves the rest to the old rules', () => {
    expect(evalNumeric('2*0.75', 'm')).toBe(1.5) // an expression is not a unit term
    expect(evalNumeric('1.5 m', 'm')).toBe(1.5)
    expect(evalNumeric('5 kg', 'm')).toBe(5) // another dimension: read as before, not converted
    expect(evalNumeric('5ft', '')).toBe(5) // a field with no unit converts nothing
    expect(evalNumeric('5ft', 'kg')).toBe(5)
  })
})

describe('shiftFoldsAfterRemove', () => {
  it("drops the removed row's state and moves every later row's state down one", () => {
    // rows 0..3, with row 1 folded and row 3 folded: remove row 1
    expect(shiftFoldsAfterRemove({ 1: false, 3: false }, 1)).toEqual({ 2: false })
    // removing row 0 shifts row 2's state to row 1, so it stays with its row
    expect(shiftFoldsAfterRemove({ 0: true, 2: false }, 0)).toEqual({ 1: false })
  })

  it('leaves the rows before the removed one alone', () => {
    expect(shiftFoldsAfterRemove({ 0: false, 1: true }, 5)).toEqual({ 0: false, 1: true })
  })
})
