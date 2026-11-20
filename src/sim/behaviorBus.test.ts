import { describe, expect, it } from 'vitest'
import { BehaviorBus } from './behaviorBus'

// Two writers fill the tag table parts read: the program in the worker, each scan, and the links to PLCs outside
// the app, from the main thread. With several controllers a run has both (`Cell2::...` tags, core/io/controllerTag.ts),
// and neither may wipe the other's values.
describe("the parts' input tags", () => {
  it("keep the program's outputs and the links' side by side", () => {
    const bus = new BehaviorBus()
    bus.setInputTags({ Run1: true })
    bus.setLinkTags({ 'Cell2::%QX100.0': true })
    expect(bus.tags).toEqual({ Run1: true, 'Cell2::%QX100.0': true })
    // the program's next scan replaces its own layer only
    bus.setInputTags({ Run1: false })
    expect(bus.tags).toEqual({ Run1: false, 'Cell2::%QX100.0': true })
    bus.setLinkTags({ 'Cell2::%QX100.0': false })
    expect(bus.tags).toEqual({ Run1: false, 'Cell2::%QX100.0': false })
  })

  it('hand behaviors one layer as it is when the other is empty, and keep the table on a push that changes nothing', () => {
    const bus = new BehaviorBus()
    const program = { Run1: true }
    bus.setInputTags(program)
    expect(bus.tags).toBe(program)
    bus.setInputTags({ Run1: true })
    expect(bus.tags).toBe(program)
    const links = { '%QX0.0': true }
    const only = new BehaviorBus()
    only.setLinkTags(links)
    expect(only.tags).toBe(links)
  })
})
