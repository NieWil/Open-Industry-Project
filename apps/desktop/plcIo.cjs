// The desktop shell's half of an external PLC link: a plain TCP socket, and nothing else.
//
// The renderer (the sandboxed app) cannot open a socket, so the main process opens it and carries bytes
// both ways over IPC. The direction depends on the PLC: one that polls (OpenPLC) connects to a listener
// here, and one that serves (a Modbus server device) is connected to from here. Either way main
// knows no protocol. Every Modbus decision is made in the app, by src/plc/link/modbusServer.ts and
// src/plc/link/modbusClient.ts, which are unit-tested there (src/editor/links/externalPlc.ts is the renderer's twin of
// this file). Main stays this simple on purpose: the app's own tests cover everything that can be wrong
// about a frame, and a main process that decoded Modbus would be a second copy of that logic.
//
// A window has one link per controller (linkKeys.cjs), each a listener or an outgoing connection, all closed with
// the window. Connections are numbered across every link; the renderer answers by number, and each push names the
// link it belongs to.

const { createServer, Socket } = require('node:net')
const { BAD_LINK, heldByAnotherWindow, linkKey, linkNo, onPageGone, windowKeys } = require('./linkKeys.cjs')

/** @type {Map<string, { server: import('node:net').Server | null, sockets: Map<number, import('node:net').Socket> }>} by linkKey */
const links = new Map()
/** windows whose teardown already closes their links */
const watched = new Set()
/**
 * Per link, bumped by every listen, connect and close: a connect still waiting on the network when a newer
 * request arrives (Stop, then Play again, inside the connect's latency) must not install itself over it.
 */
const generation = new Map()
const bump = (key) => {
  const g = (generation.get(key) ?? 0) + 1
  generation.set(key, g)
  return g
}
/** connection ids are unique across a window's links, so a late byte from an old link cannot reach a new one */
let nextId = 1

function send(sender, channel, payload) {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

function closeFor(key) {
  const l = links.get(key)
  if (!l) return Promise.resolve()
  links.delete(key)
  for (const s of l.sockets.values()) s.destroy()
  const server = l.server
  return server ? new Promise((resolve) => server.close(() => resolve())) : Promise.resolve()
}

/** Close a window's links when the window goes, once per window. */
function watch(sender) {
  onPageGone(sender, watched, (id) => {
    for (const key of windowKeys(links, id)) void closeFor(key)
  })
}

/** A connection of one of a window's links, by its number. */
function socketOf(senderId, id) {
  for (const key of windowKeys(links, senderId)) {
    const socket = links.get(key).sockets.get(id)
    if (socket) return socket
  }
  return undefined
}

const portError = (port) => (!Number.isInteger(port) || port < 1 || port > 65535 ? `port ${port} is not a TCP port (1-65535)` : '')

/** Carry a socket's bytes and its end to the renderer, under `id`, as link `link`'s. */
function carry(sender, entry, link, id, socket, remote) {
  entry.sockets.set(id, socket)
  socket.setNoDelay(true)
  send(sender, 'plcio:connection', { link, id, remote, open: true })
  socket.on('data', (chunk) => send(sender, 'plcio:data', { link, id, bytes: new Uint8Array(chunk) }))
  socket.on('error', () => {}) // a peer dropping its connection is routine; 'close' follows
  socket.on('close', () => {
    entry.sockets.delete(id)
    send(sender, 'plcio:connection', { link, id, remote, open: false })
  })
}

/**
 * Register the `plcio:*` channels. `link` picks one of the window's links (linkKeys.cjs), 0 when absent.
 *   plcio:listen  {link, host, port} -> {error: string}            start that link's listener (a PLC that polls)
 *   plcio:connect {link, host, port} -> {error: string, id: number} connect to a PLC's server (a PLC that serves)
 *   plcio:close   {link}                                           stop the link and drop its connections
 *   plcio:write   {id, bytes}                                      send bytes on a connection
 *   plcio:drop    {id}                                             close a connection (a stream that is not Modbus)
 * and pushes
 *   plcio:connection {link, id, remote, open}                      a connection opened or went away
 *   plcio:data {link, id, bytes}                                   bytes the other end sent
 * `consent` (endpointConsent.cjs `allows`) is asked before a socket that reaches off this machine: a listener on a
 * network interface, or a connection to another host. Without it every endpoint is allowed (a caller that is not
 * the app's window, such as a test).
 */
function registerPlcIo(ipcMain, { consent } = {}) {
  ipcMain.handle('plcio:listen', async (event, opts) => {
    const sender = event.sender
    const link = linkNo(opts)
    if (link === null) return { error: BAD_LINK }
    const key = linkKey(sender.id, link)
    const mine = bump(key)
    await closeFor(key)
    const host = typeof opts?.host === 'string' && opts.host ? opts.host : '127.0.0.1'
    const port = Number(opts?.port)
    const bad = portError(port)
    if (bad) return { error: bad }
    const what = `let a PLC on the network connect to the simulator on port ${port} (${host})`
    if (consent && !(await consent({ host, key: `plcio listen ${host}:${port}`, what }, sender)))
      return { error: `listening on ${host}:${port} was not allowed` }
    if (generation.get(key) !== mine) return { error: 'superseded by a newer link' }
    const entry = { server: null, sockets: new Map(), port }
    const server = createServer((socket) => carry(sender, entry, link, nextId++, socket, `${socket.remoteAddress}:${socket.remotePort}`))
    entry.server = server
    const error = await new Promise((resolve) => {
      server.once('error', (e) =>
        resolve(e.code === 'EADDRINUSE' ? heldByAnotherWindow(links, sender.id, port) || `port ${port} is already in use on ${host}` : String(e.message || e)),
      )
      server.listen(port, host, () => resolve(''))
    })
    if (error) return { error }
    // a close or a newer link during the bind: this listener is no one's now, so it lets the port go
    if (generation.get(key) !== mine) {
      server.close()
      return { error: 'superseded by a newer link' }
    }
    links.set(key, entry)
    watch(sender)
    return { error: '' }
  })

  ipcMain.handle('plcio:connect', async (event, opts) => {
    const sender = event.sender
    const link = linkNo(opts)
    if (link === null) return { error: BAD_LINK, id: 0 }
    const key = linkKey(sender.id, link)
    const mine = bump(key)
    await closeFor(key)
    const host = typeof opts?.host === 'string' && opts.host ? opts.host : '127.0.0.1'
    const port = Number(opts?.port)
    const bad = portError(port)
    if (bad) return { error: bad, id: 0 }
    const what = `connect to a PLC at ${host}:${port}`
    if (consent && !(await consent({ host, key: `plcio connect ${host}:${port}`, what }, sender)))
      return { error: `the connection to ${host}:${port} was not allowed`, id: 0 }
    if (generation.get(key) !== mine) return { error: 'superseded by a newer connect', id: 0 }
    const socket = new Socket()
    const error = await new Promise((resolve) => {
      socket.setTimeout(3000, () => socket.destroy(Object.assign(new Error(''), { code: 'ETIMEDOUT' })))
      socket.once('error', (e) =>
        resolve(
          e.code === 'ECONNREFUSED'
            ? `nothing is listening on ${host}:${port}`
            : e.code === 'ETIMEDOUT'
              ? `no answer from ${host}:${port} within 3 s`
              : e.code === 'ENOTFOUND'
                ? `no host named ${host}`
                : String(e.message || e),
        ),
      )
      socket.connect(port, host, () => resolve(''))
    })
    if (error || generation.get(key) !== mine) {
      socket.destroy()
      return { error: error || 'superseded by a newer link', id: 0 }
    }
    socket.setTimeout(0)
    const entry = { server: null, sockets: new Map() }
    const id = nextId++
    links.set(key, entry)
    watch(sender)
    carry(sender, entry, link, id, socket, `${host}:${port}`)
    return { error: '', id }
  })

  ipcMain.handle('plcio:close', (event, opts) => {
    const link = linkNo(opts)
    if (link === null) return
    const key = linkKey(event.sender.id, link)
    bump(key)
    return closeFor(key)
  })
  ipcMain.on('plcio:write', (event, msg) => {
    const socket = socketOf(event.sender.id, msg?.id)
    if (socket && msg.bytes) socket.write(Buffer.from(msg.bytes))
  })
  ipcMain.on('plcio:drop', (event, msg) => {
    socketOf(event.sender.id, msg?.id)?.destroy()
  })
}

module.exports = { registerPlcIo }
