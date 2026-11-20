// SoftPlc: the web's Structured Text engine wrapped as a tag-named "soft PLC" that an external
// simulation reaches over a Channel (WsPlcLink). It owns the program and runs one scan per `in`
// message, replying with the program's outputs. No scene/device knowledge - purely tag-in/tag-out.
//
// This is the server half of the WsPlcLink seam (plc/link/plcLink.ts). The client half - the thing a
// simulation talks to as a `PlcLink` - is plc/link/wsPlcLink.ts.

import { LocalPlcLink } from './link/plcLink'
import type { TagValue } from './types'
import type { Channel, MetaMsg, OutMsg, WsPlcMsg } from './link/wsPlcProtocol'
import { decode, encode } from './link/wsPlcProtocol'

export class SoftPlc {
  private link: LocalPlcLink

  /** Compile `source` into the served program. Throws on a compile error (same as LocalPlcLink). */
  constructor(source: string) {
    this.link = new LocalPlcLink(source)
  }

  meta(): MetaMsg {
    return { t: 'meta', inputs: [...this.link.inputs], outputs: [...this.link.outputs] }
  }

  /** Run one scan for the given input tags and return the resulting outputs + a watch snapshot. */
  step(inputs: Readonly<Record<string, TagValue>>, dt: number): OutMsg {
    const out = this.link.step(inputs, dt)
    return { t: 'out', v: out, watch: { ...this.link.watch } }
  }

  /** Snapshot of every program variable (inputs, outputs, internals) for a monitor/watch view. */
  watch(): Record<string, TagValue> {
    return { ...this.link.watch }
  }
}

/**
 * Serve a {@link SoftPlc} over a {@link Channel}: sends `meta` immediately, then answers each `in`
 * message with an `out`. Returns a disposer that detaches the handler.
 */
export function serveSoftPlc(plc: SoftPlc, ch: Channel): () => void {
  ch.onMessage((data) => {
    let msg: WsPlcMsg
    try {
      msg = decode(data)
    } catch {
      return
    }
    if (msg.t !== 'in') return
    try {
      ch.send(encode(plc.step(msg.v, msg.dt)))
    } catch (e) {
      ch.send(encode({ t: 'err', message: e instanceof Error ? e.message : String(e) }))
    }
  })
  ch.send(encode(plc.meta()))
  return () => ch.onMessage(() => {})
}
