// Live analog setpoints: what a running scene is commanding into a part's number params, which is what the
// Inspector shows in place of the authored value. Guards against a conveyor whose `speedTag` the program
// drives to 0.5 showing its authored `speed` of 1: a readout of a number the running scene isn't obeying,
// because the behavior reads the tag instead of the param.
//
// Resolution has to match sim/plcHost.interleave exactly (the variable image, by the param's tag), or the field
// would show a number that isn't the one the part read - a subtler version of the same bug.

import { beforeEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { PartInstance, SdkPart } from '../../core/types'
import type { TagValue } from '../../plc'
import type { EditorController } from '../controller'
import { globalTags, liveSetpoints } from './setpoints'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

const CONVEYOR = 'acme.conveyor'

function pkg(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: CONVEYOR,
    name: 'Conveyor', commsParam: 'enableComms', conveyor: { surface: 'roller', speedParam: 'speed' },
    params: {
      speed: { type: 'number', default: 1, min: -3, max: 3, step: 0.1, label: 'Speed (m/s)' },
      enableComms: { type: 'boolean', default: false, label: 'Enable comms' },
      speedTag: { type: 'tag', setpointFor: 'speed', default: '', label: 'Speed tag' },
      runTag: { type: 'tag', default: '', label: 'Run tag' },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } },
    ...over,
  }
}

function part(id: string, params: Record<string, unknown>, over: Partial<SdkPart> = {}): SdkPart {
  return { id, type: 'part', packageId: CONVEYOR, position: [0, 0, 0], rotationY: 0, params, ...over } as unknown as SdkPart
}

interface Stub {
  /** the program's variable image, or null for "no program attached" */
  watch?: Record<string, TagValue> | null
  /** keys the program declares as outputs (ctx.tagDriven) */
  drivenKeys?: string[]
  /** last frame's ctx.report values, by part id then param name */
  reported?: Record<string, Record<string, number | boolean>>
  running?: boolean
}

/** minimal controller stand-in: liveSetpoints only ever touches the run flag + the PLC-mirror fields */
function ec({ watch = null, drivenKeys = [], reported, running = true }: Stub = {}): EditorController {
  const stub = {
    store: { getState: () => ({ running }) },
    plcWatch: watch,
    plcDrivenKeys: new Set(drivenKeys),
    reportedValues: reported,
    get plcGlobalTags() {
      return globalTags(this as unknown as EditorController)
    },
  }
  return stub as unknown as EditorController
}

beforeEach(() => {
  clearPackages()
  registerPackage(pkg())
})

describe('liveSetpoints', () => {
  it('reports the tag value the program is driving, keyed by the param it replaces', () => {
    const parts: PartInstance[] = [part('c1', { speed: 1, enableComms: true, speedTag: 'Infeed' })]
    // the authored speed is 1; the program is commanding 0.5 - the field must read 0.5
    expect(liveSetpoints(ec({ watch: { Infeed: 0.5 }, drivenKeys: ['Infeed'] }), parts, 'c1')).toEqual({
      speed: { value: 0.5, tag: 'Infeed', driven: true },
    })
  })

  it('is null when nothing commands the part, so the authored param rules', () => {
    const bound = [part('c1', { speed: 1, enableComms: true, speedTag: 'Infeed' })]
    expect(liveSetpoints(ec({ watch: { Infeed: 0.5 }, running: false }), bound, 'c1')).toBeNull() // sim stopped
    // comms off, and comms on with no tag bound: the behavior reads ctx.params.speed in both cases
    expect(liveSetpoints(ec({ watch: { Infeed: 0.5 } }), [part('c1', { speed: 1, enableComms: false, speedTag: 'Infeed' })], 'c1')).toBeNull()
    expect(liveSetpoints(ec({ watch: { Infeed: 0.5 } }), [part('c1', { speed: 1, enableComms: true, speedTag: '' })], 'c1')).toBeNull()
  })

  it('reports 0 for a bound but undriven setpoint - the part really is stopped', () => {
    // ctx.readNumber of a tag nothing drives returns 0, so the conveyor sits still while the authored speed
    // says 1. Falling back to the authored value here would restate the very bug this fixes - and it holds
    // whether the attached program never declares the tag, or no program is attached at all.
    // `driven: false` is how the readout tells a commanded 0 apart from a nobody-home 0.
    const parts: PartInstance[] = [part('c1', { speed: 1, enableComms: true, speedTag: 'Infeed' })]
    const undeclared = { speed: { value: 0, tag: 'Infeed', driven: false } }
    expect(liveSetpoints(ec({ watch: { Other: 2 }, drivenKeys: ['Other'] }), parts, 'c1')).toEqual(undeclared)
    expect(liveSetpoints(ec({ watch: null }), parts, 'c1')).toEqual(undeclared) // no program at all
    // a program that does declare it and commands 0 reads the same number but is flagged driven
    expect(liveSetpoints(ec({ watch: { Infeed: 0 }, drivenKeys: ['Infeed'] }), parts, 'c1')).toEqual({
      speed: { value: 0, tag: 'Infeed', driven: true },
    })
  })

  it('ignores non-setpoint tags (a runTag gates, it does not replace a param)', () => {
    const parts: PartInstance[] = [part('c1', { speed: 1, enableComms: true, speedTag: '', runTag: 'Run' })]
    expect(liveSetpoints(ec({ watch: { Run: true }, drivenKeys: ['Run'] }), parts, 'c1')).toBeNull()
  })

  // A setpoint flagged autoWhenDriven follows the other script convention, `comms && tagDriven(tag) ?
  // readNumber(tag) : authored` (the stack light's bitmask), so undriven it must fall back, not report 0.
  // Reading it like a conveyor's speedTag would invent a value the part never used.
  it('an autoWhenDriven setpoint falls back to the authored param while undriven', () => {
    registerPackage(pkg({
      params: {
        value: { type: 'number', default: 3, min: 0, max: 255, step: 1, label: 'Value' },
        enableComms: { type: 'boolean', default: true, label: 'Enable comms' },
        tag: { type: 'tag', autoWhenDriven: true, setpointFor: 'value', default: '', label: 'PLC tag' },
      },
    }))
    const parts: PartInstance[] = [part('s1', { value: 3, enableComms: true, tag: 'Tower' })]
    expect(liveSetpoints(ec({ watch: { Other: 1 } }), parts, 's1')).toBeNull() // bound, nobody owns it
    expect(liveSetpoints(ec({ watch: { Tower: 6 }, drivenKeys: ['Tower'] }), parts, 's1')).toEqual({
      value: { value: 6, tag: 'Tower', driven: true },
    })
  })

  // The boolean twin: a hand-operable device's `useParam` latch, commanded through its autoWhenDriven tag.
  // The link is already in the schema (useParam + autoWhenDriven), so no second declaration is needed.
  describe('boolean command params (useParam)', () => {
    const blade = (over: Record<string, unknown> = {}) => {
      registerPackage(pkg({
        useParam: 'active',
        interactive: true,
        params: {
          active: { type: 'boolean', default: false, label: 'Active' },
          enableComms: { type: 'boolean', default: true, label: 'Enable comms' },
          tag: { type: 'tag', autoWhenDriven: true, default: '', label: 'PLC tag' },
        },
      }))
      return [part('b1', { active: false, enableComms: true, tag: 'Raise', ...over })] as PartInstance[]
    }

    it('reports the commanded state on the hand-state param while a program owns the tag', () => {
      const parts = blade()
      expect(liveSetpoints(ec({ watch: { Raise: true }, drivenKeys: ['Raise'] }), parts, 'b1')).toEqual({
        active: { value: true, tag: 'Raise', driven: true },
      })
    })

    it('leaves the authored latch alone whenever nothing owns the tag', () => {
      const parts = blade()
      // undriven (comms on, tag typed, no program declares it): the script's tagDriven gate hands the
      // device back to the operator, and release is bumpless, so the authored param is the correct readout
      expect(liveSetpoints(ec({ watch: { Raise: true } }), parts, 'b1')).toBeNull()
      expect(liveSetpoints(ec({ watch: null }), parts, 'b1')).toBeNull()
      // comms off, and no tag bound
      expect(liveSetpoints(ec({ watch: { Raise: true }, drivenKeys: ['Raise'] }), blade({ enableComms: false }), 'b1')).toBeNull()
      expect(liveSetpoints(ec({ watch: { Raise: true }, drivenKeys: ['Raise'] }), blade({ tag: '' }), 'b1')).toBeNull()
    })

    it('a driven tag on a part with no useParam owns nothing (a published/indicator tag)', () => {
      registerPackage(pkg({
        params: {
          active: { type: 'boolean', default: false, label: 'Active' },
          enableComms: { type: 'boolean', default: true, label: 'Enable comms' },
          tag: { type: 'tag', autoWhenDriven: true, default: '', label: 'PLC tag' },
        },
      }))
      const parts: PartInstance[] = [part('b1', { active: false, enableComms: true, tag: 'Raise' })]
      expect(liveSetpoints(ec({ watch: { Raise: true }, drivenKeys: ['Raise'] }), parts, 'b1')).toBeNull()
    })
  })

  // The whole point of ctx.report: the value comes from the behavior's own output, so it carries everything
  // a host-side replay of the comms convention structurally cannot see.
  describe('reported values (ctx.report) win over the tag read', () => {
    const parts = (): PartInstance[] => [part('c1', { speed: 1, enableComms: true, speedTag: 'Rate' })]

    it('shows the effective value even when it differs from the raw setpoint', () => {
      // the classic case the tag read gets wrong: the program commands 2.5 but holds runTag false, so the
      // belt is stopped. Re-derivation reads the setpoint (2.5) and is wrong; the behavior reports what it did.
      const controller = ec({ watch: { Rate: 2.5 }, drivenKeys: ['Rate'], reported: { c1: { speed: 0 } } })
      expect(liveSetpoints(controller, parts(), 'c1')).toEqual({ speed: { value: 0, tag: 'Rate', driven: true } })
    })

    it('carries a sign flip the tag alone cannot explain (a snap-reversed curve)', () => {
      const controller = ec({ watch: { Rate: 1.5 }, drivenKeys: ['Rate'], reported: { c1: { speed: -1.5 } } })
      expect(liveSetpoints(controller, parts(), 'c1')).toMatchObject({ speed: { value: -1.5 } })
    })

    it('falls back to the tag read for a part that has not adopted report', () => {
      const controller = ec({ watch: { Rate: 0.5 }, drivenKeys: ['Rate'], reported: { other: { speed: 9 } } })
      expect(liveSetpoints(controller, parts(), 'c1')).toEqual({ speed: { value: 0.5, tag: 'Rate', driven: true } })
    })

    it('never invents ownership - a reported param with no bound tag stays authored', () => {
      const loose: PartInstance[] = [part('c1', { speed: 1, enableComms: true, speedTag: '' })]
      expect(liveSetpoints(ec({ reported: { c1: { speed: 0.25 } } }), loose, 'c1')).toBeNull()
    })
  })

  it('is null for a non-SDK part or an unregistered package', () => {
    const parts: PartInstance[] = [part('c1', { speed: 1, enableComms: true, speedTag: 'Infeed' })]
    expect(liveSetpoints(ec({ watch: { Infeed: 0.5 } }), parts, 'nope')).toBeNull()
    clearPackages()
    expect(liveSetpoints(ec({ watch: { Infeed: 0.5 } }), parts, 'c1')).toBeNull()
  })
})

describe('globalTags', () => {
  it('is null without an attached program, and the variable image itself when there is one', () => {
    expect(globalTags(ec({ watch: null }))).toBeNull()
    const watch = { Infeed: 0.5 }
    expect(globalTags(ec({ watch }))).toBe(watch)
  })
})
