import { describe, expect, it } from 'vitest'
import { declaredTypeSets, typeOfKey } from './plcValueText'

const SOURCE = `TYPE MotorData : STRUCT
  Running : BOOL;
END_STRUCT
END_TYPE
PROGRAM Main
VAR
  Go : BOOL;
  Status : WORD;
  Fill : TON;
  Bins : ARRAY[1..3] OF INT;
  Motor : MotorData;
  Count : DINT;
  Speed : REAL;
END_VAR
Count := Count + 1;
END_PROGRAM
PROGRAM Other
VAR
  Speed : INT;
END_VAR
Speed := 1;
END_PROGRAM
`

describe('typeOfKey', () => {
  const types = declaredTypeSets(SOURCE)

  it('reads a declared name, an element, a bit and a timer member', () => {
    expect(typeOfKey(types, 'go')).toBe('BOOL')
    expect(typeOfKey(types, 'Bins[2]')).toBe('INT')
    expect(typeOfKey(types, 'Status.3')).toBe('BOOL')
    expect(typeOfKey(types, 'Fill.ET')).toBe('TIME')
    expect(typeOfKey(types, 'Fill.Q')).toBe('BOOL')
  })

  it('reads a variable under its program instance', () => {
    expect(typeOfKey(types, 'Line.Count')).toBe('DINT')
  })

  it('says nothing where the declarations do not', () => {
    // two POUs declare Speed with different types
    expect(typeOfKey(types, 'Line.Speed')).toBeUndefined()
    // a structure's member is not the variable of the same name elsewhere
    expect(typeOfKey(types, 'Motor.Count')).toBeUndefined()
    expect(typeOfKey(types, 'Nope')).toBeUndefined()
  })
})
