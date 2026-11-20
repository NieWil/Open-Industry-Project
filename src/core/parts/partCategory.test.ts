import { describe, expect, it } from 'vitest'
import { categoryOrder, nearCategory, packageCategory, sameCategory } from './partCategory'

describe('a part names its category', () => {
  it('matches a standard category whatever its case, and keeps any other name as a category of its own', () => {
    expect(packageCategory({ category: 'devices' })).toBe('Devices')
    expect(packageCategory({ category: '  Lift Tables ' })).toBe('Lift Tables')
    expect(packageCategory({ category: '' })).toBe('Equipment')
    expect(packageCategory({})).toBe('Equipment')
    expect(packageCategory(undefined)).toBe('Equipment')
  })

  it('orders the tabs: the standard four first, then the rest alphabetically, one per name whatever its case', () => {
    expect(categoryOrder(['Robots', 'Structure', 'robots', 'Equipment', 'Aisles', 'Devices'])).toEqual(['Equipment', 'Devices', 'Structure', 'Aisles', 'Robots'])
    expect(sameCategory('Robots', ' robots')).toBe(true)
  })

  it('names the known category a new one is probably a misspelling of, and leaves real names alone', () => {
    const known = ['Equipment', 'Devices', 'Products', 'Structure']
    expect(nearCategory('Device', known)).toBe('Devices')
    expect(nearCategory('Strcture', known)).toBe('Structure')
    expect(nearCategory('devices', known)).toBeUndefined()
    expect(nearCategory('Robots', known)).toBeUndefined()
    expect(nearCategory('Lift Tables', known)).toBeUndefined()
    // a short name: one letter is too large a share of it to call it a typo
    expect(nearCategory('AGVs', ['AGV'])).toBeUndefined()
  })
})
