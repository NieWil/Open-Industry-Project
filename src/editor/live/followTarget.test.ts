import { describe, expect, it } from 'vitest'
import { followTarget, type FollowInputs } from './followTarget'

const base: FollowInputs = { self: 1, running: false, readOnly: false, picked: null, owner: 9, spotlight: false, dismissed: false, runners: [] }
const run = (id: number, stream = `s${id}`) => ({ id, name: `p${id}`, stream })

describe('whose run this client draws', () => {
  it('an editor follows nobody unless they pick someone', () => {
    expect(followTarget({ ...base, runners: [run(9), run(2)] })).toBeNull()
    expect(followTarget({ ...base, picked: 2, runners: [run(9), run(2)] })).toEqual({ who: 2, stream: 's2', why: 'picked' })
  })

  it('someone picked who is not running yet is waited for', () => {
    expect(followTarget({ ...base, picked: 2 })).toEqual({ who: 2, stream: null, why: 'picked' })
  })

  it('running one\'s own copy draws nothing else, whatever was picked or spotlit', () => {
    expect(followTarget({ ...base, running: true, picked: 2, spotlight: true, runners: [run(2), run(9)] })).toBeNull()
  })

  it("the owner's spotlight is followed by everyone until dismissed; a pick still wins", () => {
    const lit = { ...base, spotlight: true, runners: [run(9), run(2)] }
    expect(followTarget(lit)).toEqual({ who: 9, stream: 's9', why: 'spotlight' })
    expect(followTarget({ ...lit, dismissed: true })).toBeNull()
    expect(followTarget({ ...lit, picked: 2 })).toEqual({ who: 2, stream: 's2', why: 'picked' })
    // the owner does not follow itself
    expect(followTarget({ ...lit, self: 9 })).toBeNull()
  })

  it("a view link stays with the owner while the owner is here, never jumping to someone else's run", () => {
    const view = { ...base, readOnly: true }
    expect(followTarget({ ...view, runners: [run(2), run(9)] })).toEqual({ who: 9, stream: 's9', why: 'view' })
    // the owner between runs: the display waits for them rather than showing an editor's test run
    expect(followTarget({ ...view, runners: [run(2)] })).toEqual({ who: 9, stream: null, why: 'view' })
    expect(followTarget({ ...view, runners: [run(2), run(3)] })).toEqual({ who: 9, stream: null, why: 'view' })
  })

  it('with no owner here, a view link follows the only run going, and otherwise nobody', () => {
    const view = { ...base, readOnly: true, owner: null }
    expect(followTarget({ ...view, runners: [run(2)] })).toEqual({ who: 2, stream: 's2', why: 'view' })
    expect(followTarget({ ...view, runners: [run(2), run(3)] })).toBeNull()
    expect(followTarget(view)).toBeNull()
  })
})
