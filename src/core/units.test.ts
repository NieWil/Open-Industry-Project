import { describe, expect, it } from 'vitest'
import { convertUnit, defaultTranslateSnap, displayUnitFor, displayUnits, formatLength, formatSpeed, lengthUnitOf, niceStep, toStored, unitView } from './units'

const metric = displayUnits('metric')
const imperial = displayUnits('imperial')
const metricMm = displayUnits('metric', 'mm')

describe('displayUnitFor', () => {
  it('with no Length, shows every length in metres, or inches under imperial, whatever unit it is stored in', () => {
    expect(displayUnitFor('m', metric)).toBe('m')
    expect(displayUnitFor('mm', metric)).toBe('m')
    expect(displayUnitFor('in', metric)).toBe('m')
    expect(displayUnitFor('in', imperial)).toBe('in')
    expect(displayUnitFor('ft', imperial)).toBe('in')
    expect(displayUnitFor('m', imperial)).toBe('in')
    expect(lengthUnitOf(metric)).toBe('m')
    expect(lengthUnitOf(imperial)).toBe('in')
    expect(unitView('mm', metric)).toEqual(unitView('mm', displayUnits('metric', 'm')))
  })

  it('shows a speed of the system as itself, and one of the other system in this one', () => {
    expect(displayUnitFor('m/s', metric)).toBe('m/s')
    expect(displayUnitFor('FPM', imperial)).toBe('FPM')
    expect(displayUnitFor('m/s', imperial)).toBe('FPM')
    expect(displayUnitFor('FPM', metric)).toBe('m/s')
  })

  it('shows every length in the Length when one is set, and speeds by the Units', () => {
    expect(displayUnitFor('m', metricMm)).toBe('mm')
    expect(displayUnitFor('cm', metricMm)).toBe('mm')
    expect(displayUnitFor('in', metricMm)).toBe('mm')
    expect(displayUnitFor('m/s', metricMm)).toBe('m/s')
    expect(displayUnitFor('FPM', metricMm)).toBe('m/s')
    const v = unitView('m', metricMm)
    expect(v).toEqual({ unit: 'mm', k: 1000, decimals: 1 })
    expect(toStored(35, v.k)).toBe(0.035)
  })

  it('takes a Length of the other system: inches in a metric scene, millimetres in an imperial one', () => {
    const metricIn = displayUnits('metric', 'in')
    expect(displayUnitFor('m', metricIn)).toBe('in')
    expect(displayUnitFor('ft', metricIn)).toBe('in')
    expect(displayUnitFor('m/s', metricIn)).toBe('m/s')
    const imperialMm = displayUnits('imperial', 'mm')
    expect(displayUnitFor('in', imperialMm)).toBe('mm')
    expect(displayUnitFor('m/s', imperialMm)).toBe('FPM')
    expect(unitView('m', displayUnits('metric', 'm'))).toEqual({ unit: 'm', k: 1 })
    expect(unitView('mm', displayUnits('metric', 'm'))).toEqual({ unit: 'm', k: 0.001, decimals: 3 })
  })

  it('returns one shared object per Units and Length, so === compares them', () => {
    expect(displayUnits('metric', 'mm')).toBe(metricMm)
    expect(displayUnits('metric', undefined)).toBe(metric)
    expect(displayUnits('imperial', 'mm')).not.toBe(metricMm)
  })

  it('never touches a unit that is not a length or a speed', () => {
    for (const u of ['°', 's', '%', 'kg', 'Hz', '']) {
      expect(displayUnitFor(u, imperial)).toBe(u)
      expect(unitView(u, imperial).k).toBe(1)
    }
  })
})

describe('unitView / toStored', () => {
  it('a metre field under imperial reads inches and writes metres back without float dust', () => {
    const v = unitView('m', imperial)
    expect(v.unit).toBe('in')
    expect(0.6096 * v.k).toBeCloseTo(24, 9)
    expect(toStored(24, v.k)).toBe(0.6096)
  })

  it('an FPM field under metric reads m/s, and 2 m/s goes back as FPM for the part to round', () => {
    const v = unitView('FPM', metric)
    expect(v.unit).toBe('m/s')
    expect(394 * v.k).toBeCloseTo(2.00152, 9)
    expect(toStored(2, v.k)).toBeCloseTo(393.7008, 3)
  })

  it('a field already in the viewer system is not converted at all', () => {
    expect(unitView('m', metric)).toEqual({ unit: 'm', k: 1 })
    expect(unitView('FPM', imperial)).toEqual({ unit: 'FPM', k: 1 })
  })
})

describe('convertUnit', () => {
  it('converts within a table and leaves anything else alone', () => {
    expect(convertUnit(1, 'ft', 'in')).toBeCloseTo(12, 9)
    expect(convertUnit(1, 'm', 'mm')).toBeCloseTo(1000, 9)
    expect(convertUnit(5, 'm', 'm/s')).toBe(5)
    expect(convertUnit(5, 'kg', 'g')).toBe(5)
  })
})

describe('niceStep', () => {
  it('rounds a converted step to 1-2-5', () => {
    expect(niceStep(0.3937)).toBe(0.5)
    expect(niceStep(19.685)).toBe(20)
    expect(niceStep(0.00508)).toBe(0.005)
    expect(niceStep(1)).toBe(1)
  })
})

describe('formatLength', () => {
  it('reads metres to the millimetre, or feet and inches', () => {
    expect(formatLength(1.2192, metric)).toBe('1.219 m')
    expect(formatLength(1.2192, imperial)).toBe(`4' 0.00"`)
    expect(formatLength(0.1524, imperial)).toBe('6.00"')
    expect(formatLength(3.7465, imperial)).toBe(`12' 3.50"`)
    expect(formatLength(0, imperial)).toBe('0.00"')
    expect(formatLength(0.0355, metricMm)).toBe('35.5 mm')
  })
})

describe('formatSpeed', () => {
  it('reads m/s (two decimals under 1), or whole feet per minute', () => {
    expect(formatSpeed(5, metric)).toBe('5.0 m/s')
    expect(formatSpeed(0.2, metric)).toBe('0.20 m/s')
    expect(formatSpeed(5, imperial)).toBe('984 FPM')
    expect(formatSpeed(5, metricMm)).toBe('5.0 m/s')
  })
})

describe('defaultTranslateSnap', () => {
  it('is 1 m, or 1 ft when lengths show in inches', () => {
    expect(defaultTranslateSnap(metric)).toBe(1)
    expect(defaultTranslateSnap(imperial)).toBe(0.3048)
    expect(defaultTranslateSnap(displayUnits('imperial', 'mm'))).toBe(1)
    expect(defaultTranslateSnap(displayUnits('metric', 'in'))).toBe(0.3048)
  })
})
