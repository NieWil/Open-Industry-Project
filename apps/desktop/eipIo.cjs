// The desktop shell's half of an EtherNet/IP link: libplctag, called through koffi, and nothing about the scene.
//
// libplctag (MPL-2.0 / LGPL-2.0+, https://github.com/libplctag/libplctag) speaks CIP to a Logix or Micro800 controller: it
// opens the session, forwards the connection through the path (`1,0`: the backplane, slot 0), packs requests and
// reconnects on its own thread. The app decides everything else - which tags travel, which way, and what a value
// means (src/core/io/eip.ts, src/editor/links/externalPlc.ts). This file only turns those decisions into library calls.
//
// Nothing here blocks main. Every create, read and write is started with a timeout of 0, which returns at once
// (PLCTAG_STATUS_PENDING), and finished by polling plc_tag_status on a timer. A synchronous call would freeze every
// window of the app for as long as a dead PLC takes to time out.
//
// The library is a native file the build fetches (scripts/fetch-libplctag.mjs -> vendor/libplctag/), loaded on
// the first connect: most sessions never use EtherNet/IP. A build without it says so instead of crashing.
//
// One link per controller in a window (linkKeys.cjs), all closed with it. Plain Node - testable against libplctag's own simulator with
// `node apps/desktop/eipIo.test.cjs`.

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { BAD_LINK, linkKey, listingLinkNo, onPageGone, windowKeys } = require('./linkKeys.cjs')

/** The library file for this platform, as the fetch script names it. */
const LIB_FILE = process.platform === 'win32' ? 'plctag.dll' : process.platform === 'darwin' ? 'libplctag.dylib' : 'libplctag.so'

/** Where the fetched library lives: beside this file, outside the asar in a packaged app (a native file cannot load from inside it). */
function libraryPath() {
  if (process.env.OIP_LIBPLCTAG) return process.env.OIP_LIBPLCTAG
  return join(__dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1'), 'vendor', 'libplctag', LIB_FILE)
}

const STATUS_PENDING = 1
const STATUS_OK = 0
/** How often a pending request is looked at: short against a 20 ms cycle, long enough not to spin. */
const POLL_MS = 2
/** How long one request may take before it is abandoned: the app's watchdog has de-energised the PLC's outputs after a second. */
const ANSWER_MS = 1000
/** How long one tag listing may take: a single read carrying every tag's name, far larger than a cycle's. */
const LIST_MS = 10000
/** A program as the controller's listing names it; its own tags are listed by reading `<name>.@tags`. */
const PROGRAM = /^Program:[A-Za-z_][A-Za-z0-9_]*$/

let lib = null
let loadError = null
/** Load libplctag once; null (with `loadError`) when this build has none. */
function plctag() {
  if (lib || loadError) return lib
  const file = libraryPath()
  try {
    if (!existsSync(file)) throw new Error(`${file} is missing`)
    const koffi = require('koffi')
    const so = koffi.load(file)
    const f = {
      create: so.func('int32_t plc_tag_create(const char *attrib, int timeout)'),
      destroy: so.func('int plc_tag_destroy(int32_t tag)'),
      abort: so.func('int plc_tag_abort(int32_t tag)'),
      status: so.func('int plc_tag_status(int32_t tag)'),
      read: so.func('int plc_tag_read(int32_t tag, int timeout)'),
      write: so.func('int plc_tag_write(int32_t tag, int timeout)'),
      decode: so.func('const char *plc_tag_decode_error(int err)'),
      size: so.func('int plc_tag_get_size(int32_t tag)'),
      rawBytes: so.func('int plc_tag_get_raw_bytes(int32_t tag, int start, _Out_ uint8_t *buf, int len)'),
      intAttr: so.func('int plc_tag_get_int_attribute(int32_t tag, const char *name, int dflt)'),
      bytesAttr: so.func('int plc_tag_get_byte_array_attribute(int32_t tag, const char *name, _Out_ uint8_t *buf, int len)'),
      shutdown: so.func('void plc_tag_shutdown(void)'),
      getBit: so.func('int plc_tag_get_bit(int32_t tag, int bit)'),
      setBit: so.func('int plc_tag_set_bit(int32_t tag, int bit, int val)'),
      getU8: so.func('uint8_t plc_tag_get_uint8(int32_t tag, int off)'),
      setU8: so.func('int plc_tag_set_uint8(int32_t tag, int off, uint8_t v)'),
      getI8: so.func('int8_t plc_tag_get_int8(int32_t tag, int off)'),
      setI8: so.func('int plc_tag_set_int8(int32_t tag, int off, int8_t v)'),
      getI16: so.func('int16_t plc_tag_get_int16(int32_t tag, int off)'),
      setI16: so.func('int plc_tag_set_int16(int32_t tag, int off, int16_t v)'),
      getU16: so.func('uint16_t plc_tag_get_uint16(int32_t tag, int off)'),
      setU16: so.func('int plc_tag_set_uint16(int32_t tag, int off, uint16_t v)'),
      getI32: so.func('int32_t plc_tag_get_int32(int32_t tag, int off)'),
      setI32: so.func('int plc_tag_set_int32(int32_t tag, int off, int32_t v)'),
      getU32: so.func('uint32_t plc_tag_get_uint32(int32_t tag, int off)'),
      setU32: so.func('int plc_tag_set_uint32(int32_t tag, int off, uint32_t v)'),
      getF32: so.func('float plc_tag_get_float32(int32_t tag, int off)'),
      setF32: so.func('int plc_tag_set_float32(int32_t tag, int off, float v)'),
      getF64: so.func('double plc_tag_get_float64(int32_t tag, int off)'),
      setF64: so.func('int plc_tag_set_float64(int32_t tag, int off, double v)'),
    }
    // the API this file is written against: 2.7 added nothing it uses, but older builds lack raw_tag_type_bytes
    const major = f.intAttr(0, 'version_major', 0)
    const minor = f.intAttr(0, 'version_minor', 0)
    if (major !== 2 || minor < 6) throw new Error(`libplctag ${major}.${minor} is too old (2.6 or later is needed)`)
    lib = f
  } catch (e) {
    loadError = `EtherNet/IP needs libplctag, which this build of the app could not load (${String(e?.message ?? e).split('\n')[0]})`
  }
  return lib
}

/** The value accessors for a CIP type code, or null for a type no scene value travels as. */
function accessors(f, cip) {
  switch (cip) {
    case 0xc1: return { get: (t) => f.getU8(t, 0) !== 0, set: (t, v) => f.setU8(t, 0, v ? 1 : 0) }
    case 0xc2: return { get: (t) => f.getI8(t, 0), set: (t, v) => f.setI8(t, 0, v) }
    case 0xc3: return { get: (t) => f.getI16(t, 0), set: (t, v) => f.setI16(t, 0, v) }
    case 0xc4: return { get: (t) => f.getI32(t, 0), set: (t, v) => f.setI32(t, 0, v) }
    case 0xc6: return { get: (t) => f.getU8(t, 0), set: (t, v) => f.setU8(t, 0, v) }
    case 0xc7: return { get: (t) => f.getU16(t, 0), set: (t, v) => f.setU16(t, 0, v) }
    case 0xc8: return { get: (t) => f.getU32(t, 0), set: (t, v) => f.setU32(t, 0, v) }
    case 0xca: return { get: (t) => f.getF32(t, 0), set: (t, v) => f.setF32(t, 0, v) }
    case 0xcb: return { get: (t) => f.getF64(t, 0), set: (t, v) => f.setF64(t, 0, v) }
    default: return null
  }
}
/** A bit member (`Status.3`): libplctag knows which bit from the name, so offset 0 means "the tag's bit". */
const BIT = { get: (f, t) => f.getBit(t, 0) === 1, set: (f, t, v) => f.setBit(t, 0, v ? 1 : 0) }

/**
 * Why `gateway` / `path` cannot be used, or ''. Both go into libplctag's attribute string as they are, so anything
 * beyond a host[:port] and a list of numbers is refused here, before it could add an attribute of its own.
 */
function checkTarget(gateway, path) {
  if (typeof gateway !== 'string' || !/^[A-Za-z0-9._-]{1,253}(:\d{1,5})?$/.test(gateway)) return `${gateway || 'an empty address'} is not a host name or IP address`
  if (typeof path !== 'string' || !/^(\d{1,3}(,\d{1,3})*)?$/.test(path)) return `${path} is not a path (like 1,0: the backplane, then the controller's slot)`
  return ''
}

/** libplctag's `plc` attribute for each controller family the link offers. */
const FAMILIES = { logix: 'ControlLogix', micro800: 'Micro800' }

/** Why `family` cannot be used with `path`, or ''. */
function checkFamily(family, path) {
  if (!Object.hasOwn(FAMILIES, family)) return `${family} is not a controller family this link knows (logix, micro800)`
  if (family === 'micro800' && path) return 'a Micro800 takes no path: give the address of the controller itself'
  return ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * libplctag's tag listing (a read of `@tags`, or `Program:Main.@tags` for one program's), entries back to back: the
 * tag's instance id (u32), symbol type (u16), element size (u16), three array dimensions (u32 each), then the name's
 * length (u16) and the name. An entry that runs past the buffer ends the walk: what came before it stands.
 */
function parseTagListing(buf) {
  const out = []
  let at = 0
  while (at + 22 <= buf.length) {
    const length = buf.readUInt16LE(at + 20)
    if (at + 22 + length > buf.length) break
    out.push({ name: buf.toString('latin1', at + 22, at + 22 + length), type: buf.readUInt16LE(at + 4) })
    at += 22 + length
  }
  return out
}

class EipLink {
  constructor() {
    /** @type {Map<string, {handle: number, bit: boolean, cip: number | null}>} */
    this.tags = new Map()
    /** the controller's attributes; `base` adds the element count a tag's handle takes */
    this.where = ''
    this.base = ''
    this.closed = false
  }

  /**
   * Where the controller is: `gateway` is host[:port], `path` the route to its CPU (`1,0`), '' for none. `family` is
   * 'logix' (ControlLogix, CompactLogix) or 'micro800'; a Micro800 is always reached at its own port, so it takes no path.
   */
  open({ gateway, path, family = 'logix' }) {
    const bad = checkTarget(gateway, path) || checkFamily(family, path)
    if (bad) return { error: bad }
    const f = plctag()
    if (!f) return { error: loadError }
    this.where = `protocol=ab-eip&gateway=${gateway}${path ? `&path=${path}` : ''}&plc=${FAMILIES[family]}`
    this.base = `${this.where}&elem_count=1`
    return { error: '' }
  }

  /** Wait until every handle has finished its request (or `ms` passes, which aborts it); their statuses by name. */
  async settle(handles, ms = ANSWER_MS) {
    const f = lib
    const until = Date.now() + ms
    const status = handles.map((h) => (h < 0 ? h : STATUS_PENDING))
    for (;;) {
      let pending = false
      for (let i = 0; i < handles.length; i++) {
        if (status[i] !== STATUS_PENDING) continue
        status[i] = f.status(handles[i])
        if (status[i] === STATUS_PENDING) pending = true
      }
      if (!pending || this.closed) break
      if (Date.now() > until) {
        for (let i = 0; i < handles.length; i++) {
          if (status[i] !== STATUS_PENDING) continue
          f.abort(handles[i])
          status[i] = -32 // PLCTAG_ERR_TIMEOUT
        }
        break
      }
      await sleep(POLL_MS)
    }
    return status.map((s) => (s === STATUS_OK ? 'ok' : f.decode(s)))
  }

  /**
   * Create a handle per tag and read each once, which is how the controller says what type it holds. Per tag:
   * `{status: 'ok', cip}`, or the library's status name (PLCTAG_ERR_NOT_FOUND ...). Handles from a previous bind are
   * let go first: a controller that was re-downloaded may have changed its tags.
   */
  async bind(list) {
    const f = lib
    if (!f) return { error: loadError ?? 'not connected' }
    this.release()
    const names = list.map((t) => String(t.name))
    // a name goes into the attribute string as it is, so one that could add an attribute is refused here too
    const handles = names.map((name) => (/^[A-Za-z0-9_:.[\],]+$/.test(name) ? f.create(`${this.base}&name=${name}`, 0) : -7 /* BAD_PARAM */))
    const created = await this.settle(handles)
    const reading = handles.map((h, i) => (created[i] === 'ok' ? (f.read(h, 0), h) : -1))
    const read = await this.settle(reading)
    const out = []
    const type = Buffer.alloc(4)
    for (let i = 0; i < names.length; i++) {
      const status = created[i] === 'ok' ? read[i] : created[i]
      let cip = null
      if (status === 'ok') {
        const n = f.bytesAttr(handles[i], 'raw_tag_type_bytes', type, type.length)
        cip = n >= 1 ? type[0] : null
      }
      if (handles[i] >= 0) this.tags.set(names[i], { handle: handles[i], bit: list[i].bit === true, cip })
      out.push({ status, cip })
    }
    return { error: '', tags: out }
  }

  /**
   * Every tag the controller lists, as `{name, type}` with the symbol type as the listing gives it, for the tag picker:
   * the controller's own tags, then each program's (`Program:Main.Run`). `status` is 'ok', or libplctag's status for
   * the controller's own list; a program whose list fails is left out.
   */
  async listTags() {
    if (!lib || !this.where) return { error: loadError ?? 'not connected' }
    const top = await this.readListing('@tags')
    if (top.status !== 'ok') return { error: '', status: top.status }
    const programs = top.entries.filter((e) => PROGRAM.test(e.name)).map((e) => e.name)
    const scoped = await Promise.all(programs.map((p) => this.readListing(`${p}.@tags`)))
    const tags = top.entries.filter((e) => !e.name.includes(':'))
    scoped.forEach((list, i) => {
      for (const e of list.entries) tags.push({ name: `${programs[i]}.${e.name}`, type: e.type })
    })
    return { error: '', status: 'ok', tags }
  }

  /** Read one listing (`@tags`, `Program:Main.@tags`) through a handle of its own, let go after. */
  async readListing(name) {
    const f = lib
    const h = f.create(`${this.where}&name=${name}`, 0)
    try {
      let [status] = await this.settle([h], LIST_MS)
      if (status === 'ok') {
        f.read(h, 0)
        ;[status] = await this.settle([h], LIST_MS)
      }
      if (status !== 'ok') return { status, entries: [] }
      const size = Math.max(0, f.size(h))
      const buf = Buffer.alloc(size)
      if (size > 0) f.rawBytes(h, 0, buf, size)
      return { status, entries: parseTagListing(buf) }
    } finally {
      if (h >= 0) f.destroy(h)
    }
  }

  /** One cycle: every write and every read started together, then waited on. Per-item statuses as in `bind`. */
  async exchange(writes, reads) {
    const f = lib
    if (!f) return { error: 'not connected' }
    const tag = (name) => this.tags.get(String(name))
    const w = writes.map((x) => {
      const t = tag(x.name)
      const acc = t && (t.bit ? null : accessors(f, t.cip))
      if (!t || (!t.bit && !acc)) return -7
      if (t.bit) BIT.set(f, t.handle, x.value)
      else acc.set(t.handle, x.value)
      const rc = f.write(t.handle, 0)
      return rc === STATUS_PENDING || rc === STATUS_OK ? t.handle : rc
    })
    const r = reads.map((name) => {
      const t = tag(name)
      if (!t || (!t.bit && !accessors(f, t.cip))) return -7
      const rc = f.read(t.handle, 0)
      return rc === STATUS_PENDING || rc === STATUS_OK ? t.handle : rc
    })
    const statuses = await this.settle([...w, ...r])
    if (this.closed) return { error: 'not connected' }
    return {
      error: '',
      writes: statuses.slice(0, w.length),
      reads: reads.map((name, i) => {
        const status = statuses[w.length + i]
        const t = tag(name)
        if (status !== 'ok' || !t) return { value: null, status }
        return { value: t.bit ? BIT.get(f, t.handle) : accessors(f, t.cip).get(t.handle), status }
      }),
    }
  }

  release() {
    for (const t of this.tags.values()) lib?.destroy(t.handle)
    this.tags.clear()
  }

  close() {
    this.closed = true
    this.release()
  }
}

/** @type {Map<string, EipLink>} by linkKey (linkKeys.cjs) */
const links = new Map()
const watched = new Set()

/** Let libplctag's thread go, so a process that used it can exit (the app calls this on quit). */
function shutdownEip() {
  for (const link of links.values()) link.close()
  links.clear()
  lib?.shutdown()
}

/**
 * Register the `eip:*` channels. Each call may name one of the window's links as `link` (linkKeys.cjs), 0 when absent.
 *   eip:open     {gateway, path, family} -> {error}           where the controller is (nothing is sent yet); family
 *                                                            'logix' (the default) or 'micro800'
 *   eip:bind     {tags: [{name, bit}]} -> {error, tags: [{status, cip}]}
 *                                                            a handle per tag, read once for its CIP type
 *   eip:exchange {writes: [{name, value}], reads: [name]} -> {error, writes: [status], reads: [{value, status}]}
 *   eip:tags     {} -> {error, status, tags: [{name, type}]}    every tag the controller lists, for the tag picker
 *   eip:close                                               let every tag go
 * A status is 'ok' or libplctag's name for what went wrong (PLCTAG_ERR_NOT_FOUND, PLCTAG_ERR_TIMEOUT ...).
 * `consent` (endpointConsent.cjs `allows`) is asked before opening a link to another host.
 */
function registerEipIo(ipcMain, { consent }) {
  ipcMain.handle('eip:open', async (event, opts) => {
    const sender = event.sender
    const n = listingLinkNo(opts)
    if (n === null) return { error: BAD_LINK }
    const key = linkKey(sender.id, n)
    links.get(key)?.close()
    links.delete(key)
    const gateway = typeof opts?.gateway === 'string' ? opts.gateway : ''
    const path = typeof opts?.path === 'string' ? opts.path : ''
    // absent from an older renderer, which only knew Logix
    const family = opts?.family === undefined ? 'logix' : opts.family
    const bad = checkTarget(gateway, path) || checkFamily(family, path)
    if (bad) return { error: bad }
    const host = gateway.replace(/:\d+$/, '')
    if (consent && !(await consent({ host, key: `eip ${gateway}`, what: `connect to the EtherNet/IP controller at ${gateway}` }, sender)))
      return { error: `the connection to ${gateway} was not allowed` }
    const link = new EipLink()
    const opened = link.open({ gateway, path, family })
    if (opened.error) return opened
    links.set(key, link)
    onPageGone(sender, watched, (id) => {
      for (const k of windowKeys(links, id)) {
        links.get(k)?.close()
        links.delete(k)
      }
    })
    return { error: '' }
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
  ipcMain.handle('eip:bind', (event, opts) => withLink(event, opts, (l) => l.bind(Array.isArray(opts?.tags) ? opts.tags : [])))
  ipcMain.handle('eip:exchange', (event, opts) => withLink(event, opts, (l) => l.exchange(Array.isArray(opts?.writes) ? opts.writes : [], Array.isArray(opts?.reads) ? opts.reads : [])))
  ipcMain.handle('eip:tags', (event, opts) => withLink(event, opts, (l) => l.listTags()))
  ipcMain.handle('eip:close', (event, opts) => {
    const n = listingLinkNo(opts)
    if (n === null) return
    const key = linkKey(event.sender.id, n)
    links.get(key)?.close()
    links.delete(key)
  })
}

module.exports = { registerEipIo, EipLink, shutdownEip, checkTarget, checkFamily, libraryPath, parseTagListing }
