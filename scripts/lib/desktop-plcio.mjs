// The desktop shell's socket host (apps/desktop/plcIo.cjs) in plain Node, for a headless script: the main-process
// code the app's links run on, behind a stand-in for Electron's IPC, so a script drives the app's link code
// (src/editor/controller/plcLinks.ts and the sessions under it) over real sockets. `calls` records every listen and
// connect with the link number it named (apps/desktop/linkKeys.cjs), which is what a check of several controllers
// reads.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { registerPlcIo } = require('../../apps/desktop/plcIo.cjs')

export function desktopPlcIo() {
  const handlers = new Map()
  const listeners = new Map()
  registerPlcIo({ handle: (channel, fn) => handlers.set(channel, fn), on: (channel, fn) => listeners.set(channel, fn) })
  const subscribers = new Map()
  const gone = new Set()
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => subscribers.get(channel)?.forEach((cb) => cb(payload)),
    once: (event, fn) => event === 'destroyed' && gone.add(fn),
    // no page here navigates, so only 'destroyed' is ever fired
    on: () => {},
    removeListener: (event, fn) => event === 'destroyed' && gone.delete(fn),
  }
  const event = { sender }
  const subscribe = (channel, cb) => {
    const set = subscribers.get(channel) ?? new Set()
    subscribers.set(channel, set.add(cb))
    return () => set.delete(cb)
  }
  const calls = []
  const host = {
    listen: (opts) => (calls.push({ call: 'listen', ...opts }), handlers.get('plcio:listen')(event, opts)),
    connect: (opts) => (calls.push({ call: 'connect', ...opts }), handlers.get('plcio:connect')(event, opts)),
    close: (opts) => handlers.get('plcio:close')(event, opts),
    onConnection: (cb) => subscribe('plcio:connection', cb),
    onData: (cb) => subscribe('plcio:data', cb),
    write: (id, bytes) => listeners.get('plcio:write')(event, { id, bytes }),
    drop: (id) => listeners.get('plcio:drop')(event, { id }),
  }
  // the window going: every link it holds closes
  return { host, calls, close: () => [...gone].forEach((fn) => fn()) }
}
