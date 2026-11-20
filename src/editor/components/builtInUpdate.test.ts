import { describe, expect, it } from 'vitest'
import { updateAllQuestion, updatesAvailableText } from './builtInUpdate'

describe('the part update prompt words', () => {
  it('counts the parts', () => {
    expect(updatesAvailableText(1)).toBe('1 part in this project has an update')
    expect(updatesAvailableText(3)).toBe('3 parts in this project have updates')
  })

  it('Update all says what changes, and names the parts that lose this project\'s own changes', () => {
    expect(updateAllQuestion(['Diverter'], [])).toBe('Update Diverter to its newer version? Every placed copy changes.')
    const q = updateAllQuestion(['Diverter', 'Belt Conveyor', 'Photo Eye'], ['Belt Conveyor'])
    expect(q).toContain('Update 3 parts')
    expect(q).toContain('Belt Conveyor was changed in this project, and those changes are discarded.')
    expect(updateAllQuestion(['A', 'B', 'C', 'D', 'E', 'F'], [])).toContain('A, B, C, D and 2 more')
  })
})
