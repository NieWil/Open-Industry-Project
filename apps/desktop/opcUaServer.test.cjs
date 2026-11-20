// Smoke test for opcUaServer.cjs - the simulated PLC's OPC UA server. Runs with plain Node (no Electron):
// `node apps/desktop/opcUaServer.test.cjs`. Which variables are published, as what, is tested in
// src/editor/links/opcUaServer.test.ts. Here a real OPC UA client (the shell's own, opcUaIo.cjs) tests the nodes:
// the tree it browses, the types and access it reads, values while running and out of service while not,
// a write reaching the app and a read-only node refusing one, and a redefine keeping the nodes it can.

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { AttributeIds } = require('node-opcua-client')
const { OpcUaLink } = require('./opcUaIo.cjs')
const { SimOpcUaServer } = require('./opcUaServer.cjs')

const PORT = 48431
const NODES = [
  { name: 'Start', builtin: 1, writable: true, value: false },
  { name: 'Eye', builtin: 1, writable: false, value: false },
  { name: 'Speed', builtin: 10, writable: true, value: 0.5 },
  { name: 'Count', builtin: 4, writable: true, value: 0 },
  { name: 'Label', builtin: 12, writable: true, value: 'idle' },
  { name: 'T1.Q', builtin: 1, writable: false, value: false },
  { name: 'T1.ET', builtin: 11, writable: false, value: 0 },
]

async function main() {
  const pki = mkdtempSync(join(tmpdir(), 'oip-opcua-server-'))
  const writes = []
  let clients = []
  const server = new SimOpcUaServer(pki, { onWrite: (name, value) => writes.push([name, value]), onClients: (c) => (clients = c) })
  const link = new OpcUaLink(join(pki, 'client'), () => {})
  try {
    // 1. start, on this machine only, and publish
    const started = await server.start({ port: PORT, network: false })
    assert.equal(started.error, '')
    assert.equal(started.endpoint, `opc.tcp://127.0.0.1:${PORT}`)
    server.define(NODES)

    // 2. a client connects and finds the program under PLC, a function block's outputs in its own folder
    assert.deepEqual(await link.connect(started.endpoint), { error: '' })
    const until = Date.now() + 3000
    while (clients.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
    assert.equal(clients.length, 1, 'the session is reported')
    console.log(`  client: ${clients[0]}`)
    const { variables } = await link.browse()
    const paths = variables.map((v) => v.path.join('.')).sort()
    assert.deepEqual(paths, ['PLC.Count', 'PLC.Eye', 'PLC.Label', 'PLC.Speed', 'PLC.Start', 'PLC.T1.ET', 'PLC.T1.Q'])
    const id = (path) => variables.find((v) => v.path.join('.') === path).nodeId
    assert.match(id('PLC.T1.Q'), /;s=T1\.Q$/, 'a variable\'s NodeId is its name, so a SCADA tag can be written by hand')

    // 3. types and access, as published
    const described = await link.describe([id('PLC.Start'), id('PLC.Eye'), id('PLC.Speed'), id('PLC.Count'), id('PLC.Label')])
    assert.deepEqual(described, [
      { dataType: 'ns=0;i=1', builtin: 1, access: 3 },
      { dataType: 'ns=0;i=1', builtin: 1, access: 1 },
      { dataType: 'ns=0;i=10', builtin: 10, access: 3 },
      { dataType: 'ns=0;i=4', builtin: 4, access: 3 },
      { dataType: 'ns=0;i=12', builtin: 12, access: 3 },
    ])

    // 4. while the simulation is stopped, a read says so and a write is refused
    let r = await link.exchange([{ nodeId: id('PLC.Start'), builtin: 1, value: true }], [id('PLC.Eye')])
    assert.deepEqual(r.reads, [{ value: null, status: 'BadOutOfService' }])
    assert.deepEqual(r.writes, ['BadInvalidState'])
    assert.equal(writes.length, 0)

    // 5. running: the values the app pushes, and writes reach the app
    server.update({ Eye: true, Speed: 1.25, Count: 7, Label: 'running', 'T1.ET': 250 }, true)
    r = await link.exchange(
      [
        { nodeId: id('PLC.Start'), builtin: 1, value: true },
        { nodeId: id('PLC.Count'), builtin: 4, value: 42 },
      ],
      [id('PLC.Eye'), id('PLC.Speed'), id('PLC.Count'), id('PLC.Label'), id('PLC.T1.ET')],
    )
    assert.deepEqual(r.writes, ['Good', 'Good'])
    assert.deepEqual(writes, [
      ['Start', true],
      ['Count', 42],
    ])
    assert.deepEqual(
      r.reads.map((x) => x.value),
      [true, 1.25, 42, 'running', 250],
    )
    // a read-only variable (an input the scene feeds) refuses a client
    r = await link.exchange([{ nodeId: id('PLC.Eye'), builtin: 1, value: false }], [])
    assert.deepEqual(r.writes, ['BadNotWritable'])
    assert.equal(writes.length, 2)

    // 6. a redefine keeps what is unchanged (same node) and drops what went, folder and all
    const before = id('PLC.Start')
    server.define(NODES.filter((n) => !n.name.startsWith('T1.')).concat([{ name: 'Main.Run', builtin: 1, writable: true, value: true }]))
    const again = (await link.browse()).variables.map((v) => v.path.join('.')).sort()
    assert.deepEqual(again, ['PLC.Count', 'PLC.Eye', 'PLC.Label', 'PLC.Main.Run', 'PLC.Speed', 'PLC.Start'])
    const dv = await link.session.read({ nodeId: before, attributeId: AttributeIds.Value })
    assert.equal(dv.statusCode.name, 'Good', 'a node kept across a redefine still answers')

    // 7. the port taken: said in words
    const second = new SimOpcUaServer(pki, { onWrite() {}, onClients() {} })
    const taken = await second.start({ port: PORT, network: false })
    assert.equal(taken.error, `port ${PORT} is already in use on this machine`)

    // 8. the client leaves
    await link.close()
    const gone = Date.now() + 3000
    while (clients.length > 0 && Date.now() < gone) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(clients, [])
    console.log('opcUaServer: all checks passed')
  } finally {
    await link.close().catch(() => {})
    await server.stop()
    rmSync(pki, { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
