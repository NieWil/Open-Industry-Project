// Wire protocol for WsPlcLink: a soft-PLC (the ST engine) served over any string transport so an
// external simulation can be driven by the web's Structured Text
// program. Transport-agnostic: messages are JSON strings exchanged over a `Channel`. The soft-PLC
// speaks raw ST tag names - device<->tag binding stays on the simulation side (see plc/bindings.ts).
//
// Flow: server sends `meta` on connect; client sends `in` (its device inputs) each tick; server
// scans and replies `out` (the program's outputs).

import type { TagValue } from '../types'

/** server -> client, once on connect (and on program reload): the program's tag surface. */
export interface MetaMsg {
  t: 'meta'
  inputs: string[]
  outputs: string[]
}

/** client -> server, each control tick: the sim's input (sensor) tag values + the scan dt. */
export interface InMsg {
  t: 'in'
  v: Record<string, TagValue>
  dt: number
}

/** server -> client, after a scan: the program's output (actuator) tag values + a watch snapshot. */
export interface OutMsg {
  t: 'out'
  v: Record<string, TagValue>
  watch: Record<string, TagValue>
}

/** server -> client: the program failed to compile or scan. */
export interface ErrMsg {
  t: 'err'
  message: string
}

export type WsPlcMsg = MetaMsg | InMsg | OutMsg | ErrMsg

export function encode(msg: WsPlcMsg): string {
  return JSON.stringify(msg)
}

export function decode(data: string): WsPlcMsg {
  const m = JSON.parse(data) as WsPlcMsg
  return m
}

/**
 * A minimal bidirectional string transport. A real WebSocket satisfies this via
 * {@link webSocketChannel}; tests use {@link createChannelPair} for an in-memory loop.
 */
export interface Channel {
  send(data: string): void
  onMessage(handler: (data: string) => void): void
  close(): void
}

/** Two linked in-memory channels: a `send` on one is delivered to the other's handler. */
export function createChannelPair(): [Channel, Channel] {
  let ha: ((d: string) => void) | null = null
  let hb: ((d: string) => void) | null = null
  const a: Channel = { send: (d) => hb?.(d), onMessage: (h) => { ha = h }, close: () => {} }
  const b: Channel = { send: (d) => ha?.(d), onMessage: (h) => { hb = h }, close: () => {} }
  return [a, b]
}

/** Structural view of a standard WebSocket (browser or Node) - avoids a DOM lib dependency. */
export interface WebSocketLike {
  send(data: string): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  close(): void
}

/** Adapt a real WebSocket to a {@link Channel}. */
export function webSocketChannel(ws: WebSocketLike): Channel {
  return {
    send: (d) => ws.send(d),
    onMessage: (h) => ws.addEventListener('message', (ev) => h(String(ev.data))),
    close: () => ws.close(),
  }
}
