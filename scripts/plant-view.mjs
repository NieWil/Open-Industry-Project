#!/usr/bin/env node
// The view of a plant service's run (scripts/plant.mjs --share): the built editor and the collab server on one port,
// so one public address shows the plant to anyone with its view link.
//
//   node scripts/plant-view.mjs [--port 8090] [--host 127.0.0.1] [--collab-port 1234] [--db <collab.sqlite>]
//                                [--room-file <file>] [--client-ip-header <name>]
//
// - every path but /collab is dist/ served the way the real host serves it (apps/desktop/pagesHost.cjs: its
//   headers, its rewrites, its 404), so the view is the production build
// - /collab is the collab server (server/index.mjs), started here on loopback, reached through this port: the
//   WebSocket the view link names (`server=wss://<address>/collab`) and its asset requests
// - with --room-file, the collab server hosts that room only (ONLY_ROOMS): the plant's, and no one else's
// - --client-ip-header names the header that carries the visitor's address when a proxy that sets it is the only
//   way in (a Cloudflare tunnel: CF-Connecting-IP); the collab server's per-address caps then count visitors, not
//   the proxy. Without it, the address of whoever connects counts.
//
// The plant itself runs apart (npm run plant -- --demo --share ws://<this host>:<port>/collab --room-file <file>).
// Exit 1 = dist/ is not built or the collab server would not start, 2 = usage.

import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docNameOf, roomSecret } from './lib/plant-share.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PREFIX = '/collab'

function usage(why) {
  if (why) console.error(`✗ ${why}`)
  console.error('usage: node scripts/plant-view.mjs [--port 8090] [--host 127.0.0.1] [--collab-port 1234] [--db <file>] [--room-file <file>] [--client-ip-header <name>]')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { port: 8090, host: '127.0.0.1', collabPort: 1234, db: 'collab.sqlite', roomFile: null, ipHeader: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => argv[++i] ?? usage(`${a} needs a value`)
    if (a === '--port') opts.port = Number(value())
    else if (a === '--host') opts.host = value()
    else if (a === '--collab-port') opts.collabPort = Number(value())
    else if (a === '--db') opts.db = value()
    else if (a === '--room-file') opts.roomFile = value()
    else if (a === '--client-ip-header') opts.ipHeader = value().toLowerCase()
    else usage(`unknown option ${a}`)
  }
  for (const k of ['port', 'collabPort']) if (!Number.isInteger(opts[k]) || opts[k] < 1 || opts[k] > 65535) usage(`--${k === 'port' ? 'port' : 'collab-port'} must be 1-65535`)
  return opts
}

/** The collab server on loopback, restricted to `rooms` when given; resolves once it listens. */
function startCollab(opts, rooms) {
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(opts.collabPort), DB_PATH: resolve(opts.db), ...(rooms.length ? { ONLY_ROOMS: rooms.join(',') } : {}) }
  const child = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolveUp, reject) => {
    child.on('exit', (code) => reject(new Error(`the collab server exited (${code})`)))
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      if (String(chunk).includes('listening on')) resolveUp(child)
    })
  })
}

/** the visitor's address, for the collab server's per-address caps (see the header comment) */
function visitor(req, opts) {
  const named = opts.ipHeader ? req.headers[opts.ipHeader] : undefined
  return typeof named === 'string' && named.length > 0 ? named.split(',')[0].trim() : (req.socket.remoteAddress ?? 'unknown')
}

/** the request's head as the collab server is to receive it: its path without /collab, its visitor named */
function forwardedHeaders(req, opts) {
  const headers = { ...req.headers, 'x-forwarded-for': visitor(req, opts) }
  delete headers['x-forwarded-host']
  return headers
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('✗ dist/ is not built: npm run build')
    process.exit(1)
  }
  const rooms = opts.roomFile ? [docNameOf(roomSecret(opts.roomFile))] : []
  const collab = await startCollab(opts, rooms)
  const { pagesHost } = createRequire(import.meta.url)('../apps/desktop/pagesHost.cjs')
  const site = pagesHost(DIST)

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`)) {
      // the collab server's HTTP side: its health and its assets
      const up = httpRequest({ host: '127.0.0.1', port: opts.collabPort, method: req.method, path: (url.pathname.slice(PREFIX.length) || '/') + url.search, headers: forwardedHeaders(req, opts) }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      })
      up.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end('the collab server does not answer')
      })
      req.pipe(up)
      return
    }
    const path = decodeURIComponent(url.pathname)
    const { status, headers, file, location } = site.respond(path)
    if (location || !file) {
      res.writeHead(location ? status : 404, location ? headers : { 'Content-Type': 'text/plain' })
      res.end(location ? undefined : 'not found')
      return
    }
    const body = readFileSync(file)
    res.writeHead(status, { ...headers, 'Content-Length': body.length })
    res.end(body)
  })

  // the WebSocket the view link names: its upgrade handed to the collab server as it came, but for its path
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return socket.destroy()
    const upstream = connect(opts.collabPort, '127.0.0.1', () => {
      const path = (url.pathname.slice(PREFIX.length) || '/') + url.search
      const lines = [`${req.method} ${path} HTTP/1.1`]
      for (const [k, v] of Object.entries(forwardedHeaders(req, opts))) for (const one of [v].flat()) lines.push(`${k}: ${one}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const drop = () => {
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', drop)
    socket.on('error', drop)
  })

  server.listen(opts.port, opts.host, () => {
    console.log(`plant view on http://${opts.host}:${opts.port}/app/ · collab at ${PREFIX}${rooms.length ? ` · hosting room ${rooms[0]} only` : ''}`)
  })
  const stop = () => {
    server.close()
    collab.kill('SIGTERM')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e) => {
  console.error(`✗ ${e?.stack ?? e}`)
  process.exit(1)
})
