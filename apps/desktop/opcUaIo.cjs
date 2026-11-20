// The desktop shell's half of an OPC UA link: a node-opcua client, and nothing about the scene.
//
// OPC UA is too large a protocol to implement in the app the way Modbus is (plcIo.cjs moves raw bytes and
// src/plc/modbus*.ts implement the protocol). So here the library handles the protocol and the app decides everything
// else: which tags travel, which node each one is, and what a value means (src/core/io/opcUa.ts,
// src/editor/links/externalPlc.ts). This file only turns those decisions into service calls.
//
// Unsecured on purpose, for now: security policy None and an anonymous session, with no certificates to trust
// on either side. That is the setting a test bench or a soft PLC on the same machine uses. A plant network
// usually forbids it, and the dock says the connection is unsecured. node-opcua still keeps a client
// certificate store even for None, so it gets one of its own under the app's data folder.
//
// One link per controller in a window (linkKeys.cjs), all closed with it. node-opcua is loaded on the first connect, not at startup: most
// sessions never use OPC UA, and the library is large.

const { join } = require('node:path')
const { opcUaHost } = require('./endpointConsent.cjs')
const { BAD_LINK, linkKey, listingLinkNo, onPageGone, windowKeys } = require('./linkKeys.cjs')

let lib = null
function opcua() {
  lib ??= { ...require('node-opcua-client'), ...require('node-opcua-certificate-manager') }
  return lib
}

/** Browse limits: deep enough for any vendor's layout, bounded so a huge server cannot stall a connect. */
const MAX_DEPTH = 12
const MAX_NODES = 20000
const BROWSE_BATCH = 200
/**
 * A cycle's requests fail in seconds, since the app's watchdog has already de-energised the PLC's outputs after one.
 * node-opcua raises any shorter timeout to its minTransactionTimeout, 5 s, a static shared by every link in the process.
 */
const CYCLE_TIMEOUT_MS = 5000
/** A browse request's timeout. A PLC with a large tree can take longer than a cycle to answer one. */
const BROWSE_TIMEOUT_MS = 30000
/** References per node in one browse answer; the rest follow by continuation point. Large answers are slow to build. */
const MAX_REFERENCES = 1000
/** The reference type for properties (EngineeringUnits and the like), which are not a program's variables. */
const HAS_PROPERTY = 'ns=0;i=46'
const HAS_SUBTYPE = 'ns=0;i=45'
const OBJECTS = 'ns=0;i=85'
/** How many start points a browse takes (core/io/opcUa.ts MAX_BROWSE_ROOTS). */
const MAX_ROOTS = 16
/** How often a browse says how far it has got: often enough to look alive, rarely enough not to flood the window. */
const PROGRESS_MS = 250
/** The standard Enumeration DataType, and the abstract ones: BaseDataType, Number, Integer, UInteger. */
const ENUMERATION = 29
const ABSTRACT = new Set([24, 26, 27, 28])

/** `items` in runs of at most `size` (0: one run), for a server's per-request node limit. */
function chunks(items, size) {
  if (!(size > 0) || items.length <= size) return [items]
  const out = []
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
  return out
}

/** A library error as one readable line. */
function say(e) {
  const text = String(e?.message ?? e).split('\n')[0].trim().replace(/\s+\.$/, '')
  if (/BadIdentityToken|BadUserAccessDenied|Anonymous/i.test(text)) return `the PLC refused an anonymous login (${text})`
  if (/BadSecurityPolicyRejected|BadSecurityModeRejected|End point must exist.*securityMode = None/i.test(text)) {
    return 'the PLC only accepts secured connections: allow the "None" security policy on its OPC UA server to connect without certificates'
  }
  if (/cannot be established/i.test(text)) return `nothing answered at ${text.match(/opc\.tcp:\/\/\S+/)?.[0] ?? 'that address'}`
  return text
}

/**
 * Start points from the app (core/io/opcUa.ts OpcUaBrowseRoot): `{path: [names]}` or `{nodeId}`. Null when one is
 * neither, or there are too many.
 */
function browseRoots(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_ROOTS) return null
  const name = (s) => typeof s === 'string' && s !== '' && s.length <= 512
  const ok = raw.every((r) => (Array.isArray(r?.path) && r.path.length > 0 && r.path.every(name)) || name(r?.nodeId))
  return ok ? raw.map((r) => (Array.isArray(r.path) ? { path: [...r.path] } : { nodeId: r.nodeId })) : null
}

/** A Browse of a node's children: every hierarchical reference, every node class, every field of the answer. */
function childrenOf(n) {
  return { nodeId: n.nodeId, browseDirection: opcua().BrowseDirection.Forward, referenceTypeId: 'HierarchicalReferences', includeSubtypes: true, nodeClassMask: 0, resultMask: 63 }
}

/** A request our client gave up on, or one the server says ran out of time. */
const timedOut = (e) => /timed out|BadTimeout/i.test(String(e?.message ?? e))

class OpcUaLink {
  /**
   * @param {string} pkiRoot @param {(why: string) => void} onClosed
   * @param {{progressMs?: number}} [opts] how often a browse reports progress (a test sets 0 to hear every batch)
   */
  constructor(pkiRoot, onClosed, { progressMs = PROGRESS_MS } = {}) {
    this.progressMs = progressMs
    this.pkiRoot = pkiRoot
    this.onClosed = onClosed
    this.client = null
    this.session = null
    this.closed = false
    /** The server's OperationLimits: most nodes per Read, Write and Browse request (0: no limit). */
    this.limits = { read: 0, write: 0, browse: 0 }
    /** DataType NodeId -> the built-in type it comes down to, as builtinOf found it */
    this.types = new Map()
  }

  /**
   * Connect and open an anonymous session. `{error: ''}` on success, else why not. For a discovery server
   * (it holds the standard port 4840 on machines where a vendor install brought one, and has no tags),
   * also `discovery`: the servers it lists, for the app to name.
   */
  async connect(endpoint) {
    const ua = opcua()
    const client = ua.OPCUAClient.create({
      applicationName: 'Open Industry Project',
      securityMode: ua.MessageSecurityMode.None,
      securityPolicy: ua.SecurityPolicy.None,
      endpointMustExist: false,
      keepSessionAlive: false,
      // a request left unanswered fails the cycle in seconds, not the library's default minute
      defaultTransactionTimeout: CYCLE_TIMEOUT_MS,
      // the app retries on its own schedule, and says so; the library's own backoff would hide a dead PLC
      connectionStrategy: { maxRetry: 0, initialDelay: 100, maxDelay: 200 },
      clientCertificateManager: new ua.OPCUACertificateManager({ rootFolder: this.pkiRoot, automaticallyAcceptUnknownCertificate: true }),
    })
    this.client = client
    try {
      await client.connect(endpoint)
      if (this.closed) throw new Error('closed')
      // what kind of server answered, before asking it for a session a discovery server may not even offer
      const endpoints = await client.getEndpoints()
      if (endpoints.some((e) => e.server?.applicationType === ua.ApplicationType.DiscoveryServer)) {
        const servers = await client.findServers().catch(() => [])
        const discovery = servers
          .filter((s) => s.applicationType !== ua.ApplicationType.DiscoveryServer && s.applicationType !== ua.ApplicationType.Client)
          .map((s) => ({ name: s.applicationName?.text || s.applicationUri || 'an OPC UA server', urls: [...(s.discoveryUrls ?? [])] }))
        await this.close()
        return { error: 'a discovery server, not a PLC', discovery }
      }
      client.on('connection_lost', () => this.lost('the connection to the PLC was lost'))
      client.on('close', () => this.lost('the PLC closed the connection'))
      await this.openSession()
      if (this.closed) throw new Error('closed')
      // node-opcua does not split requests, and a server rejects one over its limits with BadTooManyOperations.
      // A limit the server does not publish is taken as none. (The library's readOperationLimits reads twelve
      // limits and logs a warning for each one a server leaves out.)
      const ids = ua.VariableIds
      const limits = await this.session
        .read([ids.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead, ids.Server_ServerCapabilities_OperationLimits_MaxNodesPerWrite, ids.Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse].map((i) => ({ nodeId: `ns=0;i=${i}`, attributeId: ua.AttributeIds.Value })))
        .catch(() => [])
      if (this.closed) throw new Error('closed')
      const limit = (i) => (limits[i]?.statusCode.isGood() ? Number(limits[i].value.value) || 0 : 0)
      this.limits = { read: limit(0), write: limit(1), browse: limit(2) }
      return { error: '' }
    } catch (e) {
      await this.close()
      return { error: say(e) }
    }
  }

  lost(why) {
    if (this.closed) return
    this.onClosed(why)
    void this.close()
  }

  /** Open the session, and close the link when the PLC closes it. */
  async openSession() {
    const session = await this.client.createSession()
    session.requestedMaxReferencesPerNode = MAX_REFERENCES
    session.on('session_closed', () => this.lost('the PLC closed the session'))
    this.session = session
  }

  /**
   * Swap the session for a new one on the same connection, after a browse request timed out. The server may still
   * answer that request, and hold its continuation points for this session until the session ends. A server allows
   * only a few per session, so without this every later browse could fail with BadNoContinuationPoints.
   */
  async renew() {
    const old = this.session
    const maxReferences = old.requestedMaxReferencesPerNode
    // closing our own session fires session_closed, which would close the link
    old.removeAllListeners('session_closed')
    await old.close().catch(() => {})
    if (this.closed) throw new Error('closed')
    await this.openSession()
    this.session.requestedMaxReferencesPerNode = maxReferences
  }

  /**
   * Every variable under Objects, or under the start points `roots` names, with its path of browse names. The standard namespace (0) holds the
   * server's own model, never a program's variables, so it is not entered; nor are properties. A variable
   * is entered too, because a structure's members are its children.
   *
   * A batch that times out goes again in halves on a new session, and later batches keep the smaller size. A node
   * that times out alone, twice, is left out and listed in `skipped` by its path, so one slow branch does not
   * cost the whole list. `onProgress` hears how many variables it has found, every `progressMs` at most.
   */
  async browse(roots = [], onProgress = () => {}) {
    const ua = opcua()
    const variables = []
    const skipped = []
    let told = Date.now()
    let level = await this.startPoints(roots)
    let seen = 0
    let truncated = false
    let size = this.limits.browse > 0 ? Math.min(BROWSE_BATCH, this.limits.browse) : BROWSE_BATCH
    const retried = new Set()
    for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && !truncated; depth++) {
      const next = []
      let at = 0
      while (at < level.length && !truncated) {
        const batch = level.slice(at, at + size)
        let found
        try {
          found = await this.browseBatch(batch)
        } catch (e) {
          if (!timedOut(e)) throw e
          await this.renew()
          if (batch.length > 1) size = Math.ceil(batch.length / 2)
          else if (!retried.has(batch[0])) retried.add(batch[0])
          else {
            skipped.push(batch[0].path.join('.') || 'Objects')
            at += 1
          }
          continue
        }
        at += batch.length
        for (const [node, refs] of found) {
          for (const ref of refs) {
            if (ref.nodeId.namespace === 0 || ref.referenceTypeId.toString() === HAS_PROPERTY) continue
            const path = [...node.path, ref.browseName.name]
            const nodeId = ref.nodeId.toString()
            if (ref.nodeClass === ua.NodeClass.Variable) variables.push({ path, nodeId })
            if (ref.nodeClass === ua.NodeClass.Object || ref.nodeClass === ua.NodeClass.Variable) next.push({ nodeId, path })
            if (++seen >= MAX_NODES) truncated = true
          }
        }
        if (Date.now() - told >= this.progressMs) {
          told = Date.now()
          onProgress(variables.length)
        }
      }
      level = next
    }
    return { variables, truncated, skipped }
  }

  /**
   * The nodes a browse starts from, each with its path: Objects when `roots` is empty. A path is followed from Objects
   * one browse name at a time, ignoring case and preferring the exact spelling, as a tag is matched, so its variables
   * keep their whole path. A NodeId's path starts at its own browse name. A start point the server does not hold, or a
   * path that names two nodes, fails the browse: skipping it would only show up later as tags reported missing.
   */
  async startPoints(roots) {
    if (roots.length === 0) return [{ nodeId: OBJECTS, path: [] }]
    const ua = opcua()
    const out = []
    for (const root of roots) {
      let node
      if (root.nodeId !== undefined) {
        const [dv] = await this.session.read([{ nodeId: root.nodeId, attributeId: ua.AttributeIds.BrowseName }])
        if (!dv.statusCode.isGood()) throw new Error(`the PLC has no node ${root.nodeId} to browse from (${dv.statusCode.name})`)
        node = { nodeId: ua.resolveNodeId(root.nodeId).toString(), path: [dv.value.value.name], fromObjects: false }
      } else {
        node = { nodeId: OBJECTS, path: [], fromObjects: true }
        for (const want of root.path) {
          const [result] = await this.browseOnce([childrenOf(node)])
          const refs = result.statusCode.isGood() ? await this.pages(result) : []
          let found = refs.filter((r) => r.browseName.name?.toLowerCase() === want.toLowerCase())
          if (found.length > 1 && found.some((r) => r.browseName.name === want)) found = found.filter((r) => r.browseName.name === want)
          const ids = new Set(found.map((r) => r.nodeId.toString()))
          const where = [...node.path, want].join('.')
          if (ids.size === 0) throw new Error(`the PLC has no ${where} to browse from`)
          if (ids.size > 1) throw new Error(`${where} names ${ids.size} nodes on the PLC: browse from its NodeId instead`)
          node = { nodeId: [...ids][0], path: [...node.path, found[0].browseName.name], fromObjects: true }
        }
      }
      if (!out.some((o) => o.nodeId === node.nodeId)) out.push(node)
    }
    // a path start point under another one would list its variables twice
    const under = (inner, outer) => inner !== outer && inner.fromObjects && outer.fromObjects && outer.path.length < inner.path.length && outer.path.every((seg, i) => seg === inner.path[i])
    return out.filter((o) => !out.some((p) => under(o, p))).map(({ nodeId, path }) => ({ nodeId, path }))
  }

  /** Each node of `batch` with its references, every page of them. A node this session may not browse is left out. */
  async browseBatch(batch) {
    const results = await this.browseOnce(batch.map(childrenOf))
    const found = []
    const retry = []
    for (let i = 0; i < results.length; i++) {
      const status = results[i].statusCode
      if (status.name === 'BadNoContinuationPoints') retry.push(batch[i])
      else if (status.isGood()) found.push([batch[i], await this.pages(results[i])])
    }
    // A server holds only so many continuation points per session, and answers the rest of a request with
    // BadNoContinuationPoints. Those nodes go again one at a time, each one's points released before the next.
    for (const node of retry) {
      const [result] = await this.browseOnce([childrenOf(node)])
      if (!result.statusCode.isGood()) throw new Error(`could not browse ${node.path.join('.') || 'Objects'} (${result.statusCode.name})`)
      found.push([node, await this.pages(result)])
    }
    return found
  }

  /**
   * One Browse request, with the browse timeout. session.browse builds its request with the client's default
   * timeout, which a cycle needs short, so the request is built here.
   */
  browseOnce(nodes) {
    const ua = opcua()
    return this.send(
      new ua.BrowseRequest({
        nodesToBrowse: nodes.map((n) => new ua.BrowseDescription({ ...n, nodeId: ua.resolveNodeId(n.nodeId), referenceTypeId: ua.resolveNodeId(n.referenceTypeId) })),
        requestedMaxReferencesPerNode: this.session.requestedMaxReferencesPerNode,
      }),
    )
  }

  /** A request's results, sent with the browse timeout. */
  send(request) {
    request.requestHeader.timeoutHint = BROWSE_TIMEOUT_MS
    return new Promise((resolve, reject) =>
      this.session.performMessageTransaction(request, (err, response) => {
        if (err) return reject(err)
        const results = response.results ?? []
        for (const r of results) r.references ??= []
        resolve(results)
      }),
    )
  }

  /** A browse result's references, with every page behind its continuation point. */
  async pages(result) {
    const refs = [...(result.references ?? [])]
    let cp = result.continuationPoint
    while (cp && cp.length > 0) {
      const [more] = await this.send(new (opcua().BrowseNextRequest)({ continuationPoints: [cp], releaseContinuationPoints: false }))
      // a point the server dropped (BadContinuationPointInvalid) would otherwise end the list early without a word
      if (!more.statusCode.isGood()) throw new Error(`browsing the PLC's tags stopped part way (${more.statusCode.name})`)
      refs.push(...(more.references ?? []))
      cp = more.continuationPoint
    }
    return refs
  }

  /**
   * The DataType of each node, the built-in type it comes down to (0 when none), and the user's access level,
   * for the app to bind against.
   */
  async describe(nodeIds) {
    const ua = opcua()
    if (nodeIds.length === 0) return []
    const reads = nodeIds.flatMap((nodeId) => [
      { nodeId, attributeId: ua.AttributeIds.DataType },
      { nodeId, attributeId: ua.AttributeIds.UserAccessLevel },
    ])
    const dv = await this.read(reads)
    const nodes = []
    for (let i = 0; i < nodeIds.length; i++) {
      const type = dv[i * 2]
      const access = dv[i * 2 + 1]
      const dataType = type.statusCode.isGood() ? type.value.value : null
      nodes.push({
        dataType: dataType?.toString() ?? '',
        builtin: dataType ? await this.builtinOf(dataType) : 0,
        access: access.statusCode.isGood() ? Number(access.value.value) : 0,
      })
    }
    // an abstract DataType (Number, BaseDataType) does not say what the value is, so the value's own type does
    const open = nodeIds.filter((_, i) => nodes[i].dataType !== '' && nodes[i].builtin === 0)
    if (open.length > 0) {
      const values = await this.read(open.map((nodeId) => ({ nodeId, attributeId: ua.AttributeIds.Value })))
      let k = 0
      for (const n of nodes) {
        if (n.dataType === '' || n.builtin !== 0) continue
        const v = values[k++]
        if (v.statusCode.isGood() && v.value.arrayType === ua.VariantArrayType.Scalar) n.builtin = v.value.dataType
      }
    }
    return nodes
  }

  /**
   * The built-in type a DataType comes down to, following its supertypes to the standard namespace: an alias
   * of Int16 is an Int16, Duration a Double, and an enumeration an Int32 (its values travel as one). 0 for an
   * abstract type. node-opcua's own getBuiltInDataType is not used: it takes any type numbered 1 to 25 as
   * built-in whatever its namespace, so a PLC's `ns=4;i=7` would read as UInt32.
   */
  async builtinOf(dataType) {
    const key = dataType.toString()
    if (this.types.has(key)) return this.types.get(key)
    const ua = opcua()
    let id = dataType
    let found = 0
    for (let step = 0; step < MAX_DEPTH; step++) {
      if (id.namespace === 0 && typeof id.value === 'number') {
        if (id.value === ENUMERATION) found = 6
        else if (id.value >= 1 && id.value <= 25 && !ABSTRACT.has(id.value)) found = id.value
        if (found !== 0 || ABSTRACT.has(id.value)) break
      }
      const [r] = await this.browseOnce([{ nodeId: id, browseDirection: ua.BrowseDirection.Inverse, referenceTypeId: HAS_SUBTYPE, includeSubtypes: false, nodeClassMask: 0, resultMask: 63 }])
      const up = r.statusCode.isGood() ? r.references?.[0]?.nodeId : null
      if (!up) break
      id = up
    }
    this.types.set(key, found)
    return found
  }

  /** One cycle: the writes, then the reads. Per-item statuses come back by name ("Good", "BadNotWritable"). */
  async exchange(writes, reads) {
    const ua = opcua()
    const w = await this.write(writes.map((x) => ({ nodeId: x.nodeId, attributeId: ua.AttributeIds.Value, value: { value: { dataType: x.builtin, value: x.value } } })))
    const r = await this.read(reads.map((nodeId) => ({ nodeId, attributeId: ua.AttributeIds.Value })))
    return {
      writes: w.map((s) => s.name),
      reads: r.map((d) => ({ value: d.value?.value ?? null, status: d.statusCode.name })),
    }
  }

  /** A Read of any length, in requests the server's MaxNodesPerRead allows. */
  async read(nodes) {
    const out = []
    for (const part of chunks(nodes, this.limits.read)) if (part.length > 0) out.push(...(await this.session.read(part)))
    return out
  }

  /** A Write of any length, in requests the server's MaxNodesPerWrite allows. */
  async write(nodes) {
    const out = []
    for (const part of chunks(nodes, this.limits.write)) if (part.length > 0) out.push(...(await this.session.write(part)))
    return out
  }

  async close() {
    this.closed = true
    const { session, client } = this
    this.session = null
    this.client = null
    await session?.close().catch(() => {})
    await client?.disconnect().catch(() => {})
  }
}

/** @type {Map<string, OpcUaLink>} by linkKey (linkKeys.cjs): a window has one link per controller */
const links = new Map()
const watched = new Set()
const generation = new Map()
const bump = (id) => {
  const g = (generation.get(id) ?? 0) + 1
  generation.set(id, g)
  return g
}

function send(sender, channel, payload) {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

async function closeFor(id) {
  const link = links.get(id)
  links.delete(id)
  await link?.close()
}

/** Run `fn` on the link a call names, turning a missing link or a library error into `{error}`. */
async function withLink(event, opts, fn) {
  const n = listingLinkNo(opts)
  if (n === null) return { error: BAD_LINK }
  const link = links.get(linkKey(event.sender.id, n))
  if (!link) return { error: 'not connected' }
  try {
    return { error: '', ...(await fn(link)) }
  } catch (e) {
    return { error: say(e) }
  }
}

/**
 * Register the `opcua:*` channels. Each call may name one of the window's links as `link` (linkKeys.cjs), 0 when absent.
 *   opcua:connect  {endpoint} -> {error, discovery?}                connect and open an anonymous session;
 *                                                                   discovery: [{name, urls}] when the address
 *                                                                   is a discovery server, not a PLC
 *   opcua:browse   {roots?} -> {error, variables: [{path, nodeId}], truncated, skipped}
 *                                                                   every variable under Objects, or under the start
 *                                                                   points roots names ([{path} | {nodeId}]); skipped:
 *                                                                   the paths of nodes that never answered in time
 *   opcua:describe {nodeIds} -> {error, nodes: [{dataType, builtin, access}]}
 *   opcua:exchange {writes: [{nodeId, builtin, value}], reads: [nodeId]} -> {error, writes: [status], reads: [{value, status}]}
 *   opcua:close                                                     end the session
 * and pushes
 *   opcua:closed {link, why}                                        the PLC went away
 *   opcua:progress {link, found}                                    a browse under way has found this many variables
 * `consent` (endpointConsent.cjs `allows`) is asked before connecting to another host; without it every endpoint
 * is allowed (a caller that is not the app's window, such as a test).
 */
function registerOpcUaIo(ipcMain, { pkiRoot, consent }) {
  ipcMain.handle('opcua:connect', async (event, opts) => {
    const sender = event.sender
    const n = listingLinkNo(opts)
    if (n === null) return { error: BAD_LINK }
    const key = linkKey(sender.id, n)
    const mine = bump(key)
    await closeFor(key)
    const endpoint = typeof opts?.endpoint === 'string' ? opts.endpoint : ''
    if (!/^opc\.tcp:\/\/\S+$/.test(endpoint)) return { error: `${endpoint || 'an empty endpoint'} is not an opc.tcp:// address` }
    const host = opcUaHost(endpoint)
    if (consent && !(await consent({ host, key: `opcua connect ${endpoint}`, what: `connect to the OPC UA server at ${endpoint}` }, sender)))
      return { error: `the connection to ${endpoint} was not allowed` }
    if (generation.get(key) !== mine) return { error: 'superseded by a newer connect' }
    const link = new OpcUaLink(join(pkiRoot), (why) => {
      if (links.get(key) === link) {
        links.delete(key)
        send(sender, 'opcua:closed', { link: n, why })
      }
    })
    const connected = await link.connect(endpoint)
    if (connected.error) return connected
    if (generation.get(key) !== mine) {
      await link.close()
      return { error: 'superseded by a newer link' }
    }
    links.set(key, link)
    onPageGone(sender, watched, (id) => {
      for (const k of windowKeys(links, id)) void closeFor(k)
    })
    return { error: '' }
  })
  ipcMain.handle('opcua:browse', (event, opts) => {
    const roots = browseRoots(opts?.roots)
    if (roots === null) return { error: 'the start points are not browse paths or NodeIds' }
    const link = listingLinkNo(opts)
    return withLink(event, opts, (l) => l.browse(roots, (found) => send(event.sender, 'opcua:progress', { link, found })))
  })
  ipcMain.handle('opcua:describe', (event, opts) => withLink(event, opts, async (l) => ({ nodes: await l.describe(Array.isArray(opts?.nodeIds) ? opts.nodeIds : []) })))
  ipcMain.handle('opcua:exchange', (event, opts) => withLink(event, opts, (l) => l.exchange(Array.isArray(opts?.writes) ? opts.writes : [], Array.isArray(opts?.reads) ? opts.reads : [])))
  ipcMain.handle('opcua:close', (event, opts) => {
    const n = listingLinkNo(opts)
    if (n === null) return
    const key = linkKey(event.sender.id, n)
    bump(key)
    return closeFor(key)
  })
}

module.exports = { registerOpcUaIo, OpcUaLink }
