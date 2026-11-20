// WsPlcLink: the simulation-side backend of the PlcLink seam (plc/link/plcLink.ts). Instead of running
// an ST program in-process (LocalPlcLink), it relays tags to a soft-PLC over a Channel - so the
// same sim/bindings code can be driven by the web's ST engine running elsewhere (e.g. serving an
// external native sim), with no change to SimController or the bindings layer.
//
// Network semantics: step() sends the inputs and returns the last outputs received from the server
// (eventually-consistent, like a polled fieldbus). Over an in-memory channel that's same-tick; over
// a real WebSocket the outputs land a tick or two later, which is the expected soft-PLC behaviour.

import type { PlcLink } from './plcLink'
import type { TagValue } from '../types'
import type { Channel } from './wsPlcProtocol'
import { decode, encode } from './wsPlcProtocol'

export class WsPlcLink implements PlcLink {
  #inputs: string[] = []
  #outputs: string[] = []
  #watch: Record<string, TagValue> = {}
  #lastOut: Record<string, TagValue> = {}
  #error: string | null = null

  constructor(private readonly ch: Channel) {
    ch.onMessage((data) => {
      const msg = decode(data)
      if (msg.t === 'meta') {
        this.#inputs = msg.inputs
        this.#outputs = msg.outputs
      } else if (msg.t === 'out') {
        this.#lastOut = msg.v
        this.#watch = msg.watch
      } else if (msg.t === 'err') {
        this.#error = msg.message
      }
    })
  }

  get inputs(): string[] {
    return this.#inputs
  }
  get outputs(): string[] {
    return this.#outputs
  }
  get watch(): Readonly<Record<string, TagValue>> {
    return this.#watch
  }
  /** The latest server-reported compile/scan error, or null. */
  get error(): string | null {
    return this.#error
  }

  step(inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue> {
    this.ch.send(encode({ t: 'in', v: { ...inputs }, dt }))
    return this.#lastOut
  }
}
