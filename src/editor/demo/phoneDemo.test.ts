import { describe, expect, it } from 'vitest'
import { phoneOpensDemo, type PhoneDemoInputs } from './phoneDemo'

const empty = { scene: { parts: [{ type: 'building' }] }, stProgram: '' }
const base: PhoneDemoInputs = { phone: true, freshNavigation: true, stored: null, unopened: false }

describe('phoneOpensDemo', () => {
  it('opens the demo on a phone whose first visit would be blank', () => {
    expect(phoneOpensDemo(base)).toBe(true)
  })

  it('opens the demo over a stored project with nothing in it (the building is not work)', () => {
    expect(phoneOpensDemo({ ...base, stored: empty })).toBe(true)
  })

  it('never covers work: a part or a program is enough', () => {
    expect(phoneOpensDemo({ ...base, stored: { ...empty, scene: { parts: [{ type: 'building' }, { type: 'conveyor' }] } } })).toBe(false)
    expect(phoneOpensDemo({ ...base, stored: { ...empty, stProgram: 'PROGRAM Main END_PROGRAM' } })).toBe(false)
  })

  it('leaves desktops and tablets on their blank scene', () => {
    expect(phoneOpensDemo({ ...base, phone: false })).toBe(false)
  })

  it('respects a deliberate reload into an empty project (opening or creating one reloads)', () => {
    expect(phoneOpensDemo({ ...base, stored: empty, freshNavigation: false })).toBe(false)
  })

  it('leaves the boot alone while a stored project could not be opened', () => {
    expect(phoneOpensDemo({ ...base, unopened: true })).toBe(false)
  })
})
