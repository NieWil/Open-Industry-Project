// The socket half of the simulator's Modbus TCP server. All protocol logic is in src/plc/link/modbusServer.ts
// (ModbusServerIo / ModbusStream); this only carries bytes between a TCP connection and a stream.

import { createServer } from 'node:net'

/**
 * Listen for masters on `host:port`, answering from `io` (a ModbusServerIo). Resolves once bound.
 * A connection whose bytes are not Modbus TCP is closed; the others are served until close().
 */
export function listenModbus(io, { host, port }) {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    const stream = io.connection()
    socket.on('data', (chunk) => {
      for (const reply of stream.push(chunk)) socket.write(reply)
      if (stream.error) {
        console.warn(`modbus: closing ${socket.remoteAddress}:${socket.remotePort}: ${stream.error}`)
        socket.destroy()
      }
    })
    socket.on('error', () => {}) // a master dropping its connection is routine
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve({
        get connections() {
          return sockets.size
        },
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}
