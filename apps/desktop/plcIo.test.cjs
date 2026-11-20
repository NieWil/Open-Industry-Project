// Smoke test for plcIo.cjs - the socket half of an external PLC link. Runs with plain Node (no Electron):
// `node apps/desktop/plcIo.test.cjs`. The Modbus side is tested in src/plc/link/. Here real sockets test the links a
// window keeps, one per controller (linkKeys.cjs): each listens on its own port, each push names its link, a write
// reaches the right connection, and closing one link leaves the others open.

const assert = require('node:assert/strict')
const { connect } = require('node:net')
const { EventEmitter } = require('node:events')
const { registerPlcIo } = require('./plcIo.cjs')

function fakeIpc() {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
    invoke: (channel, sender, opts) => handlers.get(channel)({ sender }, opts),
    send: (channel, sender, msg) => listeners.get(channel)({ sender }, msg),
  }
}

function fakeWindow(id) {
  const pushes = []
  return Object.assign(new EventEmitter(), {
    id,
    pushes,
    isDestroyed: () => false,
    send: (channel, payload) => pushes.push({ channel, ...payload }),
    destroy() {
      this.emit('destroyed')
    },
    // a reload or another page: the window stays, its page does not
    navigate() {
      this.emit('did-navigate')
    },
  })
}

const until = async (what, ok) => {
  for (let i = 0; i < 200; i++) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const dial = (port) =>
  new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })

async function main() {
  const ipc = fakeIpc()
  registerPlcIo(ipc)
  const win = fakeWindow(1)
  const base = 41000 + Math.floor(Math.random() * 2000)

  assert.deepEqual(await ipc.invoke('plcio:listen', win, { link: 1, host: '127.0.0.1', port: base + 1 }), { error: '' })
  assert.deepEqual(await ipc.invoke('plcio:listen', win, { link: 2, host: '127.0.0.1', port: base + 2 }), { error: '' })
  // another window, with a project of its own, on a port this one holds: it is told which, not just that it is taken
  const other = fakeWindow(9)
  const taken = await ipc.invoke('plcio:listen', other, { link: 0, host: '127.0.0.1', port: base + 1 })
  assert.match(taken.error, /in use by another Open Industry Project window/)
  assert.deepEqual(await ipc.invoke('plcio:listen', win, { link: 99, host: '127.0.0.1', port: base + 3 }), { error: 'not a link number (0-31)' })

  const a = await dial(base + 1)
  const b = await dial(base + 2)
  await until('two connections', () => win.pushes.filter((p) => p.channel === 'plcio:connection').length === 2)
  const opened = win.pushes.filter((p) => p.channel === 'plcio:connection')
  const idOf = (link) => opened.find((p) => p.link === link).id
  assert.deepEqual(opened.map((p) => p.link).sort(), [1, 2])

  // bytes come in under their link, and a write by connection number reaches that link's peer
  b.write(Buffer.from([7]))
  await until('data on link 2', () => win.pushes.some((p) => p.channel === 'plcio:data'))
  assert.equal(win.pushes.find((p) => p.channel === 'plcio:data').link, 2)
  const got = new Promise((resolve) => a.once('data', resolve))
  ipc.send('plcio:write', win, { id: idOf(1), bytes: new Uint8Array([9]) })
  assert.deepEqual([...(await got)], [9])

  // closing link 1 drops its peer; link 2 stays open and still carries bytes
  const aClosed = new Promise((resolve) => a.once('close', resolve))
  await ipc.invoke('plcio:close', win, { link: 1 })
  await aClosed
  const bGot = new Promise((resolve) => b.once('data', resolve))
  ipc.send('plcio:write', win, { id: idOf(2), bytes: new Uint8Array([5]) })
  assert.deepEqual([...(await bGot)], [5])

  // a call with no link number is link 0, as the app's default controller sends
  assert.deepEqual(await ipc.invoke('plcio:listen', win, { host: '127.0.0.1', port: base + 4 }), { error: '' })
  const c = await dial(base + 4)
  await until('link 0 connection', () => win.pushes.some((p) => p.channel === 'plcio:connection' && p.link === 0))

  // a reload keeps the window but not the page: every link the page opened closes, and its ports are free again for
  // the next page, which opens only the links its project has
  assert.deepEqual(await ipc.invoke('plcio:listen', win, { link: 3, host: '127.0.0.1', port: base + 5 }), { error: '' })
  const d = await dial(base + 5)
  const reloaded = [b, c, d].map((s) => new Promise((resolve) => s.once('close', resolve)))
  win.navigate()
  await Promise.all(reloaded)
  assert.deepEqual(await ipc.invoke('plcio:listen', win, { link: 3, host: '127.0.0.1', port: base + 5 }), { error: '' })
  assert.deepEqual(await ipc.invoke('plcio:listen', win, { host: '127.0.0.1', port: base + 4 }), { error: '' })
  const e = await dial(base + 5)
  const f = await dial(base + 4)

  // the window going closes every link it holds
  const closed = [e, f].map((s) => new Promise((resolve) => s.once('close', resolve)))
  win.destroy()
  await Promise.all(closed)
  console.log('plcIo: ok')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
