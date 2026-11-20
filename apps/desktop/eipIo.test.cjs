// Smoke test for eipIo.cjs - the libplctag half of an EtherNet/IP link. Runs with plain Node (no Electron):
// `node apps/desktop/eipIo.test.cjs`. What a tag's type means is tested in src/core/io/eip.test.ts. Here libplctag's
// own Logix simulator (ab_server, fetched beside the library by scripts/fetch-libplctag.mjs) tests the library calls:
// a type per tag, a write-then-read cycle in every type the link carries, a missing tag, a PLC that goes away and
// comes back, one that was never there, and a Micro800 (no path) beside the ControlLogix.
//
// ab_server is a tag table with no program, so nothing here "scans": a write is read back as it was written. It
// answers two things differently from a real controller. Both are pinned below, so a library bump that changes them
// is seen. A missing tag is PLCTAG_ERR_BAD_PARAM; a ControlLogix answers "path destination unknown", which libplctag
// reports as PLCTAG_ERR_NOT_FOUND, and core/io/eip.ts eipStatusMessage reads both the same. And it does not implement
// the read-modify-write service, so writing one bit of a DINT (`Count.3`) is PLCTAG_ERR_UNSUPPORTED here.

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { createServer } = require('node:net')
const { join } = require('node:path')
const { EipLink, checkFamily, checkTarget, parseTagListing, shutdownEip } = require('./eipIo.cjs')

const AB_SERVER = join(__dirname, 'vendor', 'libplctag', process.platform === 'win32' ? 'ab_server.exe' : 'ab_server')
const TAGS = ['Eye:BOOL[1]', 'Run:BOOL[1]', 'Count:DINT[1]', 'Level:INT[1]', 'Speed:REAL[1]', 'Lane:DINT[4]']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** A ControlLogix in slot 0 (or the controller `plc` names), holding TAGS; resolves once it accepts a connection. */
async function abServer(port, plc = ['--plc=ControlLogix', '--path=1,0']) {
  const proc = spawn(AB_SERVER, [...plc, `--port=${port}`, ...TAGS.map((t) => `--tag=${t}`)], { stdio: 'ignore' })
  const until = Date.now() + 5000
  for (;;) {
    const up = await new Promise((resolve) => {
      const sock = require('node:net').connect(port, '127.0.0.1', () => {
        sock.destroy()
        resolve(true)
      })
      sock.on('error', () => resolve(false))
    })
    if (up) return proc
    if (Date.now() > until) throw new Error('ab_server did not start')
    await sleep(50)
  }
}

async function main() {
  assert.ok(existsSync(AB_SERVER), `${AB_SERVER} is missing: run node scripts/fetch-libplctag.mjs`)
  const port = await freePort()
  let server = await abServer(port)
  const links = []
  const link = () => {
    const l = new EipLink()
    links.push(l)
    return l
  }
  try {
    // 0. the address goes into libplctag's attribute string, so nothing else may ride along in it
    assert.equal(checkTarget('10.0.0.5', '1,0'), '')
    assert.equal(checkTarget('plc-1.local:44818', ''), '')
    assert.match(checkTarget('10.0.0.5&path=9', '1,0'), /not a host name/)
    assert.match(checkTarget('10.0.0.5', '1,0&debug=4'), /not a path/)
    assert.equal(checkFamily('logix', '1,0'), '')
    assert.equal(checkFamily('micro800', ''), '')
    assert.match(checkFamily('micro800', '1,0'), /takes no path/)
    assert.match(checkFamily('ControlLogix&debug=4', ''), /not a controller family/)
    assert.match(checkFamily('toString', ''), /not a controller family/)

    // 1. bind: one handle per tag, read once, and the controller's CIP type for each
    const plc = link()
    assert.deepEqual(plc.open({ gateway: `127.0.0.1:${port}`, path: '1,0' }), { error: '' })
    const bound = await plc.bind([{ name: 'Eye' }, { name: 'Run' }, { name: 'Count' }, { name: 'Level' }, { name: 'Speed' }, { name: 'Lane[2]' }, { name: 'Count.3', bit: true }, { name: 'Missing' }, { name: 'Eye&elem_count=9' }])
    assert.equal(bound.error, '')
    assert.deepEqual(
      bound.tags.map((t) => [t.status, t.cip]),
      [['ok', 0xc1], ['ok', 0xc1], ['ok', 0xc4], ['ok', 0xc3], ['ok', 0xca], ['ok', 0xc4], ['ok', 0xc4], ['PLCTAG_ERR_BAD_PARAM', null], ['PLCTAG_ERR_BAD_PARAM', null]],
    )

    // 2. one cycle: every type the link carries written, then read back as it went in
    const wrote = await plc.exchange(
      [
        { name: 'Eye', value: true },
        { name: 'Count', value: 41 },
        { name: 'Level', value: -1200 },
        { name: 'Speed', value: 1.25 },
        { name: 'Lane[2]', value: 7 },
      ],
      [],
    )
    assert.deepEqual(wrote, { error: '', writes: ['ok', 'ok', 'ok', 'ok', 'ok'], reads: [] })
    const read = await plc.exchange([], ['Eye', 'Run', 'Count', 'Level', 'Speed', 'Lane[2]', 'Count.3'])
    assert.deepEqual(read, {
      error: '',
      writes: [],
      reads: [
        { value: true, status: 'ok' },
        { value: false, status: 'ok' },
        { value: 41, status: 'ok' },
        { value: -1200, status: 'ok' },
        { value: 1.25, status: 'ok' },
        { value: 7, status: 'ok' },
        { value: true, status: 'ok' }, // 41 = 0b101001: bit 3 is set
      ],
    })
    // a second client sees the first one's writes: it is the controller's table, not a cache on this side
    const other = link()
    other.open({ gateway: `127.0.0.1:${port}`, path: '1,0' })
    await other.bind([{ name: 'Speed' }])
    assert.deepEqual((await other.exchange([], ['Speed'])).reads, [{ value: 1.25, status: 'ok' }])

    // 3. per-item statuses, not a failed cycle: a tag that was never bound, and ab_server's missing read-modify-write
    const odd = await plc.exchange([{ name: 'Count.3', value: false }, { name: 'Nope', value: 1 }], ['Eye'])
    assert.deepEqual(odd.writes, ['PLCTAG_ERR_UNSUPPORTED', 'PLCTAG_ERR_BAD_PARAM'])
    assert.deepEqual(odd.reads, [{ value: true, status: 'ok' }])

    // 4. a cycle is quick: the session runs one every 20 ms
    const t0 = Date.now()
    for (let i = 0; i < 10; i++) await plc.exchange([{ name: 'Eye', value: i % 2 === 0 }], ['Run', 'Speed'])
    const perCycle = (Date.now() - t0) / 10
    console.log(`  a write + two reads: ${perCycle.toFixed(1)} ms per cycle`)
    assert.ok(perCycle < 100, `a cycle took ${perCycle} ms`)

    // 4b. the tag listing. ab_server does not implement it, so here it says so as a status, quickly, and the link
    // still works. The listing's own layout is checked on bytes built by hand.
    const t3 = Date.now()
    assert.deepEqual(await plc.listTags(), { error: '', status: 'PLCTAG_ERR_UNSUPPORTED' })
    assert.ok(Date.now() - t3 < 1500, `the refused listing took ${Date.now() - t3} ms`)
    assert.equal((await plc.exchange([], ['Eye'])).reads[0].status, 'ok')
    const entry = (name, type) => {
      const b = Buffer.alloc(22 + name.length)
      b.writeUInt32LE(7, 0)
      b.writeUInt16LE(type, 4)
      b.writeUInt16LE(4, 6)
      b.writeUInt16LE(name.length, 20)
      b.write(name, 22, 'latin1')
      return b
    }
    const listing = Buffer.concat([entry('Eye', 0xc1), entry('Program:MainProgram', 0x1068), entry('Recipe', 0x8f21)])
    assert.deepEqual(parseTagListing(listing), [
      { name: 'Eye', type: 0xc1 },
      { name: 'Program:MainProgram', type: 0x1068 },
      { name: 'Recipe', type: 0x8f21 },
    ])
    // an entry cut short ends the walk; what came before it stands
    assert.deepEqual(parseTagListing(listing.subarray(0, listing.length - 2)), [{ name: 'Eye', type: 0xc1 }, { name: 'Program:MainProgram', type: 0x1068 }])

    // 5. the PLC goes away: the next cycle times out (within the link's second), it does not hang
    server.kill()
    await new Promise((r) => server.once('exit', r))
    const t1 = Date.now()
    const gone = await plc.exchange([], ['Eye'])
    assert.deepEqual(gone.reads, [{ value: null, status: 'PLCTAG_ERR_TIMEOUT' }])
    assert.ok(Date.now() - t1 < 1500, `a dead PLC took ${Date.now() - t1} ms to report`)

    // 6. ...and comes back (its table starts empty): a fresh bind reaches it again
    server = await abServer(port)
    const until = Date.now() + 10000
    let back = null
    while (Date.now() < until) {
      const again = await plc.bind([{ name: 'Eye' }])
      if (again.tags[0].status === 'ok') {
        back = await plc.exchange([], ['Eye'])
        break
      }
      await sleep(200)
    }
    assert.deepEqual(back?.reads, [{ value: false, status: 'ok' }])

    // 7. nothing at the address: a timeout, not a hang and not a crash
    const nobody = link()
    nobody.open({ gateway: `127.0.0.1:${await freePort()}`, path: '1,0' })
    const t2 = Date.now()
    assert.deepEqual((await nobody.bind([{ name: 'Eye' }])).tags, [{ status: 'PLCTAG_ERR_TIMEOUT', cip: null }])
    assert.ok(Date.now() - t2 < 1500)

    // 8. a Micro800: no path, the same types and the same cycle. A Logix link aimed at it gets no answer at all
    const m800Port = await freePort()
    const m800 = await abServer(m800Port, ['--plc=Micro800'])
    try {
      const micro = link()
      assert.deepEqual(micro.open({ gateway: `127.0.0.1:${m800Port}`, path: '', family: 'micro800' }), { error: '' })
      const mb = await micro.bind([{ name: 'Eye' }, { name: 'Count' }, { name: 'Level' }, { name: 'Speed' }, { name: 'Lane[2]' }, { name: 'Count.3', bit: true }, { name: 'Missing' }])
      assert.deepEqual(
        mb.tags.map((t) => [t.status, t.cip]),
        [['ok', 0xc1], ['ok', 0xc4], ['ok', 0xc3], ['ok', 0xca], ['ok', 0xc4], ['ok', 0xc4], ['PLCTAG_ERR_BAD_PARAM', null]],
      )
      assert.deepEqual((await micro.exchange([{ name: 'Eye', value: true }, { name: 'Count', value: 41 }, { name: 'Speed', value: 1.25 }], [])).writes, ['ok', 'ok', 'ok'])
      assert.deepEqual((await micro.exchange([], ['Eye', 'Count', 'Speed', 'Count.3'])).reads, [
        { value: true, status: 'ok' },
        { value: 41, status: 'ok' },
        { value: 1.25, status: 'ok' },
        { value: true, status: 'ok' },
      ])
      assert.deepEqual(await micro.listTags(), { error: '', status: 'PLCTAG_ERR_UNSUPPORTED' })
      assert.match(micro.open({ gateway: `127.0.0.1:${m800Port}`, path: '1,0', family: 'micro800' }).error, /takes no path/)
      const wrong = link()
      wrong.open({ gateway: `127.0.0.1:${m800Port}`, path: '1,0' })
      assert.deepEqual((await wrong.bind([{ name: 'Eye' }])).tags, [{ status: 'PLCTAG_ERR_TIMEOUT', cip: null }])
    } finally {
      m800.kill()
    }

    console.log('eipIo: all checks passed')
  } finally {
    for (const l of links) l.close()
    shutdownEip()
    server.kill()
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
