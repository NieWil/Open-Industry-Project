// The desktop shell's socket (apps/desktop/plcIo.cjs) as the editor sees it, the `PlcIoHost` of
// src/editor/links/externalPlc.ts, over node:net and in-process: the connecting half only. A loop script hands it to the
// app's own session classes (ExternalPlcS7Session), so what it drives is the code the dock runs, minus the IPC.

import { Socket } from 'node:net'

/** A PlcIoHost whose `connect` opens real TCP connections. */
export function nodePlcIoHost({ connectTimeoutMs = 3000 } = {}) {
  const onConnection = new Set()
  const onData = new Set()
  const sockets = new Map()
  let nextId = 1
  const emitClosed = (id, remote) => onConnection.forEach((cb) => cb({ id, remote, open: false }))
  return {
    listen: async () => ({ error: 'this host only connects' }),
    connect: ({ host, port }) =>
      new Promise((resolve) => {
        const id = nextId++
        const socket = new Socket()
        socket.setNoDelay(true)
        const timer = setTimeout(() => socket.destroy(new Error(`no answer from ${host}:${port} within ${connectTimeoutMs / 1000} s`)), connectTimeoutMs)
        socket.once('error', (e) => {
          clearTimeout(timer)
          resolve({ error: e.code === 'ECONNREFUSED' ? `nothing is listening on ${host}:${port}` : String(e.message ?? e), id: 0 })
        })
        socket.connect(port, host, () => {
          clearTimeout(timer)
          socket.removeAllListeners('error')
          socket.on('error', () => {}) // 'close' follows
          sockets.set(id, socket)
          socket.on('data', (chunk) => onData.forEach((cb) => cb({ id, bytes: new Uint8Array(chunk) })))
          socket.on('close', () => {
            if (sockets.delete(id)) emitClosed(id, `${host}:${port}`)
          })
          resolve({ error: '', id })
        })
      }),
    async close() {
      for (const s of sockets.values()) s.destroy()
      sockets.clear()
    },
    onConnection(cb) {
      onConnection.add(cb)
      return () => onConnection.delete(cb)
    },
    onData(cb) {
      onData.add(cb)
      return () => onData.delete(cb)
    },
    write(id, bytes) {
      sockets.get(id)?.write(bytes)
    },
    drop(id) {
      const s = sockets.get(id)
      sockets.delete(id)
      s?.destroy()
    },
  }
}
