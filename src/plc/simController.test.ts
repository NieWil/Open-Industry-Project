import { describe, expect, it } from 'vitest'
import { LocalPlcLink } from './link/plcLink'
import { SimController } from './simController'

// The declarative device bindings (sensor/button/gate inputs, stack-light outputs) are gone with the
// built-in parts that used them. The only device IO left is the device-IO tag bridge: custom-part behaviors
// supply program inputs by name via setExternalInputs, and the controller ships the resulting %Q back.

describe('external inputs (custom-part tag writes folded into the scan)', () => {
  it('feeds setExternalInputs tags to the program each scan', () => {
    // Echo mirrors an INT input + a BOOL input - both supplied externally (the custom-part device-IO path).
    const link = new LocalPlcLink('VAR_INPUT Cmd : INT; Done : BOOL; END_VAR VAR_OUTPUT EchoCmd : INT; EchoDone : BOOL; END_VAR\nEchoCmd := Cmd;\nEchoDone := Done;')
    const ctrl = new SimController(link)
    ctrl.setExternalInputs({ Cmd: 7, Done: true })
    const piq = ctrl.tick(0.01)
    expect(piq.EchoCmd).toBe(7)
    expect(piq.EchoDone).toBe(true)
    ctrl.setExternalInputs({ Cmd: 0, Done: false })
    expect(ctrl.tick(0.01).EchoDone).toBe(false)
  })
})

describe('SimController process image', () => {
  it('latches %I from the external inputs and records the scanned %Q', () => {
    const link = new LocalPlcLink('VAR_INPUT clear : BOOL; END_VAR VAR_OUTPUT run : BOOL; END_VAR\nrun := clear;')
    const ctrl = new SimController(link)
    ctrl.setExternalInputs({ clear: true })

    const pii = ctrl.sampleInputs()
    expect(pii).toEqual({ clear: true })

    const piq = ctrl.scan(pii, 0.1)
    expect(piq.run).toBe(true)
    expect(ctrl.processImage).toEqual({ inputs: { clear: true }, outputs: { run: true } })
  })

  it('keeps an INT input un-coerced through the process image', () => {
    const link = new LocalPlcLink('VAR_INPUT col : INT; END_VAR VAR_OUTPUT run : BOOL; END_VAR\nrun := col = 2;')
    const ctrl = new SimController(link)
    ctrl.setExternalInputs({ col: 1 })
    expect(ctrl.tick(0.1).run).toBe(false)
    ctrl.setExternalInputs({ col: 2 })
    expect(ctrl.tick(0.1).run).toBe(true)
    expect(ctrl.processImage.inputs).toEqual({ col: 2 })
  })
})
