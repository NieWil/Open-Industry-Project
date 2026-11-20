// Tests for mcpServer.cjs - the agent door's MCP transport. Runs with plain Node (no Electron):
// `node apps/desktop/mcpServer.test.cjs`. A stand-in renderer serves two tools; a real HTTP client speaks MCP to
// the server the way Claude Desktop / Claude Code do. What the tools do is tested in src/editor/agent/tools.test.ts;
// the shell and the app together in e2e/verify-agent-mcp-electron.mjs.

const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { AgentHost, MODERN_VERSIONS, PROTOCOL_VERSIONS, handleMessage, readModel, requestEra, startMcpServer } = require('./mcpServer.cjs')

const TOOLS = [
  { name: 'echo', description: 'echo the arguments', inputSchema: { type: 'object' } },
  { name: 'fail', description: 'always refuses', inputSchema: { type: 'object' } },
]

/** A renderer stand-in: answers each forwarded call the way desktopAgent.ts does, on the next tick. */
function fakeWindow(host, id = 1) {
  const win = {
    id,
    destroyed: false,
    calls: [],
    isDestroyed: () => win.destroyed,
    send: (channel, msg) => {
      assert.equal(channel, 'agent:call')
      win.calls.push(msg)
      if (msg.name === 'hang') return // never answers
      setImmediate(() => host.answer(msg.id, msg.name === 'echo' ? { ok: true, text: JSON.stringify(msg.args) } : { ok: false, error: `${msg.name} said no` }))
    },
  }
  return win
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })

async function main() {
  // 1. the JSON-RPC layer on its own
  {
    const host = new AgentHost({ readyWaitMs: 50 })
    let r = await handleMessage(host, rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
    assert.equal(r.result.protocolVersion, '2025-03-26', 'a version it speaks is echoed')
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } })
    assert.match(r.result.instructions, /get_guide/)
    r = await handleMessage(host, rpc(2, 'initialize', { protocolVersion: '1999-01-01' }))
    assert.equal(r.result.protocolVersion, PROTOCOL_VERSIONS[0], 'an unknown version is answered with its own')
    assert.deepEqual((await handleMessage(host, rpc(3, 'ping'))).result, {})
    assert.equal((await handleMessage(host, rpc(4, 'resources/list'))).error.code, -32601)
    assert.equal(await handleMessage(host, { jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a notification has no answer')
    assert.equal((await handleMessage(host, { id: 5, method: 'ping' })).error.code, -32600, 'not JSON-RPC 2.0')
    // no window serves: tools/list waits, then says why
    r = await handleMessage(host, rpc(6, 'tools/list'))
    assert.match(r.error.message, /no editor window/)
    r = await handleMessage(host, rpc(7, 'tools/call', { name: 'echo', arguments: {} }))
    assert.equal(r.result.isError, true)
    assert.match(r.result.content[0].text, /no editor window/)
    console.log('ok: JSON-RPC layer')
  }

  // 1b. a reply with images (capture_view) becomes a text block and an image block per image; junk images drop
  {
    const host = new AgentHost({ readyWaitMs: 50 })
    host.serve({ id: 9, isDestroyed: () => false, send: (_ch, msg) => setImmediate(() => host.answer(msg.id, { ok: true, text: '{"from":"iso"}', images: [{ data: 'AAAA', mimeType: 'image/jpeg' }, { data: 1 }] })) }, TOOLS)
    const r = await handleMessage(host, rpc(1, 'tools/call', { name: 'echo', arguments: {} }))
    assert.deepEqual(r.result.content, [{ type: 'text', text: '{"from":"iso"}' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }])
    console.log('ok: image replies')
  }

  // 1c. import_model reads only a model file, by absolute path
  {
    const dir = mkdtempSync(join(tmpdir(), 'oip-mcp-'))
    try {
      writeFileSync(join(dir, 'm.glb'), Buffer.from([1, 2, 3]))
      writeFileSync(join(dir, 'notes.txt'), 'x')
      const got = await readModel(join(dir, 'm.glb'))
      assert.equal(got.name, 'm.glb')
      assert.deepEqual([...got.bytes], [1, 2, 3])
      assert.match((await readModel(join(dir, 'notes.txt'))).error, /a model is a \.glb, \.step, \.stp, USD .* or URDF/)
      // a USD root brings the layers and images under its folder, keyed from there; hidden folders and other files stay out
      mkdirSync(join(dir, 'payloads'))
      mkdirSync(join(dir, '.thumbs'))
      writeFileSync(join(dir, 'root.usda'), '#usda 1.0')
      writeFileSync(join(dir, 'payloads', 'geo.usdc'), Buffer.from([4]))
      writeFileSync(join(dir, 'payloads', 'albedo.png'), Buffer.from([5]))
      writeFileSync(join(dir, '.thumbs', 'thumb.png'), Buffer.from([6]))
      const usd = await readModel(join(dir, 'root.usda'))
      assert.equal(usd.root, 'root.usda')
      assert.deepEqual(usd.files.map((f) => f.path).sort(), ['payloads/albedo.png', 'payloads/geo.usdc', 'root.usda'])
      // a .usdz is one file
      writeFileSync(join(dir, 'm.usdz'), Buffer.from([7]))
      assert.equal((await readModel(join(dir, 'm.usdz'))).files, undefined)
      // a URDF in a ROS package's urdf folder brings the meshes it names, and nothing else there, keyed from the
      // package folder: package:// from the package, a relative path from the URDF's folder, a missing one left out
      mkdirSync(join(dir, 'arm', 'urdf'), { recursive: true })
      mkdirSync(join(dir, 'arm', 'meshes'))
      writeFileSync(
        join(dir, 'arm', 'urdf', 'arm.urdf'),
        '<robot name="arm"><link name="a"><visual><geometry><mesh filename="package://arm/meshes/link.stl"/></geometry></visual>' +
          "<collision><geometry><mesh filename='../meshes/hull.obj'/></geometry></collision></link>" +
          '<link name="b"><visual><geometry><mesh filename="package://arm/meshes/gone.stl"/></geometry></visual></link></robot>',
      )
      writeFileSync(join(dir, 'arm', 'meshes', 'link.stl'), Buffer.from([8]))
      writeFileSync(join(dir, 'arm', 'meshes', 'hull.obj'), 'v 0 0 0')
      writeFileSync(join(dir, 'arm', 'meshes', 'spare.stl'), Buffer.from([9]))
      const robot = await readModel(join(dir, 'arm', 'urdf', 'arm.urdf'))
      assert.equal(robot.root, 'urdf/arm.urdf')
      assert.deepEqual(robot.files.map((f) => f.path).sort(), ['meshes/hull.obj', 'meshes/link.stl', 'urdf/arm.urdf'])
      // a URDF anywhere in a package with a package.xml finds its package:// meshes from the package folder
      mkdirSync(join(dir, 'pkg', 'robots', 'six'), { recursive: true })
      mkdirSync(join(dir, 'pkg', 'meshes'))
      writeFileSync(join(dir, 'pkg', 'package.xml'), '<package><name>pkg</name></package>')
      writeFileSync(join(dir, 'pkg', 'robots', 'six', 'six.urdf'), '<robot name="six"><link name="a"><visual><geometry><mesh filename="package://pkg/meshes/base.stl"/></geometry></visual></link></robot>')
      writeFileSync(join(dir, 'pkg', 'meshes', 'base.stl'), Buffer.from([8]))
      const six = await readModel(join(dir, 'pkg', 'robots', 'six', 'six.urdf'))
      assert.equal(six.root, 'robots/six/six.urdf')
      assert.deepEqual(six.files.map((f) => f.path).sort(), ['meshes/base.stl', 'robots/six/six.urdf'])
      // a lone URDF beside unrelated files reads only itself
      writeFileSync(join(dir, 'lone.urdf'), '<robot name="lone"/>')
      assert.deepEqual((await readModel(join(dir, 'lone.urdf'))).files.map((f) => f.path), ['lone.urdf'])
      // a xacro reads its ROS package and the packages it $(find)s beside it, robot files only, keyed from their parent
      const ws = join(dir, 'ws')
      for (const d of ['bot_description/urdf', 'bot_description/meshes', 'bot_description/config/a', 'parts_lib/urdf', 'unrelated']) mkdirSync(join(ws, d), { recursive: true })
      writeFileSync(join(ws, 'bot_description', 'package.xml'), '<package><name>bot_description</name></package>')
      writeFileSync(join(ws, 'parts_lib', 'package.xml'), '<package><name>bot_parts</name></package>')
      writeFileSync(join(ws, 'unrelated', 'package.xml'), '<package><name>unrelated</name></package>')
      writeFileSync(join(ws, 'bot_description', 'urdf', 'bot.urdf.xacro'), '<robot xmlns:xacro="http://wiki.ros.org/xacro"><xacro:include filename="$(find bot_parts)/urdf/m.xacro"/></robot>')
      writeFileSync(join(ws, 'bot_description', 'config', 'a', 'limits.yaml'), 'a: 1')
      writeFileSync(join(ws, 'bot_description', 'meshes', 'link.stl'), Buffer.from([8]))
      writeFileSync(join(ws, 'bot_description', 'README.md'), 'x')
      writeFileSync(join(ws, 'parts_lib', 'urdf', 'm.xacro'), '<robot/>')
      writeFileSync(join(ws, 'unrelated', 'u.xacro'), '<robot/>')
      const bot = await readModel(join(ws, 'bot_description', 'urdf', 'bot.urdf.xacro'))
      assert.equal(bot.root, 'bot_description/urdf/bot.urdf.xacro')
      assert.deepEqual(bot.files.map((f) => f.path).sort(), [
        'bot_description/config/a/limits.yaml',
        'bot_description/meshes/link.stl',
        'bot_description/package.xml',
        'bot_description/urdf/bot.urdf.xacro',
        'parts_lib/package.xml',
        'parts_lib/urdf/m.xacro',
      ])
      assert.match((await readModel('m.glb')).error, /absolute path/)
      assert.match((await readModel(join(dir, 'gone.step'))).error, /no such file/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    console.log('ok: model reads')
  }

  // 1d. main's own tools: listed after the window's, run here, never forwarded; their requests to the editor go on
  // agent:shell, and a reload before the answer reads as 'reloading'
  {
    const sent = []
    const own = {
      definition: { name: 'own', description: 'runs in main', inputSchema: { type: 'object' } },
      run: async (h, args) => ({ ok: true, text: JSON.stringify(await h.request('openFolder', args)) }),
    }
    const host = new AgentHost({ readyWaitMs: 50, shellTools: [own] })
    const win = { id: 3, isDestroyed: () => false, send: (ch, msg) => sent.push([ch, msg]) }
    host.serve(win, TOOLS)
    assert.deepEqual((await handleMessage(host, rpc(1, 'tools/list'))).result.tools.map((t) => t.name), ['echo', 'fail', 'own'])
    const call = handleMessage(host, rpc(2, 'tools/call', { name: 'own', arguments: { root: '/p' } }))
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(sent.map(([ch, m]) => [ch, m.op, m.args]), [['agent:shell', 'openFolder', { root: '/p' }]], 'a shell tool asks on agent:shell, not as a tool call')
    host.drop(3, 'the editor reloaded', true)
    assert.equal((await call).result.content[0].text, '{"ok":true,"text":"reloading"}', 'the page reloading answers a shell request')
    // a plain tool call dropped by a reload still fails
    host.serve(win, TOOLS)
    const plain = host.call('hang', {})
    await new Promise((r) => setImmediate(r))
    host.drop(3, 'the editor reloaded', true)
    assert.deepEqual(await plain, { ok: false, error: 'the editor reloaded' })
    // a navigation the page announced says why, once
    host.serve(win, TOOLS)
    const cut = host.call('hang', {})
    await new Promise((r) => setImmediate(r))
    host.leaving(3, 'the dev server reloaded the page after src/render/view.ts changed')
    host.reloaded(3)
    assert.match((await cut).error, /^the editor reloaded \(the dev server reloaded the page after src\/render\/view\.ts changed\); call again/)
    host.serve(win, TOOLS)
    const next1 = host.call('hang', {})
    await new Promise((r) => setImmediate(r))
    host.reloaded(3)
    assert.match((await next1).error, /^the editor reloaded; call again/, 'the reason is not reused for the next reload')
    // nextServe waits for the next announcement, not the one already there
    host.serve(win, TOOLS)
    assert.equal(await host.nextServe(30), false, 'tools already served are not a new announcement')
    const next = host.nextServe(1000)
    host.serve(win, TOOLS)
    assert.equal(await next, true)
    host.serve(win, null)
    assert.equal(await host.nextServe(30), false, 'no window came back')
    console.log('ok: shell tools')
  }

  // 1e. several windows, one project each: calls go to the window focused last; a closed one hands over, a reloading
  // one is waited for
  {
    const host = new AgentHost({ readyWaitMs: 200 })
    const a = fakeWindow(host, 1)
    const b = fakeWindow(host, 2)
    host.serve(a, TOOLS)
    host.serve(b, TOOLS)
    assert.equal(host.servingId(), 1, 'a second window announcing does not take the calls')
    await host.call('echo', { n: 1 })
    assert.equal(a.calls.length, 1)
    host.focus(2)
    assert.equal(host.servingId(), 2, 'the focused window does')
    await host.call('echo', { n: 2 })
    assert.equal(b.calls.length, 1)
    host.focus(3) // a window still booting: calls stay where they are until it serves
    assert.equal(host.servingId(), 2)
    const c = fakeWindow(host, 3)
    host.serve(c, TOOLS)
    assert.equal(host.servingId(), 3, 'and it takes them once it serves')
    host.drop(3, 'the editor window closed')
    assert.equal(host.servingId(), 1, 'a closed window hands its calls to one still open')
    host.focus(1)
    host.drop(1, 'reloaded', true)
    assert.equal(host.servingId(), null, 'a reloading window is waited for, not replaced')
    const pending = host.call('echo', { n: 3 })
    host.serve(a, TOOLS)
    assert.equal((await pending).ok, true)
    assert.equal(host.servingId(), 1)
    console.log('ok: several windows')
  }

  // 2. over HTTP, with a window serving
  const host = new AgentHost({ readyWaitMs: 2000, callTimeoutMs: 300 })
  const started = await startMcpServer(host, { port: 0, version: '1.2.3' })
  assert.equal(started.error, undefined, started.error)
  const url = started.url
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  try {
    // a client that connects before the editor is up waits for it
    const early = post(url, rpc(1, 'tools/list'))
    const win = fakeWindow(host)
    setTimeout(() => host.serve(win, TOOLS), 100)
    let r = await early
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.result.tools.map((t) => t.name), ['echo', 'fail'], 'tools/list waits for the window, then lists its tools')

    r = await post(url, rpc(2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
    assert.equal(r.body.result.serverInfo.version, '1.2.3')

    r = await post(url, rpc(3, 'tools/call', { name: 'echo', arguments: { a: 1 } }))
    assert.deepEqual(r.body.result, { content: [{ type: 'text', text: '{"a":1}' }], isError: false }, 'a call is forwarded and its text returned')
    r = await post(url, rpc(4, 'tools/call', { name: 'fail' }))
    assert.deepEqual(r.body.result, { content: [{ type: 'text', text: 'fail said no' }], isError: true }, 'a refusal is a tool error, not a protocol error')
    r = await post(url, rpc(5, 'tools/call', {}))
    assert.equal(r.body.error.code, -32602)
    r = await post(url, rpc(6, 'tools/call', { name: 'hang' }))
    assert.match(r.body.result.content[0].text, /did not answer within/, 'a call the window never answers times out')
    assert.equal(host.pending.size, 0)

    // notifications and batches
    r = await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(r.status, 202)
    r = await post(url, [rpc(7, 'ping'), { jsonrpc: '2.0', method: 'notifications/cancelled' }, rpc(8, 'ping')])
    assert.deepEqual(r.body.map((m) => m.id), [7, 8], 'a batch answers each request, not the notification')
    r = await post(url, '{not json')
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, -32700)

    // a 2026-07-28 client: no initialize, version and capabilities in _meta, mirrored in headers
    const V = MODERN_VERSIONS[0]
    const meta = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' } }
    const modern = (id, method, params = {}, headers = {}) => {
      const name = params.name ?? params.uri
      return post(url, rpc(id, method, { ...params, _meta: meta }), { 'MCP-Protocol-Version': V, 'Mcp-Method': method, ...(name === undefined ? {} : { 'Mcp-Name': name }), ...headers })
    }
    r = await modern(20, 'server/discover')
    assert.equal(r.status, 200)
    assert.equal(r.body.result.resultType, 'complete')
    assert.deepEqual(r.body.result.supportedVersions, [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS], 'discover names both eras')
    assert.equal(r.body.result._meta['io.modelcontextprotocol/serverInfo'].version, '1.2.3')
    assert.match(r.body.result.instructions, /get_guide/)
    r = await modern(21, 'tools/list')
    assert.deepEqual(r.body.result.tools.map((t) => t.name), ['echo', 'fail'])
    assert.equal(r.body.result.resultType, 'complete')
    assert.equal(typeof r.body.result.ttlMs, 'number', 'a modern list carries a cache hint')
    assert.equal(r.body.result.cacheScope, 'private')
    r = await modern(22, 'tools/call', { name: 'echo', arguments: { b: 2 } })
    assert.equal(r.status, 200)
    assert.equal(r.body.result.content[0].text, '{"b":2}', 'a modern call needs no handshake first')
    assert.equal(r.body.result.resultType, 'complete')
    r = await modern(23, 'tools/call', { name: 'echo', arguments: {} }, { 'Mcp-Name': `=?base64?${Buffer.from('echo').toString('base64')}?=` })
    assert.equal(r.status, 200, 'a base64-sentinel Mcp-Name is decoded before it is compared')
    // a legacy client never sees the modern fields
    r = await post(url, rpc(24, 'tools/call', { name: 'echo', arguments: {} }), { 'MCP-Protocol-Version': '2025-06-18' })
    assert.equal(r.body.result.resultType, undefined)

    // what a modern server must refuse, with 400 and a body a dual-era client recognises
    r = await modern(25, 'tools/call', { name: 'echo' }, { 'Mcp-Name': 'fail' })
    assert.deepEqual([r.status, r.body.error.code], [400, -32020], 'Mcp-Name must match params.name')
    r = await modern(26, 'tools/list', {}, { 'Mcp-Method': 'tools/call' })
    assert.deepEqual([r.status, r.body.error.code], [400, -32020], 'Mcp-Method must match the method')
    r = await post(url, rpc(27, 'tools/list', { _meta: meta }))
    assert.deepEqual([r.status, r.body.error.code], [400, -32020], 'the version header is required')
    r = await post(url, rpc(28, 'tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } }), { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' })
    assert.deepEqual([r.status, r.body.error.code], [400, -32022])
    assert.deepEqual(r.body.error.data, { supported: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS], requested: '2099-01-01' }, 'an unknown version is told what is spoken')
    r = await post(url, rpc(29, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': V } }), { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' })
    assert.deepEqual([r.status, r.body.error.code], [400, -32602], 'clientCapabilities is required')
    r = await modern(30, 'resources/list')
    assert.deepEqual([r.status, r.body.error.code], [404, -32601], 'an unknown method is 404 with a JSON-RPC body')
    assert.equal(requestEra({ jsonrpc: '2.0', method: 'notifications/x' }, { 'mcp-protocol-version': V }).modern, false, 'a notification is never validated')

    // what a web page can reach on loopback is refused
    const port = started.port
    r = await post(url, rpc(9, 'ping'), { Origin: 'https://evil.example' })
    assert.equal(r.status, 403, 'a foreign Origin is refused')
    r = await post(url, rpc(10, 'ping'), { Origin: `http://localhost:${port}` })
    assert.equal(r.status, 200, 'a loopback Origin is allowed')
    // DNS rebinding: the page's own host name arrives in Host (node's http client keeps a Host header we set)
    const rebound = await new Promise((resolve) => {
      const req = require('node:http').request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Host: `attacker.example:${port}`, 'Content-Type': 'application/json' } }, (res) => resolve(res.statusCode))
      req.end(JSON.stringify(rpc(11, 'ping')))
    })
    assert.equal(rebound, 403, 'a foreign Host is refused')
    r = await post(url, rpc(12, 'ping'), { 'Content-Type': 'text/plain' })
    assert.equal(r.status, 415, 'only application/json (a page cannot send it cross-origin without a preflight)')
    let res = await fetch(url)
    assert.equal(res.status, 405, 'GET: no SSE stream')
    res = await fetch(url.replace('/mcp', '/other'), { method: 'POST' })
    assert.equal(res.status, 404)

    // the window goes away: calls in flight fail, and the next list waits for a new one
    const slow = post(url, rpc(13, 'tools/call', { name: 'hang' }))
    await new Promise((r2) => setTimeout(r2, 50))
    host.drop(win.id, 'the editor reloaded')
    r = await slow
    assert.equal(r.body.result.content[0].text, 'the editor reloaded', 'a dropped window fails its calls with the reason')
    const win2 = fakeWindow(host, 2)
    host.serve(win2, TOOLS.slice(0, 1))
    r = await post(url, rpc(14, 'tools/list'))
    assert.deepEqual(r.body.result.tools.map((t) => t.name), ['echo'], 'the new window serves its own list')
    host.serve(win, null) // a window that is not the server withdrawing changes nothing
    assert.equal(host.server.id, 2)
    host.serve(win2, null)
    assert.equal(host.server, null, 'withdrawing clears the server')

    // a second server on the same port says so rather than throwing
    const clash = await startMcpServer(host, { port })
    assert.match(clash.error, /in use/)
    console.log('ok: MCP over HTTP')
  } finally {
    await started.close()
  }
  console.log('\nall mcpServer checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
