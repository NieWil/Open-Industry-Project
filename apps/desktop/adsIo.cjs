// The desktop shell's half of an ADS link: Beckhoff's TcAdsDll, called through koffi, and nothing about the scene.
//
// Why Beckhoff's DLL and not our own protocol code: a client on a PC with TwinCAT does not speak ADS to the network
// itself. It hands its requests to the AMS router on that PC through TcAdsDll, and the router owns the routes, the
// Net IDs and any secured connection to the PLC. Going through that library is the documented way for a local client,
// and it keeps the app out of route and transport security handling. oip-comms' driver does the same
// (tcads_loader.cpp) and this follows it: the same search for the DLL, symbol info and a
// handle per symbol by name, reads and writes through the handle, the same error table (src/core/io/ads.ts). One thing
// is added: a cycle is two ADS SUM commands (every write in one request, every read in another) instead of a request
// per symbol, so a PLC across the network takes two round trips a cycle whatever the scene holds.
//
// The DLL is the user's. It comes with every TwinCAT install (XAE, XAR, or the ADS setup alone); nothing here ships
// it. So ADS is Windows-only, and a PC without TwinCAT is told what to install. Loaded on the first open, because most
// sessions never use ADS.
//
// Nothing here blocks main. Every ADS call runs on koffi's worker thread (`fn.async`), and the router gives up on an
// unanswered request after ANSWER_MS. A synchronous call would freeze every window for as long as a dead PLC takes.
//
// One link per controller in a window (linkKeys.cjs), all closed with it. Plain Node. Its tests never reach a TwinCAT router: they set OIP_TCADSDLL_PATH
// to a file that is not there and check what this module itself says (argument checks, the missing-DLL answer).

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { BAD_LINK, linkKey, listingLinkNo, onPageGone, windowKeys } = require('./linkKeys.cjs')

/** How long the router waits for an answer before failing a request (0x745): inside the app's 1 s watchdog. */
const ANSWER_MS = 500

// index groups (TcAdsDef.h)
const SYM_HNDBYNAME = 0xf003
const SYM_VALBYHND = 0xf005
const SYM_RELEASEHND = 0xf006
const SYM_INFOBYNAMEEX = 0xf009
const SYM_UPLOAD = 0xf00b
const SYM_UPLOADINFO2 = 0xf00f
const SUMUP_READ = 0xf080
const SUMUP_WRITE = 0xf081
/** how long the symbol table upload may take: one request carrying every symbol, larger than a cycle's */
const UPLOAD_MS = 5000
/** a symbol table past this is refused rather than allocated (a large project's runs to a few MB) */
const MAX_UPLOAD = 64 * 1024 * 1024
/** "invalid size": the table grew between asking its size and reading it (an online change), so it is asked again */
const INVALID_SIZE = 0x705
/** ADS's limit on one sum command's sub-requests */
const MAX_SUM = 500
/** "service not supported": a runtime too old for sum commands, which then gets a request per symbol */
const SERVICE_NOT_SUPPORTED = 0x701

/**
 * Where TcAdsDll is: OIP_TCADSDLL_PATH when it is set, and then ONLY there (a path set by hand is the one meant, so a
 * wrong one is reported rather than passed over for another install); otherwise the install the registry names, then
 * the standard install paths. The registry's ConnectionProvider points at a DLL inside the install
 * (<root>\3.1\System\...), and the root is the path before that; the value is read whether it is REG_SZ or REG_MULTI_SZ.
 */
function dllCandidates() {
  if (process.env.OIP_TCADSDLL_PATH) return [process.env.OIP_TCADSDLL_PATH]
  const out = []
  try {
    const text = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Beckhoff\\TwinCAT3\\System', '/v', 'ConnectionProvider'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const m = /ConnectionProvider\s+REG_(?:MULTI_)?SZ\s+(.+)/.exec(text)
    const at = m ? m[1].indexOf('\\3.1\\System\\') : -1
    if (at > 0) out.push(join(m[1].slice(0, at), 'Common64', 'TcAdsDll.dll'))
  } catch {
    // no TwinCAT in the registry: the standard paths below are the only places left to look
  }
  out.push('C:\\Program Files (x86)\\Beckhoff\\TwinCAT\\Common64\\TcAdsDll.dll', 'C:\\Program Files\\Beckhoff\\TwinCAT\\Common64\\TcAdsDll.dll')
  return out
}

let lib = null
let loadError = null
/** Load TcAdsDll once; null (with `loadError`) when this PC has none. */
function tcAds() {
  if (lib || loadError) return lib
  if (process.platform !== 'win32') {
    loadError = "ADS goes through TwinCAT's router, which runs on Windows"
    return null
  }
  const file = dllCandidates().find((p) => existsSync(p))
  if (!file && process.env.OIP_TCADSDLL_PATH) {
    loadError = `ADS needs TwinCAT's TcAdsDll, and OIP_TCADSDLL_PATH names a file that is not there (${process.env.OIP_TCADSDLL_PATH})`
    return null
  }
  if (!file) {
    loadError = "ADS needs TwinCAT's router on this PC, and TwinCAT is not installed (TcAdsDll.dll was not found). Install TwinCAT 3 (the engineering, the runtime, or the ADS setup alone), or set OIP_TCADSDLL_PATH"
    return null
  }
  try {
    const koffi = require('koffi')
    const so = koffi.load(file)
    const AmsAddr = koffi.struct('OipAmsAddr', { netId: koffi.array('uint8_t', 6), port: 'uint16_t' })
    lib = {
      file,
      AmsAddr,
      portOpen: so.func('long __stdcall AdsPortOpenEx()'),
      portClose: so.func('long __stdcall AdsPortCloseEx(long port)'),
      localAddress: so.func('long __stdcall AdsGetLocalAddressEx(long port, _Out_ OipAmsAddr *addr)'),
      setTimeout: so.func('long __stdcall AdsSyncSetTimeoutEx(long port, long ms)'),
      readState: so.func('long __stdcall AdsSyncReadStateReqEx(long port, OipAmsAddr *addr, _Out_ uint16_t *ads, _Out_ uint16_t *dev)'),
      read: so.func('long __stdcall AdsSyncReadReqEx2(long port, OipAmsAddr *addr, uint32_t group, uint32_t offset, uint32_t length, _Out_ uint8_t *data, _Out_ uint32_t *returned)'),
      write: so.func('long __stdcall AdsSyncWriteReqEx(long port, OipAmsAddr *addr, uint32_t group, uint32_t offset, uint32_t length, uint8_t *data)'),
      readWrite: so.func('long __stdcall AdsSyncReadWriteReqEx2(long port, OipAmsAddr *addr, uint32_t group, uint32_t offset, uint32_t readLength, _Out_ uint8_t *readData, uint32_t writeLength, uint8_t *writeData, _Out_ uint32_t *returned)'),
    }
  } catch (e) {
    loadError = `could not load TwinCAT's TcAdsDll (${file}): ${String(e?.message ?? e).split('\n')[0]}`
  }
  return lib
}

/** Run a TcAdsDll function on koffi's worker thread. */
function call(fn, ...args) {
  return new Promise((resolve, reject) => fn.async(...args, (err, res) => (err ? reject(err) : resolve(res))))
}

/** `192.168.1.20.1.1` as six bytes, or null. */
function netIdBytes(s) {
  const parts = String(s).split('.')
  if (parts.length !== 6 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null
  return parts.map(Number)
}

/** Why `netId` / `port` cannot be used, or ''. An empty Net ID is the runtime on this PC. */
function checkTarget(netId, port) {
  if (typeof netId !== 'string' || (netId !== '' && !netIdBytes(netId))) return `${netId || 'that'} is not an AMS Net ID (six numbers, like 192.168.1.20.1.1)`
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `${port} is not an AMS port (851 is the first PLC)`
  return ''
}

/** A symbol name as ADS takes it: the name's bytes and a terminating zero. */
const nameBytes = (name) => Buffer.from(`${name}\0`, 'latin1')

/** The value accessors for an ADS data type, little-endian as TwinCAT holds it; null for a type no scene value travels as. */
function codec(adsType) {
  switch (adsType) {
    case 33: return { size: 1, get: (b, o) => b[o] !== 0, set: (b, o, v) => b.writeUInt8(v ? 1 : 0, o) }
    case 16: return { size: 1, get: (b, o) => b.readInt8(o), set: (b, o, v) => b.writeInt8(v, o) }
    case 17: return { size: 1, get: (b, o) => b.readUInt8(o), set: (b, o, v) => b.writeUInt8(v, o) }
    case 2: return { size: 2, get: (b, o) => b.readInt16LE(o), set: (b, o, v) => b.writeInt16LE(v, o) }
    case 18: return { size: 2, get: (b, o) => b.readUInt16LE(o), set: (b, o, v) => b.writeUInt16LE(v, o) }
    case 3: return { size: 4, get: (b, o) => b.readInt32LE(o), set: (b, o, v) => b.writeInt32LE(v, o) }
    case 19: return { size: 4, get: (b, o) => b.readUInt32LE(o), set: (b, o, v) => b.writeUInt32LE(v, o) }
    case 4: return { size: 4, get: (b, o) => b.readFloatLE(o), set: (b, o, v) => b.writeFloatLE(v, o) }
    case 5: return { size: 8, get: (b, o) => b.readDoubleLE(o), set: (b, o, v) => b.writeDoubleLE(v, o) }
    default: return null
  }
}

/**
 * An AdsSymbolEntry (TcAdsDef.h): entryLength, iGroup, iOffs, size, dataType, flags (u32 each), then the name, type
 * and comment lengths (u16 each) and the zero-terminated name, then type name.
 */
function parseSymbolEntry(buf, length) {
  if (length < 30) return null
  const size = buf.readUInt32LE(12)
  const adsType = buf.readUInt32LE(16)
  const nameLength = buf.readUInt16LE(24)
  const typeLength = buf.readUInt16LE(26)
  const typeAt = 30 + nameLength + 1
  const typeName = typeAt + typeLength <= length ? buf.toString('latin1', typeAt, typeAt + typeLength) : ''
  const name = 30 + nameLength <= length ? buf.toString('latin1', 30, 30 + nameLength) : ''
  return { size, adsType, typeName, name }
}

/**
 * The runtime's symbol table (SYM_UPLOAD): AdsSymbolEntry records back to back, each starting with its own length.
 * A record that runs past the buffer, or claims less than a header, ends the walk: what came before it stands.
 */
function parseSymbolTable(buf) {
  const out = []
  let at = 0
  while (at + 30 <= buf.length) {
    const length = buf.readUInt32LE(at)
    if (length < 30 || at + length > buf.length) break
    const e = parseSymbolEntry(buf.subarray(at, at + length), length)
    if (e && e.name) out.push(e)
    at += length
  }
  return out
}

class AdsLink {
  constructor() {
    this.port = 0
    this.addr = null
    this.localNetId = ''
    /** @type {Map<string, {handle: number, adsType: number, size: number}>} */
    this.symbols = new Map()
    this.closed = false
    /** one ADS call sequence at a time on this port: bind and exchange never interleave */
    this.queue = Promise.resolve()
  }

  serial(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  /** Open an ADS port on this PC's router and say where requests go. Nothing is sent to the PLC yet. */
  async open({ netId, port }) {
    const bad = checkTarget(netId, port)
    if (bad) return { error: bad }
    const f = tcAds()
    if (!f) return { error: loadError }
    this.port = await call(f.portOpen)
    if (this.port <= 0) return { error: `TwinCAT's router refused to open an ADS port (${this.port}): is the TwinCAT system service running?` }
    const local = {}
    const err = await call(f.localAddress, this.port, local)
    if (err) return { error: `TwinCAT's router has no address for this PC (0x${err.toString(16)}): is the TwinCAT system service running?` }
    this.localNetId = local.netId.join('.')
    await call(f.setTimeout, this.port, ANSWER_MS)
    this.addr = { netId: netId ? netIdBytes(netId) : local.netId, port }
    return { error: '', localNetId: this.localNetId, target: `${this.addr.netId.join('.')}:${port}` }
  }

  /** The runtime's ADS state (5 = Run, 6 = Stop, 15 = Config ...), or the code that came back instead. */
  async state() {
    const ads = [0]
    const dev = [0]
    const err = await call(lib.readState, this.port, this.addr, ads, dev)
    return err ? { code: err } : { code: 0, ads: ads[0], device: dev[0] }
  }

  /** Release every handle this link holds: a handle lives in the PLC until it is released or the PLC is downloaded again. */
  async release() {
    const handles = [...this.symbols.values()].map((s) => s.handle)
    this.symbols.clear()
    for (const h of handles) {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(h)
      await call(lib.write, this.port, this.addr, SYM_RELEASEHND, 0, 4, b).catch(() => 0)
    }
  }

  /**
   * Ask the runtime for each symbol's info and a handle, as oip-comms init_ads_tag does. Per symbol `{code: 0, adsType,
   * size, typeName}`, or the ADS code that came back. Handles from a previous bind are released first: a PLC that was
   * downloaded again may have moved its symbols.
   */
  bind(list) {
    return this.serial(async () => {
      if (!lib || !this.addr) return { error: loadError ?? 'not connected' }
      await this.release()
      const out = []
      for (const t of list) {
        const name = String(t.name)
        const info = Buffer.alloc(1024)
        const got = [0]
        const req = nameBytes(name)
        let code = await call(lib.readWrite, this.port, this.addr, SYM_INFOBYNAMEEX, 0, info.length, info, req.length, req, got)
        const entry = code ? null : parseSymbolEntry(info, got[0])
        if (!code && !entry) code = 0x705
        if (code) {
          out.push({ code })
          continue
        }
        const hb = Buffer.alloc(4)
        code = await call(lib.readWrite, this.port, this.addr, SYM_HNDBYNAME, 0, 4, hb, req.length, req, got)
        if (code) {
          out.push({ code })
          continue
        }
        this.symbols.set(name, { handle: hb.readUInt32LE(0), adsType: entry.adsType, size: entry.adsType === 33 ? Math.max(1, entry.size) : entry.size })
        out.push({ code: 0, adsType: entry.adsType, size: entry.size, typeName: entry.typeName })
      }
      return { error: '', tags: out }
    })
  }

  /**
   * Every symbol the runtime publishes, as `{name, adsType, size, typeName}`, for the tag picker: the table's size first
   * (SYM_UPLOADINFO2), then the table itself in one request, under a longer timeout than a cycle's. Variables only, as
   * the runtime lists them (`MAIN.Run`, `GVL.Speed`, `MAIN.tCycle` of type TON): a structure's members are not listed.
   */
  listSymbols() {
    return this.serial(async () => {
      if (!lib || !this.addr) return { error: loadError ?? 'not connected' }
      for (let attempt = 0; ; attempt++) {
        const info = Buffer.alloc(24)
        const got = [0]
        let code = await call(lib.read, this.port, this.addr, SYM_UPLOADINFO2, 0, info.length, info, got)
        if (code) return { error: '', code }
        const tableSize = info.readUInt32LE(4)
        if (tableSize === 0) return { error: '', code: 0, symbols: [] }
        if (tableSize > MAX_UPLOAD) return { error: `the PLC's symbol table is ${Math.round(tableSize / 1e6)} MB, too large to list` }
        const table = Buffer.alloc(tableSize)
        await call(lib.setTimeout, this.port, UPLOAD_MS)
        try {
          code = await call(lib.read, this.port, this.addr, SYM_UPLOAD, 0, table.length, table, got)
        } finally {
          await call(lib.setTimeout, this.port, ANSWER_MS)
        }
        if (code === INVALID_SIZE && attempt === 0) continue
        if (code) return { error: '', code }
        return { error: '', code: 0, symbols: parseSymbolTable(table.subarray(0, got[0])) }
      }
    })
  }

  /**
   * One cycle: every write in one SUM request, every read in another. Per item the ADS code (0 = done); a read's value
   * comes with it. A whole request that fails gives every item in it that request's code.
   */
  exchange(writes, reads) {
    return this.serial(async () => {
      if (!lib || !this.addr || this.closed) return { error: 'not connected' }
      const w = writes.map((x) => ({ s: this.symbols.get(String(x.name)), value: x.value }))
      const writeCodes = await this.sumWrite(w)
      const r = reads.map((name) => this.symbols.get(String(name)))
      const readResults = await this.sumRead(r)
      if (this.closed) return { error: 'not connected' }
      return { error: '', writes: writeCodes, reads: readResults }
    })
  }

  async sumWrite(items) {
    const codes = items.map((it) => (it.s && codec(it.s.adsType) ? 0 : 0x710))
    const live = items.map((it, i) => ({ ...it, i })).filter((it) => codes[it.i] === 0)
    for (let at = 0; at < live.length; at += MAX_SUM) {
      const batch = live.slice(at, at + MAX_SUM)
      const head = Buffer.alloc(12 * batch.length)
      const data = []
      batch.forEach((it, k) => {
        const c = codec(it.s.adsType)
        head.writeUInt32LE(SYM_VALBYHND, k * 12)
        head.writeUInt32LE(it.s.handle, k * 12 + 4)
        head.writeUInt32LE(c.size, k * 12 + 8)
        const v = Buffer.alloc(c.size)
        c.set(v, 0, it.value)
        data.push(v)
      })
      const req = Buffer.concat([head, ...data])
      const res = Buffer.alloc(4 * batch.length)
      const got = [0]
      const err = await call(lib.readWrite, this.port, this.addr, SUMUP_WRITE, batch.length, res.length, res, req.length, req, got)
      if (err === SERVICE_NOT_SUPPORTED) {
        for (const it of batch) {
          const c = codec(it.s.adsType)
          const v = Buffer.alloc(c.size)
          c.set(v, 0, it.value)
          codes[it.i] = await call(lib.write, this.port, this.addr, SYM_VALBYHND, it.s.handle, c.size, v)
        }
        continue
      }
      batch.forEach((it, k) => (codes[it.i] = err || (got[0] >= 4 * (k + 1) ? res.readUInt32LE(4 * k) : 0x705)))
    }
    return codes
  }

  async sumRead(symbols) {
    const out = symbols.map((s) => (s && codec(s.adsType) ? null : { value: null, status: 0x710 }))
    const live = symbols.map((s, i) => ({ s, i })).filter((it) => out[it.i] === null)
    for (let at = 0; at < live.length; at += MAX_SUM) {
      const batch = live.slice(at, at + MAX_SUM)
      const req = Buffer.alloc(12 * batch.length)
      let bytes = 0
      batch.forEach((it, k) => {
        const c = codec(it.s.adsType)
        req.writeUInt32LE(SYM_VALBYHND, k * 12)
        req.writeUInt32LE(it.s.handle, k * 12 + 4)
        req.writeUInt32LE(c.size, k * 12 + 8)
        bytes += c.size
      })
      const res = Buffer.alloc(4 * batch.length + bytes)
      const got = [0]
      const err = await call(lib.readWrite, this.port, this.addr, SUMUP_READ, batch.length, res.length, res, req.length, req, got)
      if (err === SERVICE_NOT_SUPPORTED) {
        for (const it of batch) {
          const c = codec(it.s.adsType)
          const v = Buffer.alloc(c.size)
          const n = [0]
          const code = await call(lib.read, this.port, this.addr, SYM_VALBYHND, it.s.handle, c.size, v, n)
          out[it.i] = code ? { value: null, status: code } : { value: c.get(v, 0), status: 0 }
        }
        continue
      }
      // the answer: every sub-request's code first, then the values in order (a failed one still takes its bytes)
      let off = 4 * batch.length
      batch.forEach((it, k) => {
        const c = codec(it.s.adsType)
        const code = err || (got[0] >= off + c.size ? res.readUInt32LE(4 * k) : 0x705)
        out[it.i] = code ? { value: null, status: code } : { value: c.get(res, off), status: 0 }
        off += c.size
      })
    }
    return out
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.serial(async () => {
      if (!lib || this.port <= 0) return
      await this.release()
      await call(lib.portClose, this.port)
      this.port = 0
    })
  }
}

/** @type {Map<string, AdsLink>} by linkKey (linkKeys.cjs) */
const links = new Map()
const watched = new Set()

/** Close every link (the app calls this on quit, so the router lets its ports go). */
async function shutdownAds() {
  const all = [...links.values()]
  links.clear()
  await Promise.all(all.map((l) => l.close()))
}

/**
 * Register the `ads:*` channels. Each call may name one of the window's links as `link` (linkKeys.cjs), 0 when absent.
 *   ads:open     {netId, port} -> {error, localNetId, target}   an ADS port on this PC's router; '' netId = this PC's runtime
 *   ads:bind     {tags: [{name}]} -> {error, tags: [{code, adsType, size, typeName}]}
 *                                                              each symbol's info and a handle
 *   ads:exchange {writes: [{name, value}], reads: [name]} -> {error, writes: [code], reads: [{value, status}]}
 *   ads:symbols  {} -> {error, code, symbols: [{name, adsType, size, typeName}]}
 *                                                              the runtime's whole symbol table, for the tag picker
 *   ads:close                                                  release the handles and the port
 * A code is an ADS return code, 0 for done (src/core/io/ads.ts says what each means).
 * `consent` (endpointConsent.cjs `allows`) is asked before a link to another PC's runtime.
 */
function registerAdsIo(ipcMain, { consent }) {
  ipcMain.handle('ads:open', async (event, opts) => {
    const sender = event.sender
    const n = listingLinkNo(opts)
    if (n === null) return { error: BAD_LINK }
    const key = linkKey(sender.id, n)
    const old = links.get(key)
    links.delete(key)
    await old?.close()
    const netId = typeof opts?.netId === 'string' ? opts.netId.trim() : ''
    const port = Number(opts?.port)
    const bad = checkTarget(netId, port)
    if (bad) return { error: bad }
    // the router decides where a Net ID is, so "this PC" is the empty one; any other may be across the network
    if (netId && consent && !(await consent({ host: netId, key: `ads ${netId}:${port}`, what: `connect to the TwinCAT runtime ${netId} (AMS port ${port}) over ADS` }, sender)))
      return { error: `the connection to ${netId} was not allowed` }
    const link = new AdsLink()
    const opened = await link.open({ netId, port })
    if (opened.error) {
      await link.close()
      return opened
    }
    links.set(key, link)
    onPageGone(sender, watched, (id) => {
      for (const k of windowKeys(links, id)) {
        void links.get(k)?.close()
        links.delete(k)
      }
    })
    return opened
  })
  const withLink = async (event, opts, fn) => {
    const n = listingLinkNo(opts)
    if (n === null) return { error: BAD_LINK }
    const link = links.get(linkKey(event.sender.id, n))
    if (!link) return { error: 'not connected' }
    try {
      return await fn(link)
    } catch (e) {
      return { error: String(e?.message ?? e) }
    }
  }
  ipcMain.handle('ads:bind', (event, opts) => withLink(event, opts, (l) => l.bind(Array.isArray(opts?.tags) ? opts.tags : [])))
  ipcMain.handle('ads:symbols', (event, opts) => withLink(event, opts, (l) => l.listSymbols()))
  ipcMain.handle('ads:exchange', (event, opts) => withLink(event, opts, (l) => l.exchange(Array.isArray(opts?.writes) ? opts.writes : [], Array.isArray(opts?.reads) ? opts.reads : [])))
  ipcMain.handle('ads:close', async (event, opts) => {
    const n = listingLinkNo(opts)
    if (n === null) return
    const key = linkKey(event.sender.id, n)
    const link = links.get(key)
    links.delete(key)
    await link?.close()
  })
}

module.exports = { registerAdsIo, AdsLink, shutdownAds, checkTarget, dllCandidates, parseSymbolEntry, parseSymbolTable, codec }
