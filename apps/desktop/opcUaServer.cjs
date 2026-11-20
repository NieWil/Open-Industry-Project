// The desktop shell's OPC UA server: the simulated PLC's variables, published by name for a SCADA or HMI
// (a SCADA, an HMI panel, a test client) the way a real PLC's own OPC UA server publishes its program's.
//
// The reverse of opcUaIo.cjs, which is a client of a real PLC's server. Here the app's own program
// keeps running in the sim worker, and whatever connects sees its variables and writes the ones an operator
// may write (a Start button, a setpoint). As in opcUaIo.cjs, node-opcua handles the protocol and the app decides
// everything else (src/editor/links/opcUaServer.ts): which variables are published, as which type, which of them a
// client may write, and what a write does. This file only turns that into nodes.
//
// Unsecured on purpose, for now, like the client: security policy None and anonymous sessions. It listens on
// this machine only unless the user says otherwise, which is what a SCADA on the same workstation needs.
//
// One server per window, closed with it. node-opcua is loaded on the first start, not at startup.

const { join } = require('node:path')

let lib = null
const { BAD_LINK, heldByAnotherWindow, linkKey, linkNo, onPageGone, windowKeys } = require('./linkKeys.cjs')

function opcua() {
  // the client package re-exports the shared types (Variant, StatusCodes, SecurityPolicy); the server's own
  // exports override them where both define a name
  lib ??= { ...require('node-opcua-client'), ...require('node-opcua-server'), ...require('node-opcua-certificate-manager') }
  return lib
}

/** OPC UA built-in type ids to the DataType names node-opcua takes (Part 6, 5.1.2); the app sends the id. */
const DATA_TYPE = { 1: 'Boolean', 2: 'SByte', 3: 'Byte', 4: 'Int16', 5: 'UInt16', 6: 'Int32', 7: 'UInt32', 10: 'Float', 11: 'Double', 12: 'String' }

/** The fastest a client may sample a variable. The app pushes values at the PLC watch's 10 Hz, so sampling faster gains nothing. */
const MIN_SAMPLING_MS = 50

/** A variable's name as the folders above it and its own browse name: `Main.T1.Q` is Main, T1, then Q. */
function segments(name) {
  return name.split('.')
}

class SimOpcUaServer {
  /** @param {string} pkiRoot @param {{ onWrite: (name: string, value: unknown) => void, onClients: (clients: string[]) => void }} events */
  constructor(pkiRoot, events) {
    this.pkiRoot = pkiRoot
    this.events = events
    this.server = null
    this.ns = null
    this.root = null
    /** name -> { node, builtin, writable, value } */
    this.vars = new Map()
    /** folder path ('' for the root) -> { node, children } */
    this.folders = new Map()
    /** whether the simulation runs: while it does not, reads say so (BadOutOfService) and writes are refused */
    this.running = false
    this.closed = false
  }

  /** Listen on `port`, on this machine only unless `network`. `{error: ''}` and the endpoint's URL, or why not. */
  async start({ port, network }) {
    const ua = opcua()
    const server = new ua.OPCUAServer({
      port,
      // bound to loopback, the endpoint has to name loopback too: a client connects to the URL the server's
      // endpoint list gives, and the machine's own name resolves to an address nothing listens on
      ...(network ? {} : { host: '127.0.0.1', hostname: '127.0.0.1' }),
      securityPolicies: [ua.SecurityPolicy.None],
      securityModes: [ua.MessageSecurityMode.None],
      allowAnonymous: true,
      // no Local Discovery Server to register with: a client is pointed at this address directly
      registerServerMethod: ua.RegisterServerMethod.HIDDEN,
      serverInfo: { applicationName: { text: 'Open Industry Project simulator', locale: 'en' } },
      buildInfo: { productName: 'Open Industry Project simulator', manufacturerName: 'Open Industry Project' },
      serverCertificateManager: new ua.OPCUACertificateManager({ rootFolder: join(this.pkiRoot, 'server'), automaticallyAcceptUnknownCertificate: true }),
    })
    this.server = server
    try {
      await server.initialize()
      if (this.closed) throw new Error('closed')
      const addressSpace = server.engine.addressSpace
      this.ns = addressSpace.getOwnNamespace()
      // everything under one object, so a client browsing Objects finds the program in one place
      this.root = this.ns.addObject({ organizedBy: addressSpace.rootFolder.objects, browseName: 'PLC', nodeId: 's=/' })
      this.folders.set('', { node: this.root, children: 0 })
      server.on('session_activated', () => this.events.onClients(this.clients()))
      // raised while the closing session is still listed, so it is left out by hand
      server.on('session_closed', (closing) => this.events.onClients(this.clients(closing)))
      await server.start()
      if (this.closed) throw new Error('closed')
      return { error: '', endpoint: server.getEndpointUrl() }
    } catch (e) {
      await this.stop()
      const text = String(e?.message ?? e)
      if (/EADDRINUSE/.test(text)) return { error: `port ${port} is already in use${network ? '' : ' on this machine'}` }
      if (/EACCES/.test(text)) return { error: `port ${port} may not be opened by this user` }
      return { error: text.split('\n')[0] }
    }
  }

  /** The clients with a session open now, as the dock names them: the client application's own name and its address, "<name> (127.0.0.1)". */
  clients(closing = null) {
    return (this.server?.engine?.getSessions() ?? [])
      .filter((s) => s !== closing && s.status === 'active')
      .map((s) => {
        const name = s.clientDescription?.applicationName?.text || s.clientDescription?.applicationUri || 'a client'
        const remote = s.channel?.remoteAddress
        return remote ? `${name} (${String(remote).replace(/^::ffff:/, '')})` : name
      })
  }

  /** The folder a variable sits in, made on the way down. */
  folder(path) {
    const key = path.join('.')
    const known = this.folders.get(key)
    if (known) return known
    const parent = this.folder(path.slice(0, -1))
    const node = this.ns.addObject({ organizedBy: parent.node, browseName: path.at(-1), nodeId: `s=/${key}` })
    parent.children++
    const made = { node, children: 0 }
    this.folders.set(key, made)
    return made
  }

  /** Drop a folder that no longer holds anything, and any above it that empties with it. Never the root. */
  prune(path) {
    for (let p = path; p.length > 0; p = p.slice(0, -1)) {
      const key = p.join('.')
      const f = this.folders.get(key)
      if (!f || f.children > 0) return
      this.ns.deleteNode(f.node)
      this.folders.delete(key)
      this.folders.get(p.slice(0, -1).join('.')).children--
    }
  }

  /**
   * Publish exactly these variables. One whose name and type are unchanged keeps its node, so a client's
   * subscription to it survives a Stop and Play, or the program being reloaded; the rest are added or removed.
   * @param {{name: string, builtin: number, writable: boolean, value: unknown}[]} nodes
   */
  define(nodes) {
    if (!this.ns || this.closed) return // not listening: nothing to publish into
    const ua = opcua()
    const want = new Map(nodes.filter((n) => DATA_TYPE[n.builtin] && n.name).map((n) => [n.name, n]))
    for (const [name, v] of [...this.vars]) {
      const next = want.get(name)
      if (next && next.builtin === v.builtin && next.writable === v.writable) continue
      this.ns.deleteNode(v.node)
      this.vars.delete(name)
      const path = segments(name).slice(0, -1)
      this.folders.get(path.join('.')).children--
      this.prune(path)
    }
    for (const n of want.values()) {
      const known = this.vars.get(n.name)
      if (known) {
        known.value = n.value
        continue
      }
      const segs = segments(n.name)
      const parent = this.folder(segs.slice(0, -1))
      const entry = { node: null, builtin: n.builtin, writable: n.writable, value: n.value }
      const access = n.writable ? 'CurrentRead | CurrentWrite' : 'CurrentRead'
      entry.node = this.ns.addVariable({
        componentOf: parent.node,
        browseName: segs.at(-1),
        nodeId: `s=${n.name}`,
        dataType: DATA_TYPE[n.builtin],
        accessLevel: access,
        userAccessLevel: access,
        minimumSamplingInterval: MIN_SAMPLING_MS,
        value: {
          get: () => (this.running ? new ua.Variant({ dataType: n.builtin, value: entry.value }) : ua.StatusCodes.BadOutOfService),
          set: (variant) => {
            if (!this.running) return ua.StatusCodes.BadInvalidState
            entry.value = variant.value
            this.events.onWrite(n.name, variant.value)
            return ua.StatusCodes.Good
          },
        },
      })
      parent.children++
      this.vars.set(n.name, entry)
    }
  }

  /** The latest values, by name; a name not published is ignored. `running` false marks them all out of service. */
  update(values, running) {
    this.running = running
    for (const [name, value] of Object.entries(values)) {
      const v = this.vars.get(name)
      if (v) v.value = value
    }
  }

  async stop() {
    this.closed = true
    const server = this.server
    this.server = null
    this.vars.clear()
    this.folders.clear()
    await server?.shutdown(0).catch(() => {})
  }
}

/** @type {Map<string, SimOpcUaServer>} by window and controller (linkKeys.cjs) */
const servers = new Map()
const watched = new Set()
const generation = new Map()
const bump = (key) => {
  const g = (generation.get(key) ?? 0) + 1
  generation.set(key, g)
  return g
}

function send(sender, channel, payload) {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

async function stopFor(key) {
  const s = servers.get(key)
  servers.delete(key)
  await s?.stop()
}

/**
 * Register the `opcuaserver:*` channels. A window runs one server per controller, each on a port of its own: `link` is
 * the controller's number, as its PLC link's (linkKeys.cjs), 0 for the default controller and when absent.
 *   opcuaserver:start  {port, network, link} -> {error, endpoint}    listen (a server already running is replaced)
 *   opcuaserver:define {nodes: [{name, builtin, writable, value}], link}  publish exactly these variables
 *   opcuaserver:update {values: {name: value}, running, link}        the latest values (fire and forget)
 *   opcuaserver:stop   {link}                                        stop listening
 * and pushes, each with the `link` it is from
 *   opcuaserver:write {name, value, link}                            a client wrote a writable variable
 *   opcuaserver:clients {clients: string[], link}                    the clients with a session open
 * `consent` (endpointConsent.cjs `allows`) is asked before the server listens on the network rather than on this
 * machine only; without it that is allowed (a caller that is not the app's window, such as a test).
 */
function registerOpcUaServer(ipcMain, { pkiRoot, consent }) {
  ipcMain.handle('opcuaserver:start', async (event, opts) => {
    const sender = event.sender
    const link = linkNo(opts)
    if (link === null) return { error: BAD_LINK, endpoint: '' }
    const key = linkKey(sender.id, link)
    const mine = bump(key)
    await stopFor(key)
    const port = Number(opts?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `port ${opts?.port} is not a TCP port (1-65535)`, endpoint: '' }
    if (opts?.network === true && consent) {
      const what = `let a SCADA or HMI on the network read and write the simulator's tags over OPC UA on port ${port}`
      if (!(await consent({ host: '0.0.0.0', key: `opcuaserver network ${port}`, what }, sender)))
        return { error: `serving OPC UA to the network on port ${port} was not allowed`, endpoint: '' }
      if (generation.get(key) !== mine) return { error: 'superseded by a newer start', endpoint: '' }
    }
    const server = new SimOpcUaServer(pkiRoot, {
      onWrite: (name, value) => send(sender, 'opcuaserver:write', { name, value, link }),
      onClients: (clients) => send(sender, 'opcuaserver:clients', { clients, link }),
    })
    const started = await server.start({ port, network: opts?.network === true })
    if (started.error) return { error: (/already in use/.test(started.error) && heldByAnotherWindow(servers, sender.id, port)) || started.error, endpoint: '' }
    if (generation.get(key) !== mine) {
      await server.stop()
      return { error: 'superseded by a newer start', endpoint: '' }
    }
    server.port = port
    servers.set(key, server)
    onPageGone(sender, watched, (id) => {
      for (const k of windowKeys(servers, id)) void stopFor(k)
    })
    return started
  })
  ipcMain.handle('opcuaserver:define', (event, opts) => {
    const link = linkNo(opts)
    const server = link === null ? undefined : servers.get(linkKey(event.sender.id, link))
    if (!server) return { error: link === null ? BAD_LINK : 'not started' }
    try {
      server.define(Array.isArray(opts?.nodes) ? opts.nodes : [])
      return { error: '' }
    } catch (e) {
      return { error: String(e?.message ?? e).split('\n')[0] }
    }
  })
  ipcMain.on('opcuaserver:update', (event, msg) => {
    const link = linkNo(msg)
    if (link === null) return
    servers.get(linkKey(event.sender.id, link))?.update(msg?.values ?? {}, msg?.running === true)
  })
  ipcMain.handle('opcuaserver:stop', (event, opts) => {
    const link = linkNo(opts)
    if (link === null) return undefined
    const key = linkKey(event.sender.id, link)
    bump(key)
    return stopFor(key)
  })
}

module.exports = { registerOpcUaServer, SimOpcUaServer }
