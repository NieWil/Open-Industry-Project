import { describe, it, expect } from 'vitest'
import type { PlcLink } from './plcLink'
import { SoftPlc, serveSoftPlc } from '../softPlc'
import { WsPlcLink } from './wsPlcLink'
import { createChannelPair } from './wsPlcProtocol'

const PASSTHROUGH = 'VAR_INPUT Start : BOOL; END_VAR VAR_OUTPUT Run : BOOL; END_VAR\nRun := Start;'
const COUNTER =
  'VAR_INPUT En : BOOL; END_VAR VAR_OUTPUT N : INT; END_VAR VAR c : INT; END_VAR\n' +
  'IF En THEN c := c + 1; END_IF;\nN := c;'

describe('SoftPlc (the soft-PLC core, no transport)', () => {
  it('runs the ST program by tag name and keeps VAR state across scans', () => {
    const plc = new SoftPlc(COUNTER)
    expect(plc.meta()).toEqual({ t: 'meta', inputs: ['En'], outputs: ['N'] })
    plc.step({ En: true }, 0.01)
    plc.step({ En: false }, 0.01) // disabled scan: counter holds
    const out = plc.step({ En: true }, 0.01)
    expect(out.v).toEqual({ N: 2 })
    expect(out.watch.c).toBe(2)
  })
})

describe('WsPlcLink <-> SoftPlc over a channel (the WsPlcLink seam)', () => {
  it('is a drop-in PlcLink and relays the program surface + outputs', () => {
    const [simSide, plcSide] = createChannelPair()
    const link: PlcLink = new WsPlcLink(simSide) // typed as PlcLink: drops into SimController
    serveSoftPlc(new SoftPlc(PASSTHROUGH), plcSide)

    // `meta` arrives on connect
    expect(link.inputs).toEqual(['Start'])
    expect(link.outputs).toEqual(['Run'])

    // the program executes on the server; the sim sees its outputs
    expect(link.step({ Start: true }, 0.01)).toEqual({ Run: true })
    expect(link.step({ Start: false }, 0.01)).toEqual({ Run: false })
  })

  it('drives a stateful counter program across ticks', () => {
    const [simSide, plcSide] = createChannelPair()
    const link = new WsPlcLink(simSide)
    serveSoftPlc(new SoftPlc(COUNTER), plcSide)

    link.step({ En: true }, 0.01)
    link.step({ En: true }, 0.01)
    expect(link.step({ En: true }, 0.01)).toEqual({ N: 3 })
    expect(link.watch.c).toBe(3)
  })

  it('returns no outputs before the first server reply', () => {
    const [simSide] = createChannelPair()
    const link = new WsPlcLink(simSide) // never served
    expect(link.step({ Start: true }, 0.01)).toEqual({})
    expect(link.outputs).toEqual([])
  })
})
